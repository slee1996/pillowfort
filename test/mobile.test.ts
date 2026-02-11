import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startServer, stopServer, getPort } from "./helpers";

let browser: Browser;
const contexts: BrowserContext[] = [];

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

async function mobilePage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${getPort()}/`);
  return page;
}

async function createFort(page: Page, name: string): Promise<string> {
  await page.fill("#name-input", name);
  await page.click("#btn-setup");
  await page.fill("#setup-password", "test123");
  await page.click("#btn-create");
  await page.waitForSelector("#room-code");
  // room-code text gets set asynchronously after ws response
  await page.waitForFunction(() => {
    const el = document.getElementById("room-code");
    return el && el.textContent && el.textContent.length >= 6;
  });
  return page.locator("#room-code").innerText();
}

async function joinFort(page: Page, code: string, name: string): Promise<void> {
  await page.fill("#name-input", name);
  await page.click("#btn-join");
  await page.fill("#join-room", code);
  await page.fill("#join-password", "test123");
  await page.click("#btn-enter");
  await page.waitForSelector("#messages");
}

async function pickMember(page: Page, name: string): Promise<void> {
  await page.waitForSelector("#member-picker-overlay.open");
  const item = page.locator(".member-picker-item", { hasText: name });
  await item.click();
}

// --- tests ---

describe("Mobile E2E", () => {
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
    await joinFort(bob, code, "bob");
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
    await bob.click("#rps-actions .xp-btn-primary"); // Accept button

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
    await joinFort(bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    // Alice challenges Bob to TTT
    await alice.click("#aim-btn-ttt");
    await pickMember(alice, "bob");

    // Bob accepts
    await bob.waitForSelector("#ttt-overlay.open");
    await bob.click("#ttt-actions .xp-btn-primary");

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
    }, { timeout: 5000 });

    const status = await alice.locator("#ttt-status").innerText();
    expect(status.toLowerCase()).toContain("win");
  });

  it("vote banner on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(bob, code, "bob");
    const carol = await mobilePage();
    await joinFort(carol, code, "carol");

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
    await carol.click("#vote-yes");

    // Vote resolves — banner disappears on alice's screen
    await alice.waitForFunction(() => {
      const el = document.getElementById("vote-banner");
      return el && !el.classList.contains("visible");
    }, { timeout: 5000 });
  });

  it("member picker touch targets", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(bob, code, "bob");
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
    await page.waitForSelector("#game-canvas", { state: "visible" });

    const canvas = page.locator("#game-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    // Canvas should fill most of the 375px viewport width
    expect(box!.width).toBeGreaterThanOrEqual(300);
  });

  it("RPS picks are properly sized on mobile", async () => {
    const alice = await mobilePage();
    const code = await createFort(alice, "alice");
    const bob = await mobilePage();
    await joinFort(bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    await alice.click("#aim-btn-rps");
    await pickMember(alice, "bob");

    await bob.waitForSelector("#rps-overlay.open");
    await bob.click("#rps-actions .xp-btn-primary");

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
    await joinFort(bob, code, "bob");
    await alice.waitForFunction(() => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes("2");
    });

    await alice.click("#aim-btn-ttt");
    await pickMember(alice, "bob");

    await bob.waitForSelector("#ttt-overlay.open");
    await bob.click("#ttt-actions .xp-btn-primary");

    // Wait for board to render
    await alice.waitForSelector(".ttt-cell");

    const cells = alice.locator(".ttt-cell");
    const count = await cells.count();
    expect(count).toBe(9);
    for (let i = 0; i < count; i++) {
      const box = await cells.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThanOrEqual(65);
      expect(box!.height).toBeGreaterThanOrEqual(65);
    }
  });
});
