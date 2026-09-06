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
    await page.click("#password-options > summary");
    await page.click("#btn-custom-secret");
    await page.fill("#setup-password", customPassword);
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
  it("explains why a screen name is required before either route", async () => {
    const page = await mobilePage();

    await page.click("#btn-setup");

    expect(await page.locator("#name-input").getAttribute("aria-invalid")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("name-input");
    expect(await page.locator("#setup-password").count()).toBe(0);

    await page.fill("#name-input", "luna");
    expect(await page.getByRole("alert").count()).toBe(0);
    await page.click("#btn-join");
    await page.waitForSelector("#join-room");
  });
  it("keeps authentication and chat usable in phone landscape", async () => {
    const page = await mobilePage();
    await page.setViewportSize({ width: 812, height: 375 });

    const fitsViewport = async (selector: string) => page.locator(selector).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0
        && rect.top >= 0
        && rect.right <= window.innerWidth
        && rect.bottom <= window.innerHeight
        && document.documentElement.scrollWidth <= window.innerWidth;
    });

    expect(await fitsViewport(".entry-card")).toBe(true);
    expect(await page.locator("#name-input").evaluate((input) => Number.parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);

    await page.fill("#name-input", "landscape-host");
    await page.click("#btn-setup");
    await page.waitForSelector("#setup-password");
    expect(await fitsViewport(".entry-card")).toBe(true);
    expect(await page.locator("#setup-password").evaluate((input) => Number.parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);

    await page.click("#btn-create");
    await page.waitForSelector("#room-code");
    expect(await fitsViewport(".room-shell")).toBe(true);
    expect(await page.locator("#btn-people").isVisible()).toBe(true);
    expect(await page.locator(".format-toolbar").isVisible()).toBe(true);
    expect(await fitsViewport(".format-toolbar")).toBe(true);
    await page.click("#fmt-bold");
    await page.fill("#msg-input", "landscape formatting works");
    await page.press("#msg-input", "Enter");
    await page.locator("#messages .chat-message", { hasText: "landscape formatting works" }).waitFor();
    expect(await page.locator("#messages .chat-message", { hasText: "landscape formatting works" }).locator("b").textContent()).toBe("landscape formatting works");
    expect(await page.locator("#messages").evaluate((messages) => messages.getBoundingClientRect().height)).toBeGreaterThanOrEqual(80);
    expect(await page.locator("#msg-input").evaluate((input) => Number.parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
  });

  it("keeps the composer and People usable when the phone keyboard shrinks only the visual viewport", async () => {
    const page = await mobilePage();
    await createFort(page, "keyboard-host");
    const draft = "keep the first line\nand the second line";
    await page.fill("#msg-input", draft);
    const roster = page.locator("#room-roster .roster-mobile");
    expect(await roster.isVisible()).toBe(true);
    const originalHeight = await page.evaluateHandle(() => {
      if (!window.visualViewport) throw new Error("Visual viewport is unavailable");
      return Object.getOwnPropertyDescriptor(window.visualViewport, "height");
    });

    try {
      // A software keyboard need not change the layout viewport or media
      // queries. Override only the visual height and notify the real listener.
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", { configurable: true, value: 320 });
        viewport.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(() => {
        const messages = document.getElementById("messages")?.getBoundingClientRect();
        const input = document.getElementById("msg-input")?.getBoundingClientRect();
        const send = document.getElementById("btn-send")?.getBoundingClientRect();
        return !!messages && !!input && !!send &&
          messages.height >= 80 && input.bottom <= 320 && send.bottom <= 320;
      });
      expect(await page.locator("#messages").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(80);
      for (const selector of ["#msg-input", "#btn-send", ".format-toolbar", "#btn-people"]) {
        const control = page.locator(selector);
        expect(await control.isVisible()).toBe(true);
        expect(await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= 320 &&
            rect.left >= 0 && rect.right <= window.innerWidth;
        })).toBe(true);
      }
      for (const selector of ["#fmt-bold", "#btn-send", "#btn-people"]) {
        expect(await page.locator(selector).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await page.click("#fmt-bold");
      expect(await page.locator("#fmt-bold").getAttribute("aria-pressed")).toBe("true");
      await page.click("#btn-people");
      const people = page.locator(".people-dialog");
      await people.waitFor({ state: "visible" });
      expect(await people.getByRole("tabpanel", { name: "People", exact: true }).getByText("keyboard-host", { exact: true }).isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await people.waitFor({ state: "hidden" });
      expect(await page.inputValue("#msg-input")).toBe(draft);
    } finally {
      await page.evaluate((descriptor) => {
        const viewport = window.visualViewport!;
        if (descriptor) Object.defineProperty(viewport, "height", descriptor);
        else Reflect.deleteProperty(viewport, "height");
        viewport.dispatchEvent(new Event("resize"));
      }, originalHeight);
      await originalHeight.dispose();
    }

    await roster.waitFor({ state: "visible" });
    expect(await page.inputValue("#msg-input")).toBe(draft);
  });

  it("keeps multiline and composing drafts local until Enter sends exactly once to another browser", async () => {
    const sender = await mobilePage();
    const code = await createFort(sender, "writer");
    const recipient = await mobilePage();
    await joinFort(sender, recipient, code, "reader");
    const draft = sender.locator("#msg-input");
    const sentMessages = sender.locator("#messages .chat-content");
    const receivedMessages = recipient.locator("#messages .chat-content");

    await draft.fill("first line");
    await draft.press("Shift+Enter");
    expect(await draft.inputValue()).toBe("first line\n");
    expect(await sentMessages.count()).toBe(0);
    expect(await receivedMessages.count()).toBe(0);

    // Playwright cannot drive the OS IME, so deliver its browser composition
    // events to the real composer without replacing the send/crypto path.
    await draft.dispatchEvent("compositionstart", { data: "" });
    await draft.fill("first line\nこんにちは");
    await draft.dispatchEvent("compositionupdate", { data: "こんにちは" });
    await draft.dispatchEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 229, isComposing: true,
    });
    await draft.dispatchEvent("keyup", {
      key: "Enter", code: "Enter", keyCode: 229, isComposing: true,
    });
    await draft.dispatchEvent("compositionend", { data: "こんにちは" });
    const message = "first line\nこんにちは";
    expect(await draft.inputValue()).toBe(message);
    expect(await sentMessages.count()).toBe(0);
    expect(await receivedMessages.count()).toBe(0);

    await draft.press("Enter");
    await recipient.waitForFunction((text) =>
      Array.from(document.querySelectorAll("#messages .chat-content"))
        .some((content) => content.textContent === text),
      message,
    );
    await sender.waitForFunction(() =>
      (document.getElementById("msg-input") as HTMLTextAreaElement | null)?.value === "",
    );
    expect(await draft.inputValue()).toBe("");
    expect(await receivedMessages.allTextContents()).toEqual([message]);
    expect(await receivedMessages.innerText()).toBe(message);

    // A reply traverses the real connection before checking both transcripts:
    // neither Shift+Enter nor the IME commit may have leaked an extra message.
    await recipient.fill("#msg-input", "both lines arrived");
    await recipient.press("#msg-input", "Enter");
    await sender.waitForFunction(() =>
      Array.from(document.querySelectorAll("#messages .chat-content"))
        .some((content) => content.textContent === "both lines arrived"),
    );
    expect(await sentMessages.allTextContents()).toEqual([message, "both lines arrived"]);
    expect(await receivedMessages.allTextContents()).toEqual([message, "both lines arrived"]);
  }, 60_000);


  it("does not create or authenticate when default password copying is denied until manual saving is confirmed", async () => {
    const host = await mobilePage();
    const connections: string[] = [];
    host.on("websocket", (socket) => connections.push(socket.url()));
    await host.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => { throw new DOMException("Clipboard denied", "NotAllowedError"); },
      });
    });
    await host.fill("#name-input", "careful-host");
    await host.click("#btn-setup");
    const password = await host.inputValue("#setup-password");
    await host.click("#btn-create");

    const manualCopy = host.getByRole("dialog", { name: "Copy manually", exact: true });
    await manualCopy.waitFor();
    expect(await manualCopy.getByRole("textbox").inputValue()).toBe(password);
    expect(connections).toEqual([]);
    expect(await host.locator("#room-code").count()).toBe(0);
    await manualCopy.getByRole("button", { name: "Close", exact: true }).click();
    await manualCopy.waitFor({ state: "detached" });
    expect(await host.locator("#btn-create").isDisabled()).toBe(true);
    expect(await host.locator("#setup-secret-saved").isChecked()).toBe(false);
    expect(connections).toEqual([]);

    await host.check("#setup-secret-saved");
    await host.click("#btn-create");
    await host.waitForSelector("#room-code", { timeout: 30_000 });
    const code = await host.locator("#room-code").innerText();
    expect(connections).toHaveLength(1);
    roomPasswords.set(code, password);
    const guest = await mobilePage();
    await joinFort(host, guest, code, "trusted-friend");
    await guest.fill("#msg-input", "the manually saved password works");
    await guest.click("#btn-send");
    await host.waitForFunction(() =>
      document.getElementById("messages")?.textContent?.includes("the manually saved password works"),
    );
  }, 60_000);

  it("serializes rapid create clicks and discards a password copy that finishes after cancellation", async () => {
    const page = await mobilePage();
    const connections: string[] = [];
    page.on("websocket", (socket) => connections.push(socket.url()));
    let copyAttempts = 0;
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const pendingCopy = new Promise<void>((resolve) => { releaseCopy = resolve; });
    const copyStarted = new Promise<void>((resolve) => { markCopyStarted = resolve; });
    await page.exposeFunction("__waitForPasswordCopy", async () => {
      copyAttempts++;
      markCopyStarted();
      await pendingCopy;
    });
    await page.evaluate(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => {
          if (!("__waitForPasswordCopy" in window) || typeof window.__waitForPasswordCopy !== "function") {
            throw new Error("Password copy timing hook is unavailable");
          }
          await window.__waitForPasswordCopy();
          await writeText(text);
        },
      });
    });
    try {
      await page.fill("#name-input", "cancelled-host");
      await page.click("#btn-setup");
      // Dispatch both activation events in one task, before a React render can
      // disable the button. Only the platform clipboard timing is controlled.
      await page.locator("#btn-create").evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await copyStarted;
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForSelector("#name-input");
      expect(copyAttempts).toBe(1);
      expect(connections).toEqual([]);
    } finally {
      releaseCopy();
    }

    // A new setup may proceed while the cancelled clipboard task unwinds.
    // The eventual room must use this setup's password, not the stale one.
    const code = await createFort(page, "next-host");
    expect(copyAttempts).toBe(2);
    expect(connections).toHaveLength(1);
    const guest = await mobilePage();
    await joinFort(page, guest, code, "friend");
    expect(await guest.locator("#room-code").innerText()).toBe(code);
  }, 60_000);

  it("preserves older-message reading position and follows new messages only at the bottom", async () => {
    const reader = await mobilePage();
    const code = await createFort(reader, "reader");
    const friend = await mobilePage();
    await joinFort(reader, friend, code, "storyteller");
    for (let chapter = 1; chapter <= 4; chapter++) {
      const text = `chapter ${chapter}: ${"lantern meadow ".repeat(90)}`.trim();
      await friend.fill("#msg-input", text);
      await friend.click("#btn-send");
      await reader.waitForFunction(
        (text) => document.getElementById("messages")?.textContent?.includes(text),
        text,
      );
    }
    const messages = reader.locator("#messages");
    expect(await messages.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
    await messages.hover();
    await reader.mouse.wheel(0, -10_000);
    await reader.waitForFunction(() => document.getElementById("messages")?.scrollTop === 0);

    await friend.fill("#msg-input", "a new ending arrived while you were reading");
    await friend.click("#btn-send");
    await reader.waitForFunction(() =>
      document.getElementById("messages")?.textContent?.includes("a new ending arrived while you were reading"),
    );
    await reader.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));
    expect(await messages.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);

    await messages.hover();
    await reader.mouse.wheel(0, 100_000);
    await reader.waitForFunction(() => {
      const element = document.getElementById("messages");
      return !!element && element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
    });
    await friend.fill("#msg-input", "one more message at the bottom");
    await friend.click("#btn-send");
    await reader.waitForFunction(() => {
      const element = document.getElementById("messages");
      return !!element?.textContent?.includes("one more message at the bottom") &&
        element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
    });
  }, 60_000);

  it("keeps the original purchase when setup opens before return verification finishes", async () => {
    const purchase = { code: "party-1", sessionId: "cs_test_pending_return", claimSecret: "a".repeat(64) };
    const page = await mobilePage(undefined, purchase);
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    await page.route("**/api/fort-pass/redeem", async (route) => {
      if (first) { first = false; await firstResponse; }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ status: "pending", code: purchase.code }),
      });
    });
    const pendingRequest = page.waitForRequest("**/api/fort-pass/redeem");
    try {
      await page.goto(`http://localhost:${getPort()}/?fort_pass=success&code=${purchase.code}&session_id=${purchase.sessionId}`);
      await pendingRequest;
      await page.click("#btn-setup");
      expect(await page.locator(".fort-pass-redeemed-code").count()).toBe(1);
      expect(await page.locator(".fort-pass-redeemed-code").innerText()).toContain(purchase.code);
      expect(await page.locator("#btn-fort-pass-checkout").count()).toBe(0);
      releaseFirst();
      const retry = page.waitForRequest((request) =>
        request.url().endsWith("/api/fort-pass/redeem")
        && request.postDataJSON().sessionId === purchase.sessionId);
      await page.click("#btn-verify-fort-pass");
      const retriedRequest = await retry;
      const response = await retriedRequest.response();
      await response?.finished();
      expect(await page.locator("#btn-fort-pass-checkout").count()).toBe(0);
    } finally {
      releaseFirst();
    }
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
    expect(await matching.locator(".fort-pass-redeemed-code").innerText()).toContain(recovery.roomId);

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
    await page.click("#password-options > summary");
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
    const recoveryPassword = page.locator("#setup-password");
    await recoveryPassword.and(page.locator('[aria-invalid="true"]')).waitFor({ timeout: 30_000 });
    expect(await recoveryPassword.evaluate((field) =>
      (field.getAttribute("aria-describedby") ?? "").split(/\s+/).some((id) =>
        document.getElementById(id)?.getAttribute("role") === "alert"),
    )).toBe(true);
    expect(await recoveryPassword.isEnabled()).toBe(true);
    expect(await recoveryPassword.inputValue()).toBe(wrongSecret);

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
    await join.getByRole("button", { name: "Back", exact: true }).click();
    await join.waitForFunction(() =>
      (document.getElementById("btn-enter") as HTMLButtonElement | null)?.disabled === false &&
      (document.getElementById("join-password") as HTMLInputElement | null)?.disabled === true,
    );
    expect(await join.locator("#join-password").isDisabled()).toBe(true);
    expect(await join.inputValue("#join-name")).toBe("recovered-guest");
    expect(await join.inputValue("#join-room")).toBe("f-jihgfedcba");
  });

  it("creates, shares, and joins with a custom room password", async () => {
    const customPassword = "orchid";
    const host = await mobilePage();
    const code = await createFort(host, "alice", customPassword);

    await host.click("#btn-invite");
    await host.click("#btn-copy-invite");
    const copiedInvite = await host.evaluate(() => navigator.clipboard.readText());
    const parsedInvite = new URL(copiedInvite);
    expect(parsedInvite.origin).toBe(new URL(host.url()).origin);
    expect(parsedInvite.pathname).toBe(`/${code}`);
    expect(parsedInvite.search).toBe("");
    expect(new URLSearchParams(parsedInvite.hash.slice(1)).get("invite")).toBe(customPassword);
    await host.click("#btn-close-invite");

    const wrongGuest = await mobilePage();
    await wrongGuest.fill("#name-input", "mallory");
    await wrongGuest.click("#btn-join");
    await wrongGuest.fill("#join-room", code);
    await wrongGuest.fill("#join-password", "wrong blanket orbit");
    await wrongGuest.click("#btn-enter");
    const rejectedPassword = wrongGuest.locator("#join-password");
    await rejectedPassword.and(wrongGuest.locator('[aria-invalid="true"]')).waitFor({ timeout: 30_000 });
    expect(await rejectedPassword.evaluate((field) =>
      (field.getAttribute("aria-describedby") ?? "").split(/\s+/).some((id) =>
        document.getElementById(id)?.getAttribute("role") === "alert"),
    )).toBe(true);
    expect(await host.locator("#admission-approval-overlay").count()).toBe(0);
    await wrongGuest.getByRole("button", { name: "Back", exact: true }).click();
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

  it("scrubs a one-link invitation and waits for explicit join and matching host approval", async () => {
    const host = await mobilePage();
    const code = await createFort(host, "link-host");
    await host.click("#btn-invite");
    await host.click("#btn-copy-invite");
    const invitationUrl = await host.evaluate(() => navigator.clipboard.readText());
    expect(new URL(await host.inputValue("#invite-link")).hash).toBe("");
    await host.click("#btn-close-invite");

    const guest = await mobilePage();
    let socketCount = 0;
    let joinRequests = 0;
    guest.on("websocket", (socket) => {
      socketCount += 1;
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        const frame = JSON.parse(payload) as { kind?: string; mode?: string };
        if (frame.kind === "secure-authenticate" && frame.mode === "join") joinRequests += 1;
      });
    });
    await guest.goto(invitationUrl);
    await guest.waitForSelector("#join-name");
    expect(new URL(guest.url()).hash).toBe("");
    expect(await guest.locator("#join-password").isVisible()).toBe(false);
    expect(await guest.locator("#join-password").getAttribute("type")).toBe("password");
    await guest.fill("#join-name", "link-guest");
    expect(socketCount).toBe(0);
    expect(joinRequests).toBe(0);
    expect(await host.locator("#admission-approval-overlay").count()).toBe(0);

    // Two activations before React renders must still produce only one request.
    await guest.locator("#btn-enter").evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await host.waitForSelector("#admission-approval-overlay", { timeout: 30_000 });
    const fingerprint = await guest.locator(".auth-note code").innerText();
    expect(await host.locator("#admission-approval-overlay").innerText()).toContain(fingerprint);
    expect(joinRequests).toBe(1);
    expect(await guest.locator("#messages").count()).toBe(0);
    await host.click("#btn-approve-admission");
    await guest.waitForSelector("#messages", { timeout: 30_000 });
    expect(await guest.locator("#room-code").innerText()).toBe(code);
    await guest.fill("#msg-input", "one link, approved device");
    await guest.click("#btn-send");
    await host.waitForFunction(
      (text) => document.getElementById("messages")?.textContent?.includes(text),
      "one link, approved device",
      { timeout: 15_000 },
    );
  }, 60_000);

  it("discovers games by player availability and returns to the draft on cancel", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    await alice.fill("#msg-input", "saving this for later");
    await alice.click("#btn-open-games");
    await alice.waitForSelector("#game-picker-dialog[open]");

    for (const id of ["#aim-btn-vote", "#aim-btn-rps", "#aim-btn-ttt", "#aim-btn-sab", "#aim-btn-koth"]) {
      const choice = alice.locator(id);
      expect(await choice.isVisible()).toBe(true);
      expect(await choice.isDisabled()).toBe(true);
      expect(await choice.locator(".game-choice-name").isVisible()).toBe(true);
      expect(await choice.locator(".game-choice-hint").isVisible()).toBe(true);
      const box = await choice.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    await alice.keyboard.press("Escape");
    await alice.waitForSelector("#game-picker-dialog[open]", { state: "hidden" });
    expect(await alice.evaluate(() => document.activeElement?.id)).toBe("btn-open-games");
    expect(await alice.inputValue("#msg-input")).toBe("saving this for later");

    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    await alice.waitForFunction(() => Number.parseInt(document.getElementById("member-count")?.textContent ?? "", 10) === 2);
    await alice.click("#btn-open-games");
    expect(await alice.locator("#aim-btn-rps").isEnabled()).toBe(true);
    expect(await alice.locator("#aim-btn-ttt").isEnabled()).toBe(true);
    expect(await alice.locator("#aim-btn-vote").isDisabled()).toBe(true);
    expect(await alice.locator("#aim-btn-sab").isDisabled()).toBe(true);
    expect(await alice.locator("#aim-btn-koth").isDisabled()).toBe(true);
    await alice.locator("#aim-btn-rps").focus();
    await alice.keyboard.press("Enter");
    await alice.waitForSelector("#member-picker-overlay.open");
    expect(await alice.locator("button.member-picker-item:focus", { hasText: "bob" }).isVisible()).toBe(true);
    expect(await alice.locator("#game-picker-dialog").isVisible()).toBe(false);
    await alice.keyboard.press("Escape");
    await alice.waitForSelector("#member-picker-overlay.open", { state: "hidden" });
    expect(await alice.evaluate(() => document.activeElement?.id)).toBe("btn-open-games");
    expect(await alice.inputValue("#msg-input")).toBe("saving this for later");

    await bob.click("#btn-open-games");
    expect(await bob.locator("#aim-btn-koth").isEnabled()).toBe(true);
    await bob.click("#btn-close-games");

    const carol = await mobilePage();
    await joinFort(alice, carol, code, "carol");
    await alice.waitForFunction(() => Number.parseInt(document.getElementById("member-count")?.textContent ?? "", 10) === 3);
    await alice.click("#btn-open-games");
    expect(await alice.locator("#aim-btn-vote").isEnabled()).toBe(true);
    expect(await alice.locator("#aim-btn-sab").isDisabled()).toBe(true);
    await alice.click("#btn-close-games");

    const dave = await mobilePage();
    await joinFort(alice, dave, code, "dave");
    await alice.waitForFunction(() => Number.parseInt(document.getElementById("member-count")?.textContent ?? "", 10) === 4);
    await alice.click("#btn-open-games");
    expect(await alice.locator("#aim-btn-sab").isEnabled()).toBe(true);
    await alice.click("#btn-close-games");
    await alice.click("#btn-send");
    await bob.waitForFunction(() =>
      document.getElementById("messages")?.textContent?.includes("saving this for later"),
    );

    await alice.locator("#btn-open-games").focus();
    await alice.keyboard.press("Enter");
    await alice.locator("#aim-btn-rps").focus();
    await alice.keyboard.press("Enter");
    await alice.waitForSelector("#member-picker-overlay.open");
    await alice.locator("button.member-picker-item", { hasText: "bob" }).focus();
    await alice.keyboard.press("Enter");
    await alice.waitForSelector("#member-picker-overlay.open", { state: "hidden" });
    await bob.waitForSelector("#rps-overlay.open");
  });

  it("cancels an accidental guest exit without losing the room or draft", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(alice, bob, code, "bob");
    await bob.fill("#msg-input", "still here");

    await bob.click("#btn-room-menu");
    expect(await bob.locator("#btn-knock-down").count()).toBe(0);
    expect(await bob.locator("#aim-btn-toss").count()).toBe(0);
    await bob.click("#btn-leave-room");
    await bob.waitForSelector("#room-exit-dialog[open]");
    expect(await bob.evaluate(() => document.activeElement?.id)).toBe("btn-cancel-room-exit");
    await bob.keyboard.press("Escape");
    await bob.waitForSelector("#room-exit-dialog[open]", { state: "hidden" });
    expect(await bob.evaluate(() => document.activeElement?.id)).toBe("btn-room-menu");
    expect(await bob.inputValue("#msg-input")).toBe("still here");
    expect(await bob.locator("#room-code").innerText()).toBe(code);
    await bob.click("#btn-send");
    await alice.waitForFunction(() =>
      document.getElementById("messages")?.textContent?.includes("still here"),
    );

    await bob.click("#btn-room-menu");
    await bob.click("#btn-leave-room");
    await bob.click("#btn-confirm-room-exit");
    await bob.waitForSelector("#name-input");
    await alice.waitForFunction(() => Number.parseInt(document.getElementById("member-count")?.textContent ?? "", 10) === 1);
    expect(await alice.locator("#room-code").innerText()).toBe(code);
    await alice.click("#btn-room-menu");
    expect(await alice.locator("#btn-knock-down").isVisible()).toBe(true);
    expect(await alice.locator("#btn-leave-room").count()).toBe(0);
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
    await alice.click("#btn-open-games");
    await alice.click("#aim-btn-rps");
    await alice.waitForSelector("#game-picker-dialog[open]", { state: "hidden" });
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
    await alice.click("#btn-open-games");
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
    await alice.click("#btn-open-games");
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
    await alice.click("#btn-open-games");
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

  it("returns from Breakout without losing the draft or canvas dimensions", async () => {
    const page = await mobilePage();
    await createFort(page, "alice");
    await page.fill("#msg-input", "back in a moment");

    await page.click("#btn-open-games");
    await page.click("#chat-btn-min");
    await page.waitForSelector("#breakout-canvas", { state: "visible" });
    expect(await page.locator(".room-shell").isVisible()).toBe(false);
    const canvas = page.locator("#breakout-canvas");
    await page.waitForFunction(() => {
      const canvas = document.getElementById("breakout-canvas") as HTMLCanvasElement | null;
      return !!canvas && canvas.width > 300;
    });
    const initialSize = await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    });
    expect((await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(300);

    await page.click("#btn-return-room");
    await page.waitForSelector(".room-shell", { state: "visible" });
    expect(await page.inputValue("#msg-input")).toBe("back in a moment");
    await page.click("#btn-open-games");
    await page.click("#chat-btn-min");
    await canvas.waitFor({ state: "visible" });
    await page.waitForFunction((size) => {
      const canvas = document.getElementById("breakout-canvas") as HTMLCanvasElement | null;
      return !!canvas && canvas.width === size.width && canvas.height === size.height;
    }, initialSize);
    expect(await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    })).toEqual(initialSize);
    await page.click("#btn-return-room");
    await page.click("#btn-send");
    await page.waitForFunction(() =>
      document.getElementById("messages")?.textContent?.includes("back in a moment"),
    );
  });

  it("keeps a real doodle across room and Breakout transitions", async () => {
    const page = await mobilePage();
    await createFort(page, "artist");
    await page.click("#btn-open-games");
    await page.click("#btn-start-drawing");
    await page.waitForSelector("#btn-return-room");
    expect(await page.locator(".room-shell").isVisible()).toBe(false);
    const canvas = page.locator("#game-canvas");
    const before = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    const inkAtStrokePoints = () => canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      return [[0.4, 0.525], [0.5, 0.55], [0.6, 0.575]].map(([x, y]) => {
        const pixels = context.getImageData(Math.floor(canvas.width * x) - 2, Math.floor(canvas.height * y) - 2, 5, 5).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 0);
      });
    });
    expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(before);
    expect(await inkAtStrokePoints()).toEqual([true, true, true]);

    await page.click("#btn-return-room");
    await page.click("#btn-open-games");
    await page.click("#chat-btn-min");
    await page.waitForSelector("#breakout-canvas", { state: "visible" });
    await page.click("#btn-return-room");
    await page.click("#btn-open-games");
    await page.click("#btn-start-drawing");
    expect(await inkAtStrokePoints()).toEqual([true, true, true]);
    await page.click("#btn-return-room");
    await page.fill("#msg-input", "saved my sketch");
    await page.click("#btn-send");
    await page.waitForFunction(() =>
      document.getElementById("messages")?.textContent?.includes("saved my sketch"),
    );
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

    await alice.click("#btn-open-games");
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

    await alice.click("#btn-open-games");
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
