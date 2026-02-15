import { mkdir } from "fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";
import { startServer, stopServer, getPort } from "./helpers";
import { chat, joinRoom, sleep, type Client } from "../video/capture/ws-client";

const SNAPSHOT_DIR = import.meta.dir + "/__snapshots__/design";
const PIXEL_THRESHOLD = 0.005;
const COLOR_THRESHOLD = 25;
const BASE_URL = process.env.PF_BASE_URL;

let browser: Browser;
const contexts: BrowserContext[] = [];
const clients: Client[] = [];

function activePort() {
  if (!BASE_URL) return getPort();
  const parsed = new URL(BASE_URL);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

beforeAll(async () => {
  if (!BASE_URL) await startServer();
  browser = await chromium.launch();
  await mkdir(SNAPSHOT_DIR, { recursive: true });
}, 30_000);

afterEach(async () => {
  for (const c of clients) {
    try { await c.close(); } catch {}
  }
  clients.length = 0;

  for (const ctx of contexts) {
    try { await ctx.close(); } catch {}
  }
  contexts.length = 0;
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (!BASE_URL) await stopServer();
}, 30_000);

async function newPage(viewport = { width: 1366, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(BASE_URL || `http://localhost:${getPort()}/`);
  return page;
}

async function maskDynamic(page: Page) {
  await page.evaluate(() => {
    const rc = document.getElementById("room-code");
    if (rc) rc.textContent = "abc12345";
    document.querySelectorAll(".chat-timestamp").forEach((el) => {
      (el as HTMLElement).textContent = " (12:00)";
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
    if (dr > COLOR_THRESHOLD || dg > COLOR_THRESHOLD || db > COLOR_THRESHOLD) diffCount++;
  }

  const diffRatio = diffCount / totalPixels;
  if (diffRatio > PIXEL_THRESHOLD) {
    await Bun.write(`${SNAPSHOT_DIR}/${name}.actual.png`, screenshotBuf);
    expect(diffRatio).toBeLessThanOrEqual(PIXEL_THRESHOLD);
  }
}

async function createFort(page: Page, name = "luna", password = "design"): Promise<string> {
  await page.fill("#name-input", name);
  await page.click("#btn-setup");
  await page.fill("#setup-password", password);
  await page.click("#btn-create");
  await page.waitForFunction(() => {
    const el = document.getElementById("room-code");
    return !!el && !!el.textContent && el.textContent.length >= 8;
  });
  return page.locator("#room-code").innerText();
}

describe("Design snapshots", () => {
  it("home screen desktop", async () => {
    const page = await newPage();
    await page.waitForSelector("#name-input");
    await assertScreenshot(page, "home-desktop");
  }, 30_000);

  it("setup screen desktop", async () => {
    const page = await newPage();
    await page.fill("#name-input", "luna");
    await page.click("#btn-setup");
    await page.waitForSelector("#setup-password");
    await assertScreenshot(page, "setup-desktop");
  }, 30_000);

  it("join screen desktop", async () => {
    const page = await newPage();
    await page.fill("#name-input", "luna");
    await page.click("#btn-join");
    await page.waitForSelector("#join-room");
    await assertScreenshot(page, "join-desktop");
  }, 30_000);

  it("chat screen desktop", async () => {
    const page = await newPage();
    const roomCode = await createFort(page);

    const javi = await joinRoom(activePort(), roomCode, "javi", "design");
    clients.push(javi);
    chat(javi, "we made it in");

    await page.waitForFunction(() => {
      const count = document.getElementById("member-count");
      const msgs = document.getElementById("messages");
      return !!count?.textContent?.includes("2") && !!msgs?.textContent?.includes("made it in");
    });

    await page.fill("#msg-input", "locking in the layout");
    await page.click("#btn-send");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return !!msgs?.textContent?.includes("locking in the layout");
    });

    await assertScreenshot(page, "chat-desktop");
  }, 30_000);

  it("chat screen mobile", async () => {
    const page = await newPage({ width: 390, height: 844 });
    await createFort(page, "luna", "design");
    await page.fill("#msg-input", "mobile baseline");
    await page.click("#btn-send");
    await page.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return !!msgs?.textContent?.includes("mobile baseline");
    });
    await assertScreenshot(page, "chat-mobile");
  }, 30_000);
});
