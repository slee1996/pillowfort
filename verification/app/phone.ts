import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startLocalServer } from "../../server";

const output = process.argv[2];
if (!output) throw Error("Usage: bun verification/app/phone.ts OUTPUT");
const server = startLocalServer(0);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 812, height: 375 },
  isMobile: true,
  hasTouch: true,
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const result = {} as Record<string, unknown>;
try {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.locator("#name-input").fill("Reader");
  await page.locator("#btn-setup").click();
  await page.locator("#btn-create").click();
  await page.locator("#msg-input").waitFor();
  const cdp = await context.newCDPSession(page);
  async function measure(name: string) {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#msg-input" });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const mentionHelp = String(nodes[0].description?.value ?? "").includes("Mention someone with @name");
    const pixels = await page.locator("#messages").evaluate((x) => x.getBoundingClientRect().height);
    result[name] = { transcriptPixels: pixels, mentionHelpInAccessibilityTree: mentionHelp };
    assert(pixels >= 80 && mentionHelp);
  }
  await measure("812x375");
  await page.setViewportSize({ width: 375, height: 667 });
  // Emulates a software keyboard that leaves the layout viewport unchanged, not a physical IME.
  await page.evaluate(() => {
    const v = window.visualViewport!;
    Object.defineProperty(v, "height", { configurable: true, value: 320 });
    v.dispatchEvent(new Event("resize"));
  });
  await page.waitForSelector("html[data-compact-room]");
  await measure("375x667-visible320");
} finally {
  await browser.close();
  server.stop(true);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(result);
}
process.exit(0);
