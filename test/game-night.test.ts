/**
 * Tests that the V7 "Game Night" capture choreography works against the real UI.
 * Mirrors the private game-night capture choreography but with assertions.
 * If a selector or flow changes in the app, this test breaks before the capture does.
 *
 * Screenshot snapshots saved to test/__snapshots__/game-night/.
 * First run saves baselines. Subsequent runs compare pixel-by-pixel.
 * Update baselines: DELETE test/__snapshots__/game-night/ and re-run.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "fs/promises";
import sharp from "sharp";
import { startServer, stopServer, getPort } from "./helpers";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/game-night";
const UPDATE_SNAPSHOTS = process.env.PILLOWFORT_UPDATE_SNAPSHOTS === "1";
const COMPARE_SNAPSHOTS = process.env.PILLOWFORT_COMPARE_SNAPSHOTS !== "0";
const PIXEL_THRESHOLD = 0.005;
const COLOR_THRESHOLD = 25;
const roomPasswords = new Map<string, string>();

let browser: Browser;
const contexts: BrowserContext[] = [];
const pageDiagnostics = new WeakMap<Page, string[]>();

beforeAll(async () => {
  await startServer();
  browser = await chromium.launch();
  await mkdir(SNAPSHOT_DIR, { recursive: true });
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

async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const diagnostics: string[] = [];
  pageDiagnostics.set(page, diagnostics);
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on("websocket", (socket) => {
    diagnostics.push(`websocket opened: ${socket.url()}`);
    socket.on("framereceived", (event) => {
      if (typeof event.payload !== "string") return;
      try {
        const frame = JSON.parse(event.payload) as { type?: unknown; code?: unknown; reason?: unknown };
        diagnostics.push(`websocket received: ${String(frame.type)} ${String(frame.code ?? "")} ${String(frame.reason ?? "")}`.trim());
      } catch {}
    });
    socket.on("close", () => diagnostics.push("websocket closed"));
    socket.on("socketerror", (error) => diagnostics.push(`websocket error: ${error}`));
  });
  await page.goto(`http://localhost:${getPort()}/`);
  return page;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function joinBrowser(host: Page, roomCode: string, name: string): Promise<Page> {
  const password = roomPasswords.get(roomCode);
  if (!password) throw new Error(`missing test room secret for ${roomCode}`);
  const page = await newPage();
  await page.fill("#name-input", name);
  await page.click("#btn-join");
  await page.fill("#join-room", roomCode);
  await page.fill("#join-password", password);
  await page.click("#btn-enter");

  // Protocol v4 admission is intentionally host-gated. The old visual harness
  // bypassed this with a legacy WebSocket, which stopped exercising the real
  // product as soon as rooms became downgrade-protected.
  await page.waitForFunction(() => document.body.textContent?.includes("Waiting for the host to approve this device."), undefined, { timeout: 30_000 });
  await host.waitForSelector("#admission-approval-overlay", { timeout: 30_000 });
  await host.click("#btn-approve-admission");
  try {
    await page.waitForSelector("#messages", { timeout: 30_000 });
  } catch (error) {
    const [guestText, hostText] = await Promise.all([
      page.locator("body").innerText().catch(() => "<guest unavailable>"),
      host.locator("body").innerText().catch(() => "<host unavailable>"),
    ]);
    throw new Error(
      `secure admission did not finish for ${name}\n` +
      `guest: ${guestText.slice(0, 1200)}\n` +
      `host: ${hostText.slice(0, 1200)}`,
      { cause: error },
    );
  }
  await host.waitForSelector("#admission-approval-overlay", { state: "detached", timeout: 30_000 });
  return page;
}

async function sendChat(page: Page, text: string, style: "bold" | null = null): Promise<void> {
  if (style === "bold") await page.click("#fmt-bold");
  await page.fill("#msg-input", text);
  await page.click("#btn-send");
}

async function waitForMessage(page: Page, text: string): Promise<void> {
  try {
    await page.waitForFunction((expected) => document.getElementById("messages")?.textContent?.includes(expected), text, { timeout: 15_000 });
  } catch (error) {
    const body = await page.locator("body").innerText().catch(() => "<page unavailable>");
    const diagnostics = pageDiagnostics.get(page)?.join("\n") || "<no browser diagnostics>";
    throw new Error(
      `message ${JSON.stringify(text)} was not rendered\n${body.slice(0, 1600)}\n${diagnostics}`,
      { cause: error },
    );
  }
}

async function drawStroke(page: Page, points: [number, number][]): Promise<void> {
  await page.locator("#game-canvas").evaluate((canvas, normalizedPoints) => {
    const element = canvas as HTMLCanvasElement;
    const rect = element.getBoundingClientRect();
    const dispatch = (type: string, point: [number, number], buttons: number) => {
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons,
        clientX: rect.left + point[0] * rect.width,
        clientY: rect.top + point[1] * rect.height,
      }));
    };
    dispatch("pointerdown", normalizedPoints[0], 1);
    for (const point of normalizedPoints.slice(1)) dispatch("pointermove", point, 1);
    dispatch("pointerup", normalizedPoints[normalizedPoints.length - 1], 0);
  }, points);
}

async function observeRemoteDraws(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __pillowfortQaDraws?: number }).__pillowfortQaDraws = 0;
    window.addEventListener("pf-draw", () => {
      const target = window as Window & { __pillowfortQaDraws?: number };
      target.__pillowfortQaDraws = (target.__pillowfortQaDraws || 0) + 1;
    });
  });
}

async function waitForRemoteDraw(page: Page, count: number): Promise<void> {
  await page.waitForFunction((expected) =>
    ((window as Window & { __pillowfortQaDraws?: number }).__pillowfortQaDraws || 0) >= expected,
  count, { timeout: 15_000 });
}

async function maskDynamic(page: Page) {
  await page.evaluate(() => {
    const rc = document.getElementById("room-code");
    if (rc) rc.textContent = "abc12345";
    // The room flag is also rendered in system chat and the buddy panel.
    // Normalize text nodes in place so their surrounding markup/styles remain intact.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      textNode.nodeValue = textNode.nodeValue?.replace(/\bf-[a-z2-7]{10}\b/g, "f-aaaaaaaaaa") ?? null;
    }
    document.querySelectorAll(".msg-time").forEach((el) => {
      (el as HTMLElement).textContent = "12:00";
    });
  });
}

async function assertScreenshot(page: Page, name: string) {
  await maskDynamic(page);
  await sleep(100);

  const screenshotBuf = await page.screenshot({ type: "png" });
  const path = `${SNAPSHOT_DIR}/${name}.png`;
  const file = Bun.file(path);

  if (UPDATE_SNAPSHOTS) {
    await Bun.write(path, screenshotBuf);
    console.log(`  [snapshot] updated baseline: ${name}.png`);
    return;
  }
  if (!COMPARE_SNAPSHOTS) return;
  if (!(await file.exists())) {
    await Bun.write(path, screenshotBuf);
    console.log(`  [snapshot] saved baseline: ${name}.png`);
    return;
  }

  const [actual, baseline] = await Promise.all([
    sharp(screenshotBuf).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
    sharp(await file.arrayBuffer()).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
  ]);

  expect(actual.info.width).toBe(baseline.info.width);
  expect(actual.info.height).toBe(baseline.info.height);

  const totalPixels = actual.info.width * actual.info.height;
  let diffCount = 0;

  for (let i = 0; i < actual.data.length; i += 4) {
    const dr = Math.abs(actual.data[i] - baseline.data[i]);
    const dg = Math.abs(actual.data[i + 1] - baseline.data[i + 1]);
    const db = Math.abs(actual.data[i + 2] - baseline.data[i + 2]);
    if (dr > COLOR_THRESHOLD || dg > COLOR_THRESHOLD || db > COLOR_THRESHOLD) {
      diffCount++;
    }
  }

  const diffRatio = diffCount / totalPixels;
  if (diffRatio > PIXEL_THRESHOLD) {
    await Bun.write(`${SNAPSHOT_DIR}/${name}.actual.png`, screenshotBuf);
    expect(diffRatio).toBeLessThanOrEqual(PIXEL_THRESHOLD);
  }
}

// --- helpers ---

async function setupRoom(page: Page): Promise<string> {
  await page.fill("#name-input", "luna");
  await page.click("#btn-setup");
  const password = await page.inputValue("#setup-password");
  await page.click("#btn-create");
  await page.waitForFunction(() => {
    const el = document.getElementById("room-code");
    return el && el.textContent && el.textContent.length >= 8;
  });
  const roomCode = await page.locator("#room-code").innerText();
  roomPasswords.set(roomCode, password);
  return roomCode;
}

async function waitForMembers(page: Page, count: number) {
  await page.waitForFunction((n) => {
    const el = document.getElementById("member-count");
    return el && el.textContent && el.textContent.includes(String(n));
  }, count);
}

// --- Phase 1: Arrival ---

describe("Game night: Arrival", () => {
  it("luna creates fort, 3 friends join, banter flows", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForMembers(page, 4);

    await sendChat(javi, "game night lets gooo 🎮");
    await waitForMessage(page, "game night");

    await sendChat(priya, "finally!! who's ready to lose", "bold");
    await waitForMessage(page, "ready to lose");

    await sendChat(kai, "big talk from someone who lost last time 😏");
    await waitForMessage(page, "big talk");

    // Luna chats via browser
    await page.fill("#msg-input", "ok ok calm down...");
    await page.click("#btn-send");

    await waitForMessage(kai, "ok ok calm down...");

    // Toggle bold, send
    await page.click("#fmt-bold");
    await page.fill("#msg-input", "first challenge: RPS");
    await page.click("#btn-send");

    await waitForMessage(page, "first challenge: RPS");
    await waitForMessage(kai, "first challenge: RPS");
    expect(await kai.locator("#messages .chat-message", { hasText: "first challenge: RPS" }).locator("b").count()).toBe(1);
    await page.locator("#fmt-bold").click({ force: true });

    await assertScreenshot(page, "01-arrival-chat");

    // Regression: the protocol-v4 admission/control fanout must not consume
    // the room or host rate budget and disconnect otherwise healthy members.
    for (const participant of [page, javi, priya, kai]) {
      expect(await participant.locator("#messages").isVisible()).toBe(true);
      const trace = pageDiagnostics.get(participant) || [];
      expect(trace.some((entry) => entry.includes("rate-limited") || entry === "websocket closed")).toBe(false);
    }
  });
});

// --- Phase 2: RPS Duels ---

describe("Game night: RPS Duels", () => {
  it("luna vs kai (luna loses), luna vs priya (luna wins)", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForMembers(page, 4);

    // Duel 1: luna challenges kai
    await page.click("#aim-btn-rps");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "kai" }).click();

    await kai.waitForSelector("#rps-overlay.open");
    await kai.click("#rps-actions .xp-btn-primary");

    await page.waitForSelector("#rps-overlay.open");
    await page.waitForSelector(".rps-pick");

    // luna picks scissors
    await page.locator(".rps-pick[title='scissors']").click();
    // kai picks rock → kai wins
    await kai.locator(".rps-pick[title='rock']").click();

    // Wait for result
    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "02-rps-kai-wins");

    // Dismiss
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await kai.click("#rps-actions .xp-btn");
    await sleep(300);

    // Duel 2: luna challenges priya
    await page.click("#aim-btn-rps");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    await priya.waitForSelector("#rps-overlay.open");
    await priya.click("#rps-actions .xp-btn-primary");

    await page.waitForSelector("#rps-overlay.open");
    await page.waitForSelector(".rps-pick");

    // luna picks rock
    await page.locator(".rps-pick[title='rock']").click();
    // priya picks scissors → luna wins
    await priya.locator(".rps-pick[title='scissors']").click();

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "03-rps-luna-wins");

    // Dismiss
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await priya.click("#rps-actions .xp-btn");
  });
});

// --- Phase 3: Canvas + Breakout ---

describe("Game night: Canvas + Breakout", () => {
  it("draw strokes appear, chat minimize/maximize works", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");

    const canvas = page.locator("#game-canvas");
    expect(await canvas.count()).toBe(1);
    await observeRemoteDraws(page);

    // Real v4 browser strokes are signed, encrypted, relayed, and rendered.
    await drawStroke(javi, [
      [0.20, 0.32], [0.22, 0.28], [0.24, 0.26], [0.26, 0.28], [0.26, 0.32],
    ]);
    await waitForRemoteDraw(page, 1);

    await drawStroke(priya, [
      [0.36, 0.37], [0.39, 0.28], [0.42, 0.37], [0.45, 0.28], [0.48, 0.37],
    ]);
    await waitForRemoteDraw(page, 2);

    await drawStroke(kai, [
      [0.57, 0.28], [0.59, 0.35], [0.63, 0.35], [0.60, 0.39],
      [0.61, 0.46], [0.57, 0.42], [0.54, 0.46],
    ]);
    await waitForRemoteDraw(page, 3);

    await assertScreenshot(page, "04-canvas-drawing");

    // Minimize chat → auto-starts breakout
    await page.click("#chat-btn-min");
    await sleep(500);

    await assertScreenshot(page, "05-breakout-started");

    // Restore chat (click minimize again to toggle)
    await page.click("#chat-btn-min");
    await sleep(300);

    // Verify chat window is no longer minimized
    await page.waitForFunction(() => {
      const win = document.querySelector('.chat-window');
      return win && !win.classList.contains('minimized');
    });
  });
});

// --- Phase 4: KOTH ---

describe("Game night: King of the Hill", () => {
  it("kai challenges luna, RPS resolves, host transfers to kai", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForMembers(page, 4);

    // kai sends KOTH challenge
    await kai.click("#aim-btn-koth");

    // luna's browser shows RPS overlay for KOTH
    await page.waitForSelector("#rps-overlay.open", { timeout: 5000 });
    await page.waitForSelector(".rps-pick");

    await assertScreenshot(page, "06-koth-rps-overlay");

    // luna picks paper
    await page.locator(".rps-pick[title='paper']").click();
    // kai picks scissors → kai wins
    await kai.locator(".rps-pick[title='scissors']").click();

    // Wait for result
    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "07-koth-kai-wins");

    // A v4 KOTH result cannot silently change relay authority. The challenger
    // must accept the capability-bound transfer after the encrypted win. The
    // transfer offer supersedes the transient RPS result UI, so there is no
    // separate result-dismiss action on this branch.
    await kai.waitForSelector("#host-offer-overlay", { timeout: 15_000 });
    await kai.click("#btn-catch");
    await kai.waitForSelector("#btn-knock-down", { state: "visible", timeout: 15_000 });
    await page.waitForSelector("#btn-leave-room", { state: "visible", timeout: 15_000 });
    expect(await javi.locator("#btn-leave-room").isVisible()).toBe(true);
  });
});

// --- Phase 5: Knock Down ---

describe("Game night: Knock Down", () => {
  it("kai (new host via KOTH) knocks down the fort", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForMembers(page, 4);

    // kai challenges and wins KOTH to become host
    await kai.click("#aim-btn-koth");
    await page.waitForSelector("#rps-overlay.open", { timeout: 5000 });
    await page.waitForSelector(".rps-pick");

    // luna picks paper, kai picks scissors → kai wins
    await page.locator(".rps-pick[title='paper']").click();
    await kai.locator(".rps-pick[title='scissors']").click();

    // The capability-bound offer is the durable KOTH win oracle. It may
    // supersede the transient result overlay before a polling frame observes
    // that overlay, so do not make the transfer depend on local animation timing.
    await kai.waitForSelector("#host-offer-overlay", { timeout: 15_000 });
    await kai.click("#btn-catch");
    await kai.waitForSelector("#btn-knock-down", { state: "visible", timeout: 15_000 });

    // Farewell chat
    await sendChat(kai, "thanks everyone. this was perfect.");
    await waitForMessage(page, "this was perfect");

    await page.fill("#msg-input", "goodnight everybody 💤");
    await page.click("#btn-send");
    await sleep(300);

    await sendChat(priya, "🌙✨");
    await sendChat(javi, "night night");
    await waitForMessage(page, "night night");

    // kai (new host) knocks down
    await kai.click("#btn-knock-down");

    try {
      await page.waitForSelector("#btn-home", { state: "visible", timeout: 15_000 });
    } catch (error) {
      const diagnostics = await Promise.all([
        ["luna", page], ["javi", javi], ["priya", priya], ["kai", kai],
      ].map(async ([name, participant]) => {
        const participantPage = participant as Page;
        const body = await participantPage.locator("body").innerText().catch(() => "<page unavailable>");
        const trace = pageDiagnostics.get(participantPage)?.slice(-30).join("\n") || "<no browser diagnostics>";
        return `${name}:\n${body.slice(0, 1000)}\n${trace}`;
      }));
      throw new Error(`new host room close did not retire all members\n${diagnostics.join("\n---\n")}`, { cause: error });
    }
    await assertScreenshot(page, "08-knocked-down");
  });
});
