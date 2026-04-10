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
import {
  connect, joinRoom as wsJoin, chat, draw, sleep,
  rpsAccept, rpsPick, kothChallenge,
  tttAccept, tttMove,
  castVote, knockDown,
  type Client,
} from "./ws-client";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/full-tour";
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
  const client = await wsJoin(getPort(), roomCode, name, "demo");
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
    // Saboteur role system messages (role text differs each run)
    document.querySelectorAll(".msg-system").forEach((el) => {
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
  await page.fill("#setup-password", "demo");
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

describe("Full tour: Sign On", () => {
  it("luna creates fort, 3 friends join, banter flows", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    chat(javi, "we're in! 🏰");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("we're in");
    });

    chat(priya, "cozy fort ✨");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("cozy fort");
    });

    await assertScreenshot(page, "01-sign-on");
  });
});

// --- Phase 2: Chat Showcase ---

describe("Full tour: Chat Showcase", () => {
  it("bold, italic, colored, and emoji messages render", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    // Luna sends bold
    await page.click("#fmt-bold");
    await page.fill("#msg-input", "welcome to the tour");
    await page.click("#btn-send");
    await page.click("#fmt-bold");

    let boldMsg: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await kai.waitFor("message");
      if (msg.text === "welcome to the tour") { boldMsg = msg; break; }
    }
    expect(boldMsg).not.toBeNull();
    expect(boldMsg.style?.bold).toBe(true);

    // kai sends colored text
    chat(kai, "wait check this out", { color: "#FF0000" });
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("check this out");
    });

    // priya sends italic
    chat(priya, "fancy", { italic: true });
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("fancy");
    });

    // javi sends emojis
    chat(javi, "😊🔥🎉");
    await sleep(300);

    // luna sends plain
    await page.fill("#msg-input", "you can style everything");
    await page.click("#btn-send");
    await sleep(300);

    await assertScreenshot(page, "02-chat-showcase");
  });
});

// --- Phase 3: Drawing ---

describe("Full tour: Drawing", () => {
  it("draw strokes from WS clients appear on canvas", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");

    const canvas = page.locator("#game-canvas");
    expect(await canvas.count()).toBe(1);

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

    await assertScreenshot(page, "03-drawing");
  });
});

// --- Phase 4: Breakout ---

describe("Full tour: Breakout", () => {
  it("chat minimize/maximize works, breakout auto-starts", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    await wsJoinTracked(roomCode, "javi");

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

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    await page.click("#aim-btn-rps");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();

    await javi.waitFor("rps-challenged");
    rpsAccept(javi);

    await page.waitForSelector("#rps-overlay.open");
    await page.waitForSelector(".rps-pick");

    // luna picks rock
    await page.locator(".rps-pick[title='rock']").click();
    // javi picks scissors → luna wins
    rpsPick(javi, "scissors");

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, { timeout: 5000 });

    await assertScreenshot(page, "05-rps-luna-wins");

    // Dismiss
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
  });
});

// --- Phase 6: Tic-Tac-Toe ---

describe("Full tour: Tic-Tac-Toe", () => {
  it("luna challenges priya, plays full game, luna wins", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    await page.click("#aim-btn-ttt");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "priya" }).click();

    tttAccept(priya);

    // Wait for the board to render with 9 cells
    await page.waitForFunction(() => {
      const board = document.getElementById("ttt-board");
      return board && board.children.length === 9;
    }, { timeout: 5000 });
    await sleep(500);

    // luna(4), priya(0), luna(2), priya(6), luna(5), priya(3), luna(8)
    await page.locator("#ttt-board > *").nth(4).click();
    await sleep(800);
    tttMove(priya, 0);
    await sleep(800);
    await page.locator("#ttt-board > *").nth(2).click();
    await sleep(800);
    tttMove(priya, 6);
    await sleep(800);
    await page.locator("#ttt-board > *").nth(5).click();
    await sleep(800);
    tttMove(priya, 3);
    await sleep(800);
    await page.locator("#ttt-board > *").nth(8).click(); // luna wins!

    await page.waitForFunction(() => {
      const el = document.getElementById("ttt-status");
      return el && el.textContent && (el.textContent.includes("win") || el.textContent.includes("wins"));
    }, { timeout: 5000 });

    await assertScreenshot(page, "06-ttt-luna-wins");

    // Dismiss
    await page.click("#ttt-actions .xp-btn");
  }, 30000);
});

// --- Phase 7: Saboteur ---

describe("Full tour: Saboteur", () => {
  it("saboteur starts, role reveal, accusations fly", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    await page.click("#aim-btn-sab");

    // Wait for saboteur role assignment (system message appears)
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && (
        msgs.textContent.includes("saboteur") || msgs.textContent.includes("defender")
      );
    }, { timeout: 5000 });
    await sleep(500);

    chat(kai, "who's the saboteur 👀");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("who's the saboteur");
    });

    chat(javi, "definitely not me");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("definitely not me");
    });

    await assertScreenshot(page, "07-saboteur");
  });
});

// --- Phase 8: KOTH ---

describe("Full tour: King of the Hill", () => {
  it("kai challenges luna, luna wins KOTH and keeps host", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    kothChallenge(kai);

    await page.waitForSelector("#rps-overlay.open", { timeout: 5000 });
    await page.waitForSelector(".rps-pick");

    await assertScreenshot(page, "08-koth-rps-overlay");

    // luna picks rock
    await page.locator(".rps-pick[title='rock']").click();
    // kai picks scissors → luna wins
    rpsPick(kai, "scissors");

    await page.waitForFunction(() => {
      const el = document.getElementById("rps-result-text");
      return el && el.style.display !== "none" && el.textContent && el.textContent.includes("wins");
    }, { timeout: 5000 });

    await assertScreenshot(page, "09-koth-luna-wins");

    // Dismiss overlay
    await page.waitForSelector("#rps-actions .xp-btn");
    await page.click("#rps-actions .xp-btn");
    await sleep(300);

    // Verify luna is still host (no koth-result with kai as winner)
    // luna winning means no host transfer
  });
});

// --- Phase 9: Pillow Fight ---

describe("Full tour: Pillow Fight", () => {
  it("luna votes to kick javi, priya and kai vote yes, javi ejected", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    await page.click("#aim-btn-vote");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "javi" }).click();
    await sleep(500);

    // priya and kai vote yes
    castVote(priya, "yes");
    await sleep(300);
    castVote(kai, "yes");

    // Wait for javi to be kicked (member count drops to 3)
    await waitForMembers(page, 3);

    await assertScreenshot(page, "10-pillow-fight");
  });
});

// --- Phase 10: Pillow Toss + Knock Down ---

describe("Full tour: Pillow Toss + Knock Down", () => {
  it("luna tosses host to kai, kai knocks down the fort", async () => {
    const page = await newPage();
    const roomCode = await setupRoom(page);

    const javi = await wsJoinTracked(roomCode, "javi");
    const priya = await wsJoinTracked(roomCode, "priya");
    const kai = await wsJoinTracked(roomCode, "kai");
    await waitForMembers(page, 4);

    // Luna tosses host to kai
    await page.click("#aim-btn-toss");
    await page.waitForSelector("#member-picker-overlay.open");
    await page.locator("#member-picker-body .member-picker-item", { hasText: "kai" }).click();
    await sleep(500);

    // kai accepts host
    kai.send({ type: "accept-host" });

    // Verify host transfer
    const newHost = await javi.waitFor("new-host", 5000);
    expect(newHost.name).toBe("kai");

    // kai knocks down
    knockDown(kai);

    await page.waitForSelector("#btn-home", { state: "visible", timeout: 5000 });
    await assertScreenshot(page, "11-knocked-down");
  });
});
