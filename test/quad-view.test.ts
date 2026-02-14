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

const PASSWORD = "test123";

async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${getPort()}/`);
  return page;
}

async function createFort(page: Page, name: string): Promise<string> {
  await page.fill("#name-input", name);
  await page.click("#btn-setup");
  await page.fill("#setup-password", PASSWORD);
  await page.click("#btn-create");
  await page.waitForSelector("#room-code");
  await page.waitForFunction(() => {
    const el = document.getElementById("room-code");
    return el && el.textContent && el.textContent.length >= 8;
  });
  return page.locator("#room-code").innerText();
}

async function joinFort(page: Page, code: string, name: string): Promise<void> {
  await page.fill("#name-input", name);
  await page.click("#btn-join");
  await page.fill("#join-room", code);
  await page.fill("#join-password", PASSWORD);
  await page.click("#btn-enter");
  await page.waitForSelector("#messages");
}

async function waitForMembers(page: Page, count: number) {
  await page.waitForFunction(
    (n) => {
      const el = document.getElementById("member-count");
      return el && el.textContent && el.textContent.includes(`${n} inside`);
    },
    count,
    { timeout: 10000 },
  );
}

async function pickMember(page: Page, name: string): Promise<void> {
  await page.waitForSelector("#member-picker-overlay.open");
  await page.locator(".member-picker-item", { hasText: name }).click();
}

/** Set up all 4 players: luna creates, javi/priya/kai join */
async function setupFourPlayers(): Promise<[Page, Page, Page, Page]> {
  const luna = await newPage();
  const code = await createFort(luna, "luna");

  const javi = await newPage();
  await joinFort(javi, code, "javi");

  const priya = await newPage();
  await joinFort(priya, code, "priya");

  const kai = await newPage();
  await joinFort(kai, code, "kai");

  // Wait for all 4 to see each other
  for (const p of [luna, javi, priya, kai]) {
    await waitForMembers(p, 4);
  }

  return [luna, javi, priya, kai];
}

// --- tests ---

describe("V9 Quad View - 4-browser choreography", () => {
  it("Phase 1: Roll Call — 4 players join via browser UI", async () => {
    const [luna, javi, priya, kai] = await setupFourPlayers();

    // All 4 should see "4 inside"
    for (const p of [luna, javi, priya, kai]) {
      const text = await p.locator("#member-count").innerText();
      expect(text).toContain("4 inside");
    }

    // luna sends a message visible to all
    await luna.fill("#msg-input", "everyone here? 🏰");
    await luna.click("#btn-send");

    for (const p of [javi, priya, kai]) {
      await p.waitForFunction(() => {
        const msgs = document.getElementById("messages");
        return msgs && msgs.textContent && msgs.textContent.includes("everyone here?");
      }, { timeout: 5000 });
    }
  });

  it("Phase 2: Chat Showcase — styled messages from each browser", async () => {
    const [luna, javi, priya, kai] = await setupFourPlayers();

    // javi: bold message
    await javi.click("#fmt-bold");
    await javi.fill("#msg-input", "let's goooo");
    await javi.click("#btn-send");
    await javi.click("#fmt-bold");

    // priya: italic message
    await priya.click("#fmt-italic");
    await priya.fill("#msg-input", "this is so cozy");
    await priya.click("#btn-send");
    await priya.click("#fmt-italic");

    // kai: emojis
    await kai.fill("#msg-input", "😊🔥🎉");
    await kai.click("#btn-send");

    // luna: plain message
    await luna.fill("#msg-input", "welcome to the fort ✨");
    await luna.click("#btn-send");

    // All messages visible on luna's screen
    await luna.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      if (!msgs) return false;
      const text = msgs.textContent || "";
      return (
        text.includes("let's goooo") &&
        text.includes("this is so cozy") &&
        text.includes("😊🔥🎉") &&
        text.includes("welcome to the fort")
      );
    }, { timeout: 5000 });
  });

  it("Phase 3: RPS Showdown — luna vs javi, both see overlay", async () => {
    const [luna, javi, priya, kai] = await setupFourPlayers();

    // luna challenges javi
    await luna.click("#aim-btn-rps");
    await pickMember(luna, "javi");

    // javi sees and accepts
    await javi.waitForSelector("#rps-overlay.open");
    await javi.click("#rps-actions .xp-btn-primary");

    // Both see pick buttons
    await luna.waitForSelector(".rps-pick");
    await javi.waitForSelector(".rps-pick");

    // luna picks rock, javi picks scissors
    await luna.locator(".rps-pick").first().click();
    await javi.locator(".rps-pick").last().click();

    // Both see result
    await luna.waitForSelector("#rps-result-text:not([style*='display: none'])", { timeout: 5000 });
    await javi.waitForSelector("#rps-result-text:not([style*='display: none'])", { timeout: 5000 });

    const result = await luna.locator("#rps-result-text").innerText();
    expect(result).toContain("wins");

    // Dismiss overlays
    await luna.click("#rps-actions .xp-btn");
    await javi.click("#rps-actions .xp-btn");

    // priya can chat while spectating
    await priya.fill("#msg-input", "ooooh 🔥");
    await priya.click("#btn-send");

    await luna.waitForFunction(() => {
      const msgs = document.getElementById("messages");
      return msgs && msgs.textContent && msgs.textContent.includes("ooooh");
    }, { timeout: 5000 });
  });

  it("Phase 4: Saboteur — all 4 see role reveal and vote", async () => {
    const [luna, javi, priya, kai] = await setupFourPlayers();

    // luna starts saboteur
    await luna.click("#aim-btn-sab");

    // All 4 should see the vote overlay
    await Promise.all(
      [luna, javi, priya, kai].map((p) =>
        p.waitForSelector("#sab-vote-banner.visible", { timeout: 10000 }),
      ),
    );

    // Each player votes (luna→javi, javi→kai, priya→javi, kai→luna)
    await luna.locator("#sab-vote-list .member-picker-item", { hasText: "javi" }).click();
    await javi.locator("#sab-vote-list .member-picker-item", { hasText: "kai" }).click();
    await priya.locator("#sab-vote-list .member-picker-item", { hasText: "javi" }).click();
    await kai.locator("#sab-vote-list .member-picker-item", { hasText: "luna" }).click();

    // Vote overlay should close on all 4
    await Promise.all(
      [luna, javi, priya, kai].map((p) =>
        p.waitForFunction(
          () => {
            const el = document.getElementById("sab-vote-banner");
            return el && !el.classList.contains("visible");
          },
          { timeout: 35000 },
        ),
      ),
    );
  });

  it("Phase 5: Knock Down — all 4 see destruction", async () => {
    const [luna, javi, priya, kai] = await setupFourPlayers();

    // luna clicks knock down (she's the host)
    await luna.click("#btn-knock-down");

    // All 4 should see the btn-home (knocked down screen)
    await Promise.all(
      [luna, javi, priya, kai].map((p) =>
        p.waitForSelector("#btn-home", { state: "visible", timeout: 5000 }),
      ),
    );
  });
});
