/**
 * Tests that the demo reel capture script's choreography works against the real UI.
 * Mirrors video/capture/scenes/capture-demo-reel.ts but with assertions.
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
import {
  connect, joinRoom as wsJoin, chat, draw, sleep,
  tttAccept, tttMove, castVote, knockDown,
  type Client,
} from "../video/capture/ws-client";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/demo-reel";
// Max fraction of pixels that can differ (0.005 = 0.5%)
const PIXEL_THRESHOLD = 0.005;
// Per-channel difference below this is ignored (0-255 scale)
const COLOR_THRESHOLD = 25;

let browser: Browser;
const contexts: BrowserContext[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  await startServer();
  browser = await chromium.launch();
  await mkdir(SNAPSHOT_DIR, { recursive: true });
});

afterEach(async () => {
  for (const c of clients) {
    try { await c.close(); } catch {}
  }
  clients.length = 0;
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

async function wsJoinTracked(roomCode: string, name: string): Promise<Client> {
  const client = await wsJoin(getPort(), roomCode, name, "sleepover");
  clients.push(client);
  return client;
}

/** Mask dynamic elements so screenshots are stable across runs. */
async function maskDynamic(page: Page) {
  await page.evaluate(() => {
    // Room code changes every run
    const rc = document.getElementById("room-code");
    if (rc) rc.textContent = "abc12345";
    // Timestamps in chat messages
    document.querySelectorAll(".msg-time").forEach((el) => {
      (el as HTMLElement).textContent = "12:00";
    });
    // Saboteur role badges — role is random each run
    document.querySelectorAll(".sab-role-badge").forEach((el) => {
      el.classList.remove("saboteur", "defender");
      el.classList.add("defender"); // normalize to one style
      (el as HTMLElement).textContent = "ROLE";
    });
    // Saboteur role system messages (saboteur vs defender text differs)
    document.querySelectorAll(".msg-system").forEach((el) => {
      const text = (el as HTMLElement).textContent || "";
      if (text.includes("saboteur") || text.includes("Saboteur") || text.includes("defender") || text.includes("strike")) {
        (el as HTMLElement).textContent = "Role assigned. The game begins!";
      }
    });
  });
}

/**
 * Take screenshot and compare against saved baseline.
 * First run: saves baseline. Subsequent runs: compare pixel-by-pixel.
 */
async function assertScreenshot(page: Page, name: string) {
  await maskDynamic(page);
  // Small wait for any animations to settle
  await sleep(100);

  const screenshotBuf = await page.screenshot({ type: "png" });
  const path = `${SNAPSHOT_DIR}/${name}.png`;
  const file = Bun.file(path);

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
  await page.fill("#setup-password", "sleepover");
  await page.click("#btn-create");
  await page.waitForFunction(() => {
    const el = document.getElementById("room-code");
    return el && el.textContent && el.textContent.length >= 8;
  });
  return page.locator("#room-code").innerText();
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

    await page.type("#setup-password", "sleepover", { delay: 50 });
    await page.click("#btn-create");

    await page.waitForSelector("#room-code");
    await page.waitForFunction(() => {
      const el = document.getElementById("room-code");
      return el && el.textContent && el.textContent.length >= 8;
    });

    const roomCode = await page.locator("#room-code").innerText();
    expect(roomCode).toMatch(/^[a-z0-9]{8}$/);

    await assertScreenshot(page, "02-room-created");
  });
});

// --- Phase 2: Friends Join + Chat ---

describe("Demo reel: Friends Join + Chat", () => {
  it("WS clients join and chat messages appear in browser", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    await waitForMembers(page, 3);

    // Browser chat first (so we can assert cleanly on priya)
    await page.fill("#msg-input", "welcome to the sleepover 🌙");
    await page.click("#btn-send");

    const msg = await priya.waitFor("message");
    expect(msg.from).toBe("luna");
    expect(msg.text).toBe("welcome to the sleepover 🌙");

    // WS chat appears in browser
    chat(javi, "hey everyone!! 🏰");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("hey everyone");
    });

    chat(priya, "love the fort name!");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("love the fort");
    });

    await assertScreenshot(page, "03-chat-room");
  });
});

// --- Phase 3: Drawing ---

describe("Demo reel: Drawing", () => {
  it("draw strokes appear on canvas while chat is open", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");

    const canvas = page.locator("#game-canvas");
    expect(await canvas.count()).toBe(1);

    // WS draw works — broadcast excludes sender, so check on priya
    draw(javi, "#FF0000", [
      [300, 400], [350, 350], [400, 320], [450, 350], [500, 400],
    ]);

    const drawMsg = await priya.waitFor("draw");
    expect(drawMsg.color).toBe("#FF0000");
    expect(drawMsg.pts).toHaveLength(5);

    // Add more strokes for a richer snapshot
    draw(priya, "#0000FF", [
      [600, 500], [650, 400], [700, 500], [750, 400], [800, 500],
    ]);
    await sleep(200);

    await assertScreenshot(page, "04-drawing");
  });
});

// --- Phase 4: Tic-Tac-Toe ---

describe("Demo reel: Tic-Tac-Toe", () => {
  it("luna challenges javi via UI, javi accepts via WS, luna wins", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    await waitForMembers(page, 2);

    await page.click("#aim-btn-ttt");
    await page.waitForSelector("#member-picker-overlay.open");
    await assertScreenshot(page, "05-ttt-member-picker");

    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();

    await javi.waitFor("ttt-challenged");
    tttAccept(javi);

    await page.waitForSelector("#ttt-board");
    await page.waitForSelector(".ttt-cell");
    const cells = page.locator(".ttt-cell");
    expect(await cells.count()).toBe(9);

    await assertScreenshot(page, "06-ttt-board-empty");

    // luna(4), javi(0), luna(2), javi(6), luna(5), javi(3), luna(8)
    await cells.nth(4).click();
    await javi.waitFor("ttt-update");
    tttMove(javi, 0);
    await page.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 1);

    await cells.nth(2).click();
    await javi.waitFor("ttt-update");
    tttMove(javi, 6);
    await page.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 2);

    await cells.nth(5).click();
    await javi.waitFor("ttt-update");
    tttMove(javi, 3);
    await page.waitForFunction(() => document.querySelectorAll(".ttt-cell.o").length === 3);

    await cells.nth(8).click(); // luna wins!

    await page.waitForFunction(() => {
      const el = document.getElementById("ttt-status");
      return el && el.textContent && (el.textContent.includes("win") || el.textContent.includes("Win"));
    }, { timeout: 5000 });

    await assertScreenshot(page, "07-ttt-luna-wins");
  });
});

// --- Phase 5: Saboteur ---

describe("Demo reel: Saboteur", () => {
  it("saboteur starts with 4 players, role reveal happens", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    await page.click("#aim-btn-sab");

    const roles = await Promise.all([
      javi.waitFor("sab-role", 5000),
      priya.waitFor("sab-role", 5000),
      kai.waitFor("sab-role", 5000),
    ]);

    const sabCount = roles.filter(r => r.role === "saboteur").length;
    expect(sabCount).toBeLessThanOrEqual(1);

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

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    await waitForMembers(page, 3);

    await page.click("#aim-btn-vote");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();

    await page.waitForSelector("#vote-banner.visible", { timeout: 5000 });
    await assertScreenshot(page, "09-vote-banner");

    castVote(priya, "yes");

    const ejected = await javi.waitFor("ejected", 5000);
    expect(ejected.reason).toContain("voted out");

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

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    await waitForMembers(page, 3);

    await page.click("#aim-btn-toss");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    const offer = await priya.waitFor("host-offer", 5000);
    expect(offer.oldHost).toBe("luna");
    priya.send({ type: "accept-host" });

    const newHost = await javi.waitFor("new-host", 5000);
    expect(newHost.name).toBe("priya");

    await sleep(300);
    await assertScreenshot(page, "11-host-transferred");
  });
});

// --- Phase 8: Knock Down ---

describe("Demo reel: Knock Down", () => {
  it("new host (priya via WS) knocks down the fort", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const priya = await wsJoinTracked(roomCode, "priya");
    await waitForMembers(page, 2);

    await page.click("#aim-btn-toss");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    await priya.waitFor("host-offer", 5000);
    priya.send({ type: "accept-host" });

    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("priya");
    }, { timeout: 5000 });

    knockDown(priya);

    await page.waitForSelector("#btn-home", { state: "visible", timeout: 5000 });
    await assertScreenshot(page, "12-knocked-down");
  });
});
