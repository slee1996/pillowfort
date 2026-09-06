/**
 * Tests that the demo reel capture script's choreography works against the real UI.
 * Mirrors the private demo-reel capture choreography but with assertions.
 * If a selector or flow changes in the app, this test breaks before the capture does.
 *
 * Screenshot snapshots saved to test/__snapshots__/demo-reel/.
 * First run saves baselines. Subsequent runs compare pixel-by-pixel.
 * Update baselines: DELETE test/__snapshots__/demo-reel/ and re-run.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "fs/promises";
import sharp from "sharp";
import { startServer, stopServer, getPort } from "./helpers";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/demo-reel";
const UPDATE_SNAPSHOTS = process.env.PILLOWFORT_UPDATE_SNAPSHOTS === "1";
const COMPARE_SNAPSHOTS = process.env.PILLOWFORT_COMPARE_SNAPSHOTS !== "0";
// Max fraction of pixels that can differ (0.005 = 0.5%)
const PIXEL_THRESHOLD = 0.005;
// Per-channel difference below this is ignored (0-255 scale)
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
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
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

  await page.waitForFunction(() => document.body.textContent?.includes("Waiting for the host to approve this device."), undefined, { timeout: 30_000 });
  await host.waitForSelector("#admission-approval-overlay", { timeout: 30_000 });
  await host.click("#btn-approve-admission");
  await page.waitForSelector("#messages", { timeout: 30_000 });
  await host.waitForSelector("#admission-approval-overlay", { state: "detached", timeout: 30_000 });
  return page;
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.fill("#msg-input", text);
  await page.click("#btn-send");
}

async function waitForMessage(page: Page, text: string): Promise<void> {
  await page.waitForFunction((expected) =>
    document.getElementById("messages")?.textContent?.includes(expected),
  text, { timeout: 15_000 });
}

async function drawStroke(page: Page, points: [number, number][]): Promise<void> {
  await page.click("#btn-open-games");
  await page.click("#btn-start-drawing");
  const canvas = await page.locator("#game-canvas").boundingBox();
  if (!canvas) throw new Error("Drawing canvas is not visible");
  await page.mouse.move(canvas.x + points[0][0] * canvas.width, canvas.y + points[0][1] * canvas.height);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(canvas.x + x * canvas.width, canvas.y + y * canvas.height, { steps: 4 });
  }
  await page.mouse.up();
  await page.click("#btn-return-room");
  await page.waitForSelector(".room-shell", { state: "visible" });
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


/**
 * Take screenshot and compare against saved baseline.
 * First run: saves baseline. Subsequent runs: compare pixel-by-pixel.
 */
async function assertScreenshot(page: Page, name: string) {
  // Small wait for any animations to settle
  await sleep(100);

  const screenshotBuf = await page.screenshot({
    type: "png",
    // Random role assignment remains asserted above; mask only its visual variants.
    mask: [
      page.locator("#room-code"),
      page.locator(".chat-timestamp"),
      page.locator(".sab-role-badge"),
      page.locator('.sab-strike-btn, [title="Accuse Saboteur"]'),
      page.locator(".chat-message-system").filter({
        hasText: /YOU are the saboteur!|You are a defender\./,
      }),
    ],
    // Screenshot-only geometry keeps different role labels/actions from moving
    // adjacent content. Playwright restores these styles after the capture.
    style: `
      .sab-role-badge { box-sizing: border-box !important; width: 220px !important; height: 28px !important; }
      .sab-strike-btn, [title="Accuse Saboteur"] {
        box-sizing: border-box !important; flex: 0 0 160px !important;
        width: 160px !important; height: 44px !important; min-height: 44px !important;
        margin: 0 !important; animation: none !important;
      }
    `,
  });
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

  // Load both images as raw RGBA pixels
  const [actual, baseline] = await Promise.all([
    sharp(screenshotBuf).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
    sharp(await file.arrayBuffer()).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
  ]);

  // Dimension mismatch = definite failure
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
    // Save the actual for debugging
    await Bun.write(`${SNAPSHOT_DIR}/${name}.actual.png`, screenshotBuf);
    expect(diffRatio).toBeLessThanOrEqual(PIXEL_THRESHOLD);
  }
}

// --- helpers to reduce setup boilerplate ---

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

// --- Phase 1: Sign On ---

describe("Demo reel: Sign On", () => {
  it("name → set up → password → create → room code appears", async () => {
    const page = await newPage();

    await page.fill("#name-input", "");
    await page.type("#name-input", "luna", { delay: 50 });
    expect(await page.inputValue("#name-input")).toBe("luna");

    await page.click("#btn-setup");
    await page.waitForSelector("#setup-password", { state: "visible" });
    await assertScreenshot(page, "01-setup-password");

    await page.click("#password-options > summary");
    await page.click("#btn-regenerate-secret");
    await page.click("#btn-create");

    await page.waitForSelector("#room-code");
    await page.waitForFunction(() => {
      const el = document.getElementById("room-code");
      return el && el.textContent && el.textContent.length >= 8;
    });

    const roomCode = await page.locator("#room-code").innerText();
    expect(roomCode).toMatch(/^f-[a-z2-7]{10}$/);

    await assertScreenshot(page, "02-room-created");
  });
});

// --- Phase 2: Friends Join + Chat ---

describe("Demo reel: Friends Join + Chat", () => {
  it("friends join through secure admission and chat messages appear", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    await waitForMembers(page, 3);

    // Browser chat first (so we can assert cleanly on priya)
    await page.fill("#msg-input", "welcome to the sleepover 🌙");
    await page.click("#btn-send");

    await waitForMessage(priya, "welcome to the sleepover 🌙");

    await sendChat(javi, "hey everyone!! 🏰");
    await waitForMessage(page, "hey everyone");

    await sendChat(priya, "love the fort name!");
    await waitForMessage(page, "love the fort");

    await assertScreenshot(page, "03-chat-room");
  });
});

// --- Phase 3: Drawing ---

describe("Demo reel: Drawing", () => {
  it("friends doodle together and return to the conversation", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");

    const canvas = page.locator("#game-canvas");
    expect(await canvas.count()).toBe(1);
    await observeRemoteDraws(page);

    await drawStroke(javi, [
      [0.18, 0.38], [0.21, 0.32], [0.24, 0.29], [0.27, 0.32], [0.30, 0.38],
    ]);
    await waitForRemoteDraw(page, 1);

    // Add more strokes for a richer snapshot
    await drawStroke(priya, [
      [0.38, 0.48], [0.41, 0.38], [0.44, 0.48], [0.47, 0.38], [0.50, 0.48],
    ]);
    await waitForRemoteDraw(page, 2);

    await page.click("#btn-open-games");
    await page.click("#btn-start-drawing");
    await assertScreenshot(page, "04-drawing");
    await page.click("#btn-return-room");
    await sendChat(page, "love these doodles");
    await waitForMessage(javi, "love these doodles");
  });
});

// --- Phase 4: Tic-Tac-Toe ---

describe("Demo reel: Tic-Tac-Toe", () => {
  it("luna challenges javi, both play in the UI, luna wins", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    await waitForMembers(page, 2);

    await page.click("#btn-open-games");
    await page.click("#aim-btn-ttt");
    await page.waitForSelector("dialog#member-picker-overlay[open]");
    await assertScreenshot(page, "05-ttt-member-picker");

    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();

    await javi.waitForSelector("#ttt-overlay.open");
    await javi.click("#ttt-actions .xp-btn-primary");

    await page.waitForSelector("#ttt-board");
    await page.waitForSelector(".ttt-cell");
    const cells = page.locator(".ttt-cell");
    expect(await cells.count()).toBe(9);

    await assertScreenshot(page, "06-ttt-board-empty");

    // luna(4), javi(0), luna(2), javi(1), luna(5), javi(6), luna(8)
    await cells.nth(4).click();
    await javi.waitForFunction(() => document.querySelectorAll(".ttt-cell.x").length === 1);
    await javi.locator(".ttt-cell").nth(0).click();
    await page.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 1);

    await cells.nth(2).click();
    await javi.waitForFunction(() => document.querySelectorAll(".ttt-cell.x").length === 2);
    await javi.locator(".ttt-cell").nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 2);

    await cells.nth(5).click();
    await javi.waitForFunction(() => document.querySelectorAll(".ttt-cell.x").length === 3);
    await javi.locator(".ttt-cell").nth(6).click();
    await page.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 3);

    await cells.nth(8).click(); // luna wins!

    await page.waitForFunction(() => {
      const el = document.getElementById("ttt-status");
      return el && el.textContent && (el.textContent.includes("win") || el.textContent.includes("Win"));
    }, undefined, { timeout: 5000 });

    await assertScreenshot(page, "07-ttt-luna-wins");
  });
});

// --- Phase 5: Saboteur ---

describe("Demo reel: Saboteur", () => {
  it("saboteur starts with 4 players, role reveal happens", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    const kai = await joinBrowser(page, roomCode, "kai");
    await waitForMembers(page, 4);

    await page.click("#btn-open-games");
    await page.click("#aim-btn-sab");

    const players = [page, javi, priya, kai];
    await Promise.all(players.map((player) =>
      player.waitForSelector(".sab-role-badge", { timeout: 15_000 })
    ));
    const roles = await Promise.all(players.map((player) =>
      player.locator(".sab-role-badge.saboteur").isVisible()
    ));
    expect(roles.filter(Boolean)).toHaveLength(1);

    // Wait for role reveal animation
    await sleep(500);
    await assertScreenshot(page, "08-saboteur-role-reveal");
  });
});

// --- Phase 6: Pillow Fight ---

describe("Demo reel: Pillow Fight", () => {
  it("luna starts vote against javi, priya votes yes, javi ejected", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    await waitForMembers(page, 3);

    await page.click("#btn-open-games");
    await page.click("#aim-btn-vote");
    await page.waitForSelector("dialog#member-picker-overlay[open]");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();

    await page.waitForSelector("#vote-banner.visible", { timeout: 5000 });
    await assertScreenshot(page, "09-vote-banner");

    await priya.click("#vote-yes");
    await javi.waitForSelector("#btn-home", { state: "visible", timeout: 15_000 });

    // Wait for vote result to render
    await sleep(300);
    await assertScreenshot(page, "10-vote-resolved");
  });
});

// --- Phase 7: Pillow Toss ---

describe("Demo reel: Pillow Toss", () => {
  it("luna tosses to priya, priya accepts, host transfers", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await joinBrowser(page, roomCode, "javi");
    const priya = await joinBrowser(page, roomCode, "priya");
    await waitForMembers(page, 3);

    await page.click("#btn-room-menu");
    await page.click("#aim-btn-toss");
    await page.waitForSelector("dialog#member-picker-overlay[open]");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    await priya.waitForSelector("#host-offer-overlay", { timeout: 15_000 });
    await priya.click("#btn-catch");
    await priya.click("#btn-room-menu");
    await priya.waitForSelector("#btn-knock-down", { state: "visible", timeout: 15_000 });
    await javi.click("#btn-room-menu");
    await javi.waitForSelector("#btn-leave-room", { state: "visible", timeout: 15_000 });

    await sleep(300);
    await assertScreenshot(page, "11-host-transferred");
  });
});

// --- Phase 8: Knock Down ---

describe("Demo reel: Knock Down", () => {
  it("new host priya knocks down the fort", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const priya = await joinBrowser(page, roomCode, "priya");
    await waitForMembers(page, 2);

    await page.click("#btn-room-menu");
    await page.click("#aim-btn-toss");
    await page.waitForSelector("dialog#member-picker-overlay[open]");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    await priya.waitForSelector("#host-offer-overlay", { timeout: 15_000 });
    await priya.click("#btn-catch");
    await priya.click("#btn-room-menu");
    await priya.waitForSelector("#btn-knock-down", { state: "visible", timeout: 15_000 });

    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("priya");
    }, undefined, { timeout: 5000 });

    await priya.click("#btn-knock-down");
    await priya.click("#btn-confirm-room-exit");

    await page.waitForSelector("#btn-home", { state: "visible", timeout: 5000 });
    await assertScreenshot(page, "12-knocked-down");
  });
});
