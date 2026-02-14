/**
 * Tests that the V7 "Game Night" capture choreography works against the real UI.
 * Mirrors video/capture/scenes/capture-v7-game-night.ts but with assertions.
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
import {
  connect, joinRoom as wsJoin, chat, draw, sleep,
  rpsAccept, rpsPick, kothChallenge, knockDown,
  type Client,
} from "../video/capture/ws-client";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/game-night";
const PIXEL_THRESHOLD = 0.005;
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
  const client = await wsJoin(getPort(), roomCode, name, "gamers");
  clients.push(client);
  return client;
}

async function maskDynamic(page: Page) {
  await page.evaluate(() => {
    const rc = document.getElementById("room-code");
    if (rc) rc.textContent = "abc12345";
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
  await page.fill("#setup-password", "gamers");
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

// --- Phase 1: Arrival ---

describe("Game night: Arrival", () => {
  it("luna creates fort, 3 friends join, banter flows", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    chat(javi, "game night lets gooo 🎮");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("game night");
    });

    chat(priya, "finally!! who's ready to lose", { bold: true });
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("ready to lose");
    });

    chat(kai, "big talk from someone who lost last time 😏");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("big talk");
    });

    // Luna chats via browser
    await page.fill("#msg-input", "ok ok calm down...");
    await page.click("#btn-send");

    // Drain any earlier chat messages that arrived before luna's
    let lunaMsg: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await kai.waitFor("message");
      if (msg.from === "luna") { lunaMsg = msg; break; }
    }
    expect(lunaMsg).not.toBeNull();
    expect(lunaMsg.from).toBe("luna");

    // Toggle bold, send
    await page.click("#fmt-bold");
    await page.fill("#msg-input", "first challenge: RPS");
    await page.click("#btn-send");
    await page.click("#fmt-bold");

    let boldMsg: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await kai.waitFor("message");
      if (msg.text === "first challenge: RPS") { boldMsg = msg; break; }
    }
    expect(boldMsg).not.toBeNull();
    expect(boldMsg.style?.bold).toBe(true);

    await assertScreenshot(page, "01-arrival-chat");
  });
});

// --- Phase 2: RPS Duels ---

describe("Game night: RPS Duels", () => {
  it("luna vs kai (luna loses), luna vs priya (luna wins)", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    // Duel 1: luna challenges kai
    await page.click("#aim-btn-rps");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "kai" }).click();

    await kai.waitFor("rps-challenged");
    rpsAccept(kai);

    await page.waitForSelector("#rps-overlay.open");
    await page.waitForSelector(".rps-pick");

    // luna picks scissors
    await page.locator(".rps-pick[title='scissors']").click();
    // kai picks rock → kai wins
    rpsPick(kai, "rock");

    // Wait for result
    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, { timeout: 5000 });

    await assertScreenshot(page, "02-rps-kai-wins");

    // Dismiss
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await sleep(300);

    // Duel 2: luna challenges priya
    await page.click("#aim-btn-rps");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    await priya.waitFor("rps-challenged");
    rpsAccept(priya);

    await page.waitForSelector("#rps-overlay.open");
    await page.waitForSelector(".rps-pick");

    // luna picks rock
    await page.locator(".rps-pick[title='rock']").click();
    // priya picks scissors → luna wins
    rpsPick(priya, "scissors");

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, { timeout: 5000 });

    await assertScreenshot(page, "03-rps-luna-wins");

    // Dismiss
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
  });
});

// --- Phase 3: Canvas + Breakout ---

describe("Game night: Canvas + Breakout", () => {
  it("draw strokes appear, chat minimize/maximize works", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");

    const canvas = page.locator("#game-canvas");
    expect(await canvas.count()).toBe(1);

    // WS draw strokes (visible on canvas behind chat)
    draw(javi, "#FF0000", [
      [400, 350], [420, 300], [460, 280], [500, 300], [500, 350],
    ]);
    const drawMsg = await priya.waitFor("draw");
    expect(drawMsg.color).toBe("#FF0000");

    draw(priya, "#0000FF", [
      [700, 400], [750, 300], [800, 400], [850, 300], [900, 400],
    ]);
    await sleep(200);

    draw(kai, "#FFD700", [
      [1100, 300], [1130, 380], [1200, 380], [1145, 420],
      [1165, 500], [1100, 450], [1035, 500],
    ]);
    await sleep(200);

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

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    // kai sends KOTH challenge
    kothChallenge(kai);

    // luna's browser shows RPS overlay for KOTH
    await page.waitForSelector("#rps-overlay.open", { timeout: 5000 });
    await page.waitForSelector(".rps-pick");

    await assertScreenshot(page, "06-koth-rps-overlay");

    // luna picks paper
    await page.locator(".rps-pick[title='paper']").click();
    // kai picks scissors → kai wins
    rpsPick(kai, "scissors");

    // Wait for result
    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, { timeout: 5000 });

    await assertScreenshot(page, "07-koth-kai-wins");

    // Dismiss overlay
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await sleep(300);

    // Verify kai is new host — koth-result broadcast
    const kothResult = await javi.waitFor("koth-result", 5000);
    expect(kothResult.winner).toBe("kai");

    // Verify host transfer happened via new-host broadcast
    const newHost = await javi.waitFor("new-host", 5000);
    expect(newHost.name).toBe("kai");
  });
});

// --- Phase 5: Knock Down ---

describe("Game night: Knock Down", () => {
  it("kai (new host via KOTH) knocks down the fort", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    // kai challenges and wins KOTH to become host
    kothChallenge(kai);
    await page.waitForSelector("#rps-overlay.open", { timeout: 5000 });
    await page.waitForSelector(".rps-pick");

    // luna picks paper, kai picks scissors → kai wins
    await page.locator(".rps-pick[title='paper']").click();
    rpsPick(kai, "scissors");

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, { timeout: 5000 });

    // Dismiss overlay
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await sleep(500);

    // Farewell chat
    chat(kai, "thanks everyone. this was perfect.");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("this was perfect");
    });

    await page.fill("#msg-input", "goodnight everybody 💤");
    await page.click("#btn-send");
    await sleep(300);

    chat(priya, "🌙✨");
    await sleep(200);
    chat(javi, "night night");
    await sleep(300);

    // kai (new host) knocks down
    knockDown(kai);

    await page.waitForSelector("#btn-home", { state: "visible", timeout: 5000 });
    await assertScreenshot(page, "08-knocked-down");
  });
});
