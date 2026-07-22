import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startServer, stopServer, getPort } from "./helpers";

let browser: Browser;
const contexts: BrowserContext[] = [];
const roomPasswords = new Map<string, string>();
const pageDiagnostics = new WeakMap<Page, string[]>();

interface SecureRoomRecoveryFixture {
  mode: "setup" | "join";
  roomId: string;
  displayName: string;
  roomInstance: string;
}

interface PendingFortPassFixture {
  code: string;
  sessionId: string;
  claimSecret: string;
}

beforeAll(async () => {
  await startServer();
  browser = await chromium.launch();
});

afterEach(async () => {
  for (const ctx of contexts) {
    try { await ctx.close(); } catch {}
  }
  contexts.length = 0;
});

afterAll(async () => {
  await browser?.close();
  await stopServer();
});

// --- helpers ---

async function mobilePage(
  recovery?: SecureRoomRecoveryFixture,
  pendingFortPass?: PendingFortPassFixture,
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 667 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  if (recovery || pendingFortPass) {
    await ctx.addInitScript(({ recovery, pendingFortPass }) => {
      localStorage.setItem("pillowfort-name", "changed-in-another-tab");
      if (recovery) {
        sessionStorage.setItem("pillowfort:secure-room-recovery:v1", JSON.stringify({
          v: 1,
          ...recovery,
          savedAt: Date.now(),
        }));
      }
      if (pendingFortPass) {
        sessionStorage.setItem(
          `pillowfort:fort-pass-claim:v1:${pendingFortPass.sessionId}`,
          pendingFortPass.claimSecret,
        );
        sessionStorage.setItem("pillowfort:fort-pass-pending-redemption:v1", JSON.stringify({
          code: pendingFortPass.code,
          sessionId: pendingFortPass.sessionId,
        }));
      }
    }, { recovery, pendingFortPass });
  }
  contexts.push(ctx);
  const page = await ctx.newPage();
  const diagnostics: string[] = [];
  pageDiagnostics.set(page, diagnostics);
  const diagnose = (message: string) => diagnostics.push(`${Date.now()} ${message}`);
  page.on("pageerror", (error) => diagnose(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnose(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framereceived", (event) => {
      if (typeof event.payload !== "string") return;
      try {
        const frame = JSON.parse(event.payload) as { type?: unknown; code?: unknown; reason?: unknown };
        diagnose(`received: ${String(frame.type)} ${String(frame.code ?? "")} ${String(frame.reason ?? "")}`.trim());
      } catch {}
    });
    socket.on("framesent", (event) => {
      if (typeof event.payload !== "string") return;
      try {
        const frame = JSON.parse(event.payload) as { kind?: unknown; relayKind?: unknown };
        diagnose(`sent: ${String(frame.kind)} ${String(frame.relayKind ?? "")}`.trim());
      } catch {}
    });
    socket.on("close", () => diagnose("websocket closed"));
  });
  await page.goto(`http://localhost:${getPort()}/`);
  return page;
}

async function createFort(page: Page, name: string, customPassword?: string): Promise<string> {
  await page.fill("#name-input", name);
  await page.click("#btn-setup");
  if (customPassword !== undefined) {
    await page.click("#btn-custom-secret");
    await page.fill("#setup-password", customPassword);
  } else {
    await page.check("#setup-secret-saved");
  }
  const password = await page.inputValue("#setup-password");
  await page.click("#btn-create");
  await page.waitForSelector("#room-code");
  // room-code text gets set asynchronously after ws response
  await page.waitForFunction(() => {
    const el = document.getElementById("room-code");
    return el && el.textContent && el.textContent.length >= 8;
  });
  const roomCode = await page.locator("#room-code").innerText();
  roomPasswords.set(roomCode, password);
  return roomCode;
}

async function joinFort(host: Page, page: Page, code: string, name: string): Promise<void> {
  await page.fill("#name-input", name);
  await page.click("#btn-join");
  await page.fill("#join-room", code);
  const password = roomPasswords.get(code);
  if (!password) throw new Error(`missing test room secret for ${code}`);
  await page.fill("#join-password", password);
  await page.click("#btn-enter");
  await page.waitForFunction(() => document.body.textContent?.includes("Waiting for the host to approve this device."), undefined, { timeout: 30_000 });
  await host.waitForSelector("#admission-approval-overlay", { timeout: 30_000 });
  await host.click("#btn-approve-admission");
  await page.waitForSelector("#messages", { timeout: 30_000 });
  await host.waitForSelector("#admission-approval-overlay", { state: "detached", timeout: 30_000 });
}

async function pickMember(page: Page, name: string): Promise<void> {
  await page.waitForSelector("#member-picker-overlay.open");
  const item = page.locator(".member-picker-item", { hasText: name });
  await item.click();
}

// --- tests ---

describe("Mobile E2E", () => {
  it("requires generated secrets to be saved and exposes the selected password mode", async () => {
    const page = await mobilePage();
    await page.fill("#name-input", "careful-host");
    await page.click("#btn-setup");

    const controls = page.getByRole("group", { name: "Room password controls" });
    expect(await controls.count()).toBe(1);
    expect(await page.locator("#btn-custom-secret").getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator("#btn-regenerate-secret").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#btn-create").isDisabled()).toBe(true);

    await page.click("#btn-copy-secret");
    await page.waitForFunction(() =>
      (document.getElementById("setup-secret-saved") as HTMLInputElement | null)?.checked === true,
    );
    expect(await page.locator("#btn-create").isEnabled()).toBe(true);

    await page.click("#btn-regenerate-secret");
    expect(await page.locator("#setup-secret-saved").isChecked()).toBe(false);
    expect(await page.locator("#btn-create").isDisabled()).toBe(true);

    await page.click("#btn-custom-secret");
    expect(await page.locator("#btn-custom-secret").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#btn-regenerate-secret").getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator("#setup-secret-saved").count()).toBe(0);
  });

  it("hydrates only the exact recovered setup's pending Fort Pass claim", async () => {
    const recovery = {
      mode: "setup" as const,
      roomId: "party-1",
      displayName: "recovered-host",
      roomInstance: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    const matchingClaim = {
      code: recovery.roomId,
      sessionId: "cs_test_recovery_match",
      claimSecret: "a".repeat(64),
    };
    const matching = await mobilePage(recovery, matchingClaim);
    await matching.waitForSelector("#setup-password");
    expect(await matching.locator(".fort-pass-redeemed-code").innerText()).toBe("flag: party-1");

    const unrelatedClaim = {
      code: "other-1",
      sessionId: "cs_test_recovery_other",
      claimSecret: "b".repeat(64),
    };
    const mismatched = await mobilePage(recovery, unrelatedClaim);
    await mismatched.waitForSelector("#setup-password");
    expect(await mismatched.locator(".fort-pass-redeemed-code").count()).toBe(0);
    expect(await mismatched.evaluate((claim) => ({
      pending: sessionStorage.getItem("pillowfort:fort-pass-pending-redemption:v1"),
      secret: sessionStorage.getItem(`pillowfort:fort-pass-claim:v1:${claim.sessionId}`),
    }), unrelatedClaim)).toEqual({
      pending: JSON.stringify({ code: unrelatedClaim.code, sessionId: unrelatedClaim.sessionId }),
      secret: unrelatedClaim.claimSecret,
    });
  });

  it("unlocks a pre-send recovery credential miss and accepts the correction without reloading", async () => {
    const page = await mobilePage();
    await page.fill("#name-input", "recovery-host");
    await page.click("#btn-setup");
    await page.click("#btn-custom-secret");
    const correctSecret = "violet lantern meadow";
    await page.fill("#setup-password", correctSecret);

    // Produce a real durable ambiguous founder without letting the relay see
    // the authentication frame. Reload then exercises the normal UI/controller
    // recovery path against that exact IndexedDB record.
    await page.evaluate(() => {
      (window as any).__ambiguousSetupAuthSent = false;
      (window as any).WebSocket = class ChallengeOnlyWebSocket {
        static OPEN = 1;
        readyState = 1;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor() {
          window.setTimeout(() => this.onmessage?.({
            data: JSON.stringify({
              kind: "secure-auth-challenge",
              v: 4,
              suite: 1,
              connectionId: "AAAAAAAAAAAAAAAAAAAAAA",
              challenge: "A".repeat(43),
              roomInstance: null,
            }),
          } as MessageEvent), 0);
        }

        send(wire: string) {
          const frame = JSON.parse(wire) as { kind?: unknown };
          if (frame.kind === "secure-authenticate") {
            (window as any).__ambiguousSetupAuthSent = true;
          }
        }

        close() {}
      };
    });
    await page.click("#btn-create");
    await page.waitForFunction(() => (window as any).__ambiguousSetupAuthSent === true, undefined, {
      timeout: 30_000,
    });
    expect(await page.evaluate(() => {
      const raw = sessionStorage.getItem("pillowfort:secure-room-recovery:v1");
      return raw ? JSON.parse(raw).mode : null;
    })).toBe("setup");

    await page.reload();
    await page.waitForSelector("#setup-password");
    const wrongSecret = "wrong lantern meadow";
    await page.fill("#setup-password", wrongSecret);
    await page.click("#btn-create");
    await page.waitForFunction(() =>
      document.getElementById("setup-secret-error")?.textContent?.includes("No saved setup matched"),
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator("#setup-password").isEnabled()).toBe(true);
    expect(await page.inputValue("#setup-password")).toBe(wrongSecret);

    await page.fill("#setup-password", correctSecret);
    await page.click("#btn-create");
    await page.waitForSelector("#room-code", { timeout: 30_000 });
    expect(await page.locator("#room-code").innerText()).toMatch(/^f-[a-z2-7]{10}$/u);
  });

  it("routes exact same-tab recovery and locks its credential only after submit", async () => {
    const setup = await mobilePage({
      mode: "setup",
      roomId: "f-abcdefghij",
      displayName: "recovered-host",
      roomInstance: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    await setup.waitForSelector("#setup-password");
    expect(await setup.locator("#name-input").count()).toBe(0);
    expect(await setup.locator("#setup-password").isEnabled()).toBe(true);
    expect(await setup.inputValue("#setup-password")).toBe("");
    expect(await setup.evaluate(() => localStorage.getItem("pillowfort-name"))).toBe("recovered-host");

    const join = await mobilePage({
      mode: "join",
      roomId: "f-jihgfedcba",
      displayName: "recovered-guest",
      roomInstance: "BBBBBBBBBBBBBBBBBBBBBA",
    });
    await join.waitForSelector("#join-password");
    expect(await join.inputValue("#join-name")).toBe("recovered-guest");
    expect(await join.inputValue("#join-room")).toBe("f-jihgfedcba");
    expect(await join.locator("#join-name").isDisabled()).toBe(true);
    expect(await join.locator("#join-room").isDisabled()).toBe(true);
    expect(await join.locator("#join-password").isEnabled()).toBe(true);

    // Keep the authentication pending so Cancel exercises the recovery guard
    // after the first credential has been submitted.
    await join.evaluate(() => {
      (window as any).WebSocket = class HangingWebSocket {
        static OPEN = 1;
        readyState = 0;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        close() {}
      };
    });
    await join.fill("#join-password", "lantern meadow orbit");
    await join.click("#btn-enter");
    await join.getByRole("button", { name: "Cancel" }).click();
    await join.waitForFunction(() =>
      document.getElementById("btn-enter")?.textContent?.includes("Join Fort") &&
      (document.getElementById("join-password") as HTMLInputElement | null)?.disabled === true,
    );
    expect(await join.locator("#join-password").isDisabled()).toBe(true);
    expect(await join.inputValue("#join-name")).toBe("recovered-guest");
    expect(await join.inputValue("#join-room")).toBe("f-jihgfedcba");
  });

  it("creates, shares, and joins with a custom room password", async () => {
    const customPassword = "bob lantern blanket orbit";
    const host = await mobilePage();
    const code = await createFort(host, "alice", customPassword);

    await host.getByTitle("Copy Invite").click();
    const copiedInvite = await host.evaluate(() => navigator.clipboard.readText());
    expect(copiedInvite).toContain(`password: ${customPassword}`);
    expect(copiedInvite).not.toContain("password: pf2_");

    const wrongGuest = await mobilePage();
    await wrongGuest.fill("#name-input", "mallory");
    await wrongGuest.click("#btn-join");
    await wrongGuest.fill("#join-room", code);
    await wrongGuest.fill("#join-password", "wrong blanket orbit");
    await wrongGuest.click("#btn-enter");
    await wrongGuest.waitForSelector("#join-secret-error", { timeout: 30_000 });
    expect(await wrongGuest.locator("#join-secret-error").innerText()).toContain("Could not join");
    expect(await host.locator("#admission-approval-overlay").count()).toBe(0);
    await wrongGuest.getByRole("button", { name: "Cancel" }).click();
    await wrongGuest.waitForSelector("#name-input", { timeout: 30_000 });

    await joinFort(host, wrongGuest, code, "bob");
    await wrongGuest.fill("#msg-input", "custom password works");
    await wrongGuest.click("#btn-send");
    await host.waitForFunction(
      (text) => document.getElementById("messages")?.textContent?.includes(text),
      "custom password works",
      { timeout: 15_000 },
    );
  });

  it("game shortcuts visible and tappable", async () => {
    const page = await mobilePage();
    await createFort(page, "alice");

    const ids = ["#aim-btn-vote", "#aim-btn-rps", "#aim-btn-ttt", "#aim-btn-sab", "#aim-btn-koth"];
    for (const id of ids) {
      expect(await page.locator(id).isVisible()).toBe(true);
      const box = await page.locator(id).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(30);
    }
  });

  it("RPS full flow on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    // wait for alice to see bob in member list
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    // Alice challenges Bob to RPS
    await alice.click("#aim-btn-rps");
    await pickMember(alice, "bob");

    // Bob sees challenge overlay and accepts
    await bob.waitForSelector("#rps-overlay.open");
    await bob.click("#rps-actions .xp-btn-primary", { force: true }); // countdown rerenders the overlay

    // Both see pick buttons
    await alice.waitForSelector(".rps-pick");
    await bob.waitForSelector(".rps-pick");

    // Alice picks rock, Bob picks scissors
    await alice.locator(".rps-pick").first().click(); // rock is first
    await bob.locator(".rps-pick").last().click(); // scissors is last

    // Both see result
    await alice.waitForSelector("#rps-result-text:not([style*='display: none'])", { timeout: 5000 });
    await bob.waitForSelector("#rps-result-text:not([style*='display: none'])", { timeout: 5000 });

    const resultText = await alice.locator("#rps-result-text").innerText();
    expect(resultText).toContain("wins");

    // Close via OK button
    await alice.click("#rps-actions .xp-btn");
    await bob.click("#rps-actions .xp-btn");
  });

  it("TTT full flow on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    // Alice challenges Bob to TTT
    await alice.click("#aim-btn-ttt");
    await pickMember(alice, "bob");

    // Bob accepts
    await bob.waitForSelector("#ttt-overlay.open");
    await bob.click("#ttt-actions .xp-btn-primary", { force: true });

    // Wait for board to render
    await alice.waitForSelector(".ttt-cell");
    await bob.waitForSelector(".ttt-cell");

    // Alice = X (goes first). Play: X wins top row (cells 0,1,2), O plays 3,4
    // Move 1: Alice plays cell 0
    await alice.locator(".ttt-cell").nth(0).click();
    await bob.waitForFunction(() => document.querySelectorAll(".ttt-cell.x").length === 1);

    // Move 2: Bob plays cell 3
    await bob.locator(".ttt-cell").nth(3).click();
    await alice.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 1);

    // Move 3: Alice plays cell 1
    await alice.locator(".ttt-cell").nth(1).click();
    await bob.waitForFunction(() => document.querySelectorAll(".ttt-cell.x").length === 2);

    // Move 4: Bob plays cell 4
    await bob.locator(".ttt-cell").nth(4).click();
    await alice.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 2);

    // Move 5: Alice plays cell 2 → X wins top row
    await alice.locator(".ttt-cell").nth(2).click();

    // Verify winner shown
    await alice.waitForFunction(() => {
      const el = document.getElementById("ttt-status");
      return el && el.textContent && (el.textContent.includes("win") || el.textContent.includes("wins"));
    }, undefined, { timeout: 5000 });

    const status = await alice.locator("#ttt-status").innerText();
    expect(status.toLowerCase()).toContain("win");
  });

  it("vote banner on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    const carol = await mobilePage();
    await joinFort(alice, carol, code, "carol");

    // Wait for alice to see 3 members
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("3");
    });

    // Alice starts vote to kick Bob
    await alice.click("#aim-btn-vote");
    await pickMember(alice, "bob");

    // Carol sees vote banner
    await carol.waitForSelector("#vote-banner.visible", { timeout: 5000 });

    // Carol votes yes
    await carol.click("#vote-yes", { force: true });

    // Vote resolves — banner disappears on alice's screen
    try {
      await alice.waitForFunction(() => {
        const el = document.getElementById("vote-banner");
        return !el || !el.classList.contains("visible");
      }, undefined, { timeout: 15_000 });
    } catch (error) {
      const diagnostics = await Promise.all([
        ["alice", alice], ["bob", bob], ["carol", carol],
      ].map(async ([name, participant]) => {
        const participantPage = participant as Page;
        const body = await participantPage.locator("body").innerText().catch(() => "<page unavailable>");
        const trace = pageDiagnostics.get(participantPage)?.slice(-30).join("\n") || "<no browser diagnostics>";
        return `${name}:\n${body.slice(0, 1000)}\n${trace}`;
      }));
      throw new Error(`mobile vote did not resolve\n${diagnostics.join("\n---\n")}`, { cause: error });
    }
  });

  it("member picker touch targets", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    // Open member picker via RPS
    await alice.click("#aim-btn-rps");
    await alice.waitForSelector("#member-picker-overlay.open");

    // Check touch targets
    const items = alice.locator(".member-picker-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await items.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }
  });

  it("breakout starts on mobile", async () => {
    const page = await mobilePage();
    await createFort(page, "alice");

    // Minimize chat to start breakout
    await page.click("#chat-btn-min");
    await page.waitForSelector("#breakout-canvas", { state: "visible" });

    const canvas = page.locator("#breakout-canvas");
    await page.waitForFunction(() => {
      const canvas = document.getElementById("breakout-canvas") as HTMLCanvasElement | null;
      return !!canvas && canvas.width > 300;
    });
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    // Canvas should fill most of the 375px viewport width
    expect(box!.width).toBeGreaterThanOrEqual(300);
    const initialWidth = await canvas.evaluate((element) => (element as HTMLCanvasElement).width);

    // Restoring and minimizing again creates a new canvas element. It must be
    // initialized to the viewport instead of retaining the browser default size.
    await page.click("#chat-btn-min");
    await page.waitForSelector("#breakout-canvas", { state: "detached" });
    await page.click("#chat-btn-min");
    await page.waitForSelector("#breakout-canvas", { state: "visible" });
    await page.waitForFunction(() => {
      const canvas = document.getElementById("breakout-canvas") as HTMLCanvasElement | null;
      return !!canvas && canvas.width > 300;
    });
    const resumedWidth = await page.locator("#breakout-canvas").evaluate((element) => (element as HTMLCanvasElement).width);
    expect(resumedWidth).toBe(initialWidth);
    expect(resumedWidth).toBeGreaterThan(300);
  });

  it("RPS picks are properly sized on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    await alice.click("#aim-btn-rps");
    await pickMember(alice, "bob");

    await bob.waitForSelector("#rps-overlay.open");
    await bob.click("#rps-actions .xp-btn-primary", { force: true });

    // Wait for picks to render
    await alice.waitForSelector(".rps-pick");

    const picks = alice.locator(".rps-pick");
    const count = await picks.count();
    expect(count).toBe(3);
    for (let i = 0; i < count; i++) {
      const box = await picks.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThanOrEqual(65);
      expect(box!.height).toBeGreaterThanOrEqual(65);
    }
  });

  it("TTT cells are properly sized on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    await alice.click("#aim-btn-ttt");
    await pickMember(alice, "bob");

    await bob.waitForSelector("#ttt-overlay.open");
    await bob.click("#ttt-actions .xp-btn-primary", { force: true });

    // Wait for board to render
    await alice.waitForSelector(".ttt-cell");

    const cells = alice.locator(".ttt-cell");
    const count = await cells.count();
    expect(count).toBe(9);
    for (let i = 0; i < count; i++) {
      const box = await cells.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThanOrEqual(64);
      expect(box!.height).toBeGreaterThanOrEqual(64);
    }
  });
});
