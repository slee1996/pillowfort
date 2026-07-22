/**
 * Tests that the V8 "Full Tour" capture choreography works against the real UI.
 * Mirrors the private full-tour capture choreography but with assertions.
 * If a selector or flow changes in the app, this test breaks before the capture does.
 *
 * Screenshot snapshots saved to test/__snapshots__/full-tour/.
 * First run saves baselines. Subsequent runs compare pixel-by-pixel.
 * Update baselines: DELETE test/__snapshots__/full-tour/ and re-run.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "fs/promises";
import sharp from "sharp";
import { startServer, stopServer, getPort } from "./helpers";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/full-tour";
const UPDATE_SNAPSHOTS = process.env.PILLOWFORT_UPDATE_SNAPSHOTS === "1";
const COMPARE_SNAPSHOTS = process.env.PILLOWFORT_COMPARE_SNAPSHOTS !== "0";
const PIXEL_THRESHOLD = 0.005;
const COLOR_THRESHOLD = 25;
const roomPasswords = new Map<string, string>();

let browser: Browser;
const contexts: BrowserContext[] = [];

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

  // Protocol v4 membership is explicitly approved by the current host. Using
  // real pages here keeps the tour on the same authenticated admission path as
  // production and preserves the server's hard rejection of legacy joins.
  await page.waitForFunction(
    () => document.body.textContent?.includes("Waiting for the host to approve this device."),
    undefined,
    { timeout: 30_000 },
  );
  await host.waitForSelector("#admission-approval-overlay", { timeout: 30_000 });
  await host.click("#btn-approve-admission");
  await page.waitForSelector("#messages", { timeout: 30_000 });
  await host.waitForSelector("#admission-approval-overlay", { state: "detached", timeout: 30_000 });
  return page;
}

async function sendChat(
  page: Page,
  text: string,
  style: { bold?: boolean; italic?: boolean; color?: "red" } = {},
): Promise<void> {
  if (style.bold) await page.click("#fmt-bold");
  if (style.italic) await page.click("#fmt-italic");
  if (style.color === "red") {
    await page.click('[title="Font Color"]');
    await page.locator(".color-palette-swatch").first().click();
  }
  await page.fill("#msg-input", text);
  await page.click("#btn-send");
}

async function waitForMessage(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (expected) => document.getElementById("messages")?.textContent?.includes(expected),
    text,
    { timeout: 15_000 },
  );
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
  await page.waitForFunction(
    (expected) => ((window as Window & { __pillowfortQaDraws?: number }).__pillowfortQaDraws || 0) >= expected,
    count,
    { timeout: 15_000 },
  );
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
    document.querySelectorAll(".msg-time, .chat-timestamp").forEach((el) => {
      (el as HTMLElement).textContent = "12:00";
    });
    // Saboteur role system messages (role text differs each run)
    document.querySelectorAll(".msg-system, .chat-message-system").forEach((el) => {
      const text = (el as HTMLElement).textContent || "";
      if (text.includes("saboteur") || text.includes("Saboteur") || text.includes("defender") || text.includes("strike")) {
        (el as HTMLElement).textContent = "Role assigned. The game begins!";
      }
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

async function waitForAllMembers(count: number): Promise<void> {
  const pages = contexts.flatMap((context) => context.pages());
  await Promise.all(pages.map((page) => waitForMembers(page, count)));
}

// --- Phase 1: Sign On ---

describe("Full tour: Sign On", () => {
  it("luna creates fort, 3 friends join, banter flows", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    await sendChat(javi, "we're in! 🏰");
    await waitForMessage(page, "we're in");

    await sendChat(priya, "cozy fort ✨");
    await waitForMessage(page, "cozy fort");

    await assertScreenshot(page, "01-sign-on");
  });
});

// --- Phase 2: Chat Showcase ---

describe("Full tour: Chat Showcase", () => {
  it("bold, italic, colored, and emoji messages render", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    // Luna sends bold
    await sendChat(page, "welcome to the tour", { bold: true });
    await waitForMessage(kai, "welcome to the tour");
    expect(
      await kai.locator("#messages .chat-message", { hasText: "welcome to the tour" }).locator("b").count(),
    ).toBe(1);

    // kai sends colored text
    await sendChat(kai, "wait check this out", { color: "red" });
    await waitForMessage(page, "check this out");
    expect(
      await page.locator("#messages .chat-message", { hasText: "check this out" }).locator('.chat-content span[style*="color"]').count(),
    ).toBeGreaterThan(0);

    // priya sends italic
    await sendChat(priya, "fancy", { italic: true });
    await waitForMessage(page, "fancy");
    expect(await page.locator("#messages .chat-message", { hasText: "fancy" }).locator("i").count()).toBe(1);

    // javi sends emojis
    await sendChat(javi, "😊🔥🎉");
    await waitForMessage(page, "😊🔥🎉");

    // luna sends plain
    await page.click("#fmt-bold");
    await page.fill("#msg-input", "you can style everything");
    await page.click("#btn-send");
    await sleep(300);

    await assertScreenshot(page, "02-chat-showcase");
  });
});

// --- Phase 3: Drawing ---

describe("Full tour: Drawing", () => {
  it("signed v4 browser strokes appear on the shared canvas", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    const canvas = page.locator("#game-canvas");
    expect(await canvas.count()).toBe(1);
    await observeRemoteDraws(page);

    await drawStroke(javi, [
      [400 / 1920, 350 / 1080], [420 / 1920, 300 / 1080], [460 / 1920, 280 / 1080],
      [500 / 1920, 300 / 1080], [500 / 1920, 350 / 1080],
    ]);
    await waitForRemoteDraw(page, 1);

    await drawStroke(priya, [
      [700 / 1920, 400 / 1080], [750 / 1920, 300 / 1080], [800 / 1920, 400 / 1080],
      [850 / 1920, 300 / 1080], [900 / 1920, 400 / 1080],
    ]);
    await waitForRemoteDraw(page, 2);

    await drawStroke(kai, [
      [1100 / 1920, 300 / 1080], [1130 / 1920, 380 / 1080], [1200 / 1920, 380 / 1080],
      [1145 / 1920, 420 / 1080], [1165 / 1920, 500 / 1080], [1100 / 1920, 450 / 1080],
      [1035 / 1920, 500 / 1080],
    ]);
    await waitForRemoteDraw(page, 3);

    await assertScreenshot(page, "03-drawing");
  });
});

// --- Phase 4: Breakout ---

describe("Full tour: Breakout", () => {
  it("chat minimize/maximize works, breakout auto-starts", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    await joinBrowser(page, roomCode, "javi");
    await waitForAllMembers(2);

    // Minimize chat → auto-starts breakout
    await page.click("#chat-btn-min");
    await sleep(500);

    await assertScreenshot(page, "04-breakout");

    // Restore chat
    await page.click("#chat-btn-min");
    await sleep(300);

    await page.waitForFunction(() => {
      const win = document.querySelector('.chat-window');
      return win && !win.classList.contains('minimized');
    });
  });
});

// --- Phase 5: RPS ---

describe("Full tour: Rock Paper Scissors", () => {
  it("luna challenges javi, luna wins with rock vs scissors", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    await joinBrowser(page, roomCode, "priya");
    await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    await page.click("#aim-btn-rps");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();

    await javi.waitForSelector("#rps-overlay.open");
    await javi.click("#rps-actions .xp-btn-primary", { force: true });

    await page.waitForSelector("#rps-overlay.open");
    await page.waitForSelector(".rps-pick");
    await javi.waitForSelector(".rps-pick");

    // luna picks rock
    await page.locator(".rps-pick[title='rock']").click();
    // javi picks scissors → luna wins
    await javi.locator(".rps-pick[title='scissors']").click();

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "05-rps-luna-wins");

    // Dismiss
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await javi.click("#rps-actions .xp-btn");
  });
});

// --- Phase 6: Tic-Tac-Toe ---

describe("Full tour: Tic-Tac-Toe", () => {
  it("luna challenges priya, plays full game, luna wins", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    await page.click("#aim-btn-ttt");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    await priya.waitForSelector("#ttt-overlay.open");
    await priya.click("#ttt-actions .xp-btn-primary", { force: true });

    // Wait for the board to render with 9 cells
    await page.waitForFunction(() => {
      const board = document.getElementById("ttt-board");
      return board && board.children.length === 9;
    }, undefined, { timeout: 5000 });
    await sleep(500);

    // luna(4), priya(0), luna(2), priya(6), luna(5), priya(1), luna(8)
    await page.locator("#ttt-board > *").nth(4).click();
    await priya.locator("#ttt-board > *").nth(4).waitFor({ state: "visible" });
    await priya.locator("#ttt-board > *").nth(0).click();
    await page.waitForFunction(() => document.querySelectorAll("#ttt-board > .ttt-cell:not(:empty)").length >= 2);
    await page.locator("#ttt-board > *").nth(2).click();
    await priya.waitForFunction(() => document.querySelectorAll("#ttt-board > .ttt-cell:not(:empty)").length >= 3);
    await priya.locator("#ttt-board > *").nth(6).click();
    await page.waitForFunction(() => document.querySelectorAll("#ttt-board > .ttt-cell:not(:empty)").length >= 4);
    await page.locator("#ttt-board > *").nth(5).click();
    await priya.waitForFunction(() => document.querySelectorAll("#ttt-board > .ttt-cell:not(:empty)").length >= 5);
    await priya.locator("#ttt-board > *").nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll("#ttt-board > .ttt-cell:not(:empty)").length >= 6);
    await page.locator("#ttt-board > *").nth(8).click(); // luna wins!

    await page.waitForFunction(() => {
      const el = document.getElementById("ttt-status");
      return el && el.textContent && (el.textContent.includes("win") || el.textContent.includes("wins"));
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "06-ttt-luna-wins");

    // Dismiss
    await page.click("#ttt-actions .xp-btn");
    await priya.click("#ttt-actions .xp-btn");
  }, 30000);
});

// --- Phase 7: Saboteur ---

describe("Full tour: Saboteur", () => {
  it("saboteur starts, role reveal, accusations fly", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    await page.click("#aim-btn-sab");

    // V4 distributes the encrypted role state to every admitted member.
    await Promise.all([page, javi, kai].map((participant) =>
      participant.waitForSelector(".sab-role-badge", { timeout: 10_000 })
    ));
    await sleep(500);

    await sendChat(kai, "who's the saboteur 👀");
    await waitForMessage(page, "who's the saboteur");

    await sendChat(javi, "definitely not me");
    await waitForMessage(page, "definitely not me");

    await assertScreenshot(page, "07-saboteur");
  });
});

// --- Phase 8: KOTH ---

describe("Full tour: King of the Hill", () => {
  it("kai challenges luna, luna wins KOTH and keeps host", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    await kai.click("#aim-btn-koth");

    await page.waitForSelector("#rps-overlay.open", { timeout: 5000 });
    await page.waitForSelector(".rps-pick");

    await assertScreenshot(page, "08-koth-rps-overlay");

    // luna picks rock
    await page.locator(".rps-pick[title='rock']").click();
    // kai picks scissors → luna wins
    await kai.locator(".rps-pick[title='scissors']").click();

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "09-koth-luna-wins");

    // Dismiss overlay
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn", { force: true });
    await kai.click("#rps-actions .xp-btn", { force: true });
    await sleep(300);

    // Luna won, so relay authority must not move to the challenger.
    await page.waitForSelector("#btn-knock-down", { state: "visible" });
    expect(await kai.locator("#btn-leave-room").isVisible()).toBe(true);
    expect(await javi.locator("#btn-leave-room").isVisible()).toBe(true);
  });
});

// --- Phase 9: Pillow Fight ---

describe("Full tour: Pillow Fight", () => {
  it("luna votes to kick javi, priya and kai vote yes, javi ejected", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    await page.click("#aim-btn-vote");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();
    await sleep(500);

    // priya and kai vote yes
    await priya.waitForSelector("#vote-yes", { timeout: 10_000 });
    await kai.waitForSelector("#vote-yes", { timeout: 10_000 });
    await priya.click("#vote-yes");
    await kai.click("#vote-yes");

    // Wait for javi to be kicked (member count drops to 3)
    await waitForMembers(page, 3);
    await javi.waitForSelector("#btn-home", { state: "visible", timeout: 10_000 });

    await assertScreenshot(page, "10-pillow-fight");
  });
});

// --- Phase 10: Pillow Toss + Knock Down ---

describe("Full tour: Pillow Toss + Knock Down", () => {
  it("luna tosses host to kai, kai knocks down the fort", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForAllMembers(4);

    // Luna tosses host to kai
    await page.click("#aim-btn-toss");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "kai" }).click();
    await kai.waitForSelector("#host-offer-overlay", { timeout: 15_000 });
    await kai.click("#btn-catch");

    // Verify the capability-bound host transfer reached every participant.
    await kai.waitForSelector("#btn-knock-down", { state: "visible", timeout: 15_000 });
    expect(await javi.locator("#btn-leave-room").isVisible()).toBe(true);
    expect(await priya.locator("#btn-leave-room").isVisible()).toBe(true);

    // kai knocks down
    await kai.click("#btn-knock-down");

    await page.waitForSelector("#btn-home", { state: "visible", timeout: 5000 });
    await assertScreenshot(page, "11-knocked-down");
  });
});
