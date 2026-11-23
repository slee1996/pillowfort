// Run with Bun against a fresh production build. No exposed test route, synthetic state or patched browser APIs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, firefox, webkit, type Page } from "playwright";
import { startLocalServer } from "../../server";
import { createRoomInvitationUrl } from "../../src/participant/roomInvitation";

const engines = { chromium, firefox, webkit };
type Engine = keyof typeof engines;
const target = process.argv[2];
if (!target) throw Error("Usage: bun verification/app/browsers.ts OUTPUT [HOST_ENGINE|all] [retoss]");
const pairs: [Engine, Engine][] = [
  ["chromium", "firefox"],
  ["firefox", "webkit"],
  ["webkit", "chromium"],
];
const retoss = process.argv[4] === "retoss";
const runs: object[] = [];
const server = startLocalServer(0),
  origin = `http://127.0.0.1:${server.port}`;
const messages = (p: Page, text: string) =>
  p.locator("#messages .chat-content").getByText(text, { exact: true });
async function send(page: Page, text: string) {
  await page.locator("#msg-input").fill(text);
  await page.locator("#btn-send").click();
}
async function menu(p: Page) {
  await p.locator("#btn-room-menu").click();
}
async function member(p: Page, name: string) {
  await p.locator("#member-picker-body .member-picker-item").filter({ hasText: name }).click();
}
async function end(p: Page) {
  await menu(p);
  await p.locator("#btn-knock-down").click();
  await p.locator("#btn-confirm-room-exit").click();
}
async function untilVisible(p: Page, selector: string) {
  await p.locator(selector).first().waitFor();
}

try {
  for (const [a, b] of pairs.filter(
    ([host]) => !process.argv[3] || process.argv[3] === "all" || host === process.argv[3],
  )) {
    const hostBrowser = await engines[a].launch(),
      peerBrowser = await engines[b].launch();
    const hc = await hostBrowser.newContext(
      a === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {},
    );
    const pc = await peerBrowser.newContext({ viewport: { width: 390, height: 844 } });
    const host = await hc.newPage(),
      guest = await pc.newPage();
    host.setDefaultTimeout(20_000);
    guest.setDefaultTimeout(20_000);
    host.setDefaultNavigationTimeout(45_000);
    guest.setDefaultNavigationTimeout(45_000);
    const relayErrors: string[] = [];
    for (const [role, p] of [
      ["host", host],
      ["guest", guest],
    ] as const)
      p.on("websocket", (ws) =>
        ws.on("framereceived", ({ payload }) => {
          if (typeof payload !== "string") return;
          const f = JSON.parse(payload);
          if (f.type === "error" && /^[a-z-]{1,40}$/.test(f.code)) relayErrors.push(role + ": " + f.code);
        }),
      );
    let at = "entry";
    const passed: string[] = [];
    const errors: string[] = [];
    const run = {
      host: a,
      guest: b,
      retoss,
      versions: [hostBrowser.version(), peerBrowser.version()],
      passed,
      errors,
    };
    runs.push(run);
    const step = async (name: string, f: () => Promise<void>) => {
      at = name;
      await f();
      passed.push(name);
    };
    let room = "",
      secret = "",
      invite = "";
    const authModes: string[] = [];
    const devices = new Set<string>();
    guest.on("websocket", (s) =>
      s.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        const x = JSON.parse(payload);
        if (x.kind === "secure-authenticate") {
          authModes.push(x.mode);
          devices.add(x.frame.deviceId ?? x.frame.hello?.deviceId);
        }
      }),
    );
    try {
      await step("create and retain own password", async () => {
        await host.goto(origin, { waitUntil: "domcontentloaded" });
        await host.locator("#name-input").fill("Harper");
        await host.locator("#btn-setup").click();
        if (a === "firefox") {
          await host.locator("#password-options > summary").click();
          await host.locator("#btn-custom-secret").click();
          await host.locator("#setup-password").fill("maple " + crypto.randomUUID());
        }
        secret = await host.locator("#setup-password").inputValue();
        if (a !== "firefox") assert(/^pf3_[\w-]{22}$/.test(secret));
        await host.locator("#btn-create").click();
        const manual = host.getByRole("dialog", { name: "Copy manually", exact: true });
        await host.locator("#room-code").or(manual).first().waitFor();
        if (await manual.isVisible()) {
          assert.equal(await manual.getByRole("textbox").inputValue(), secret);
          await manual.getByRole("button", { name: "Close" }).click();
          await host.locator("#setup-secret-saved").check();
          await host.locator("#btn-create").click();
        }
        await host.waitForFunction(() =>
          /^f-[a-z2-7]{10}$/.test(document.querySelector("#room-code")?.textContent ?? ""),
        );
        room = await host.locator("#room-code").innerText();
      });
      await step("private invite and masked password", async () => {
        await host.getByRole("button", { name: "Invite", exact: true }).click();
        await host.getByText("Use a code and password instead", { exact: true }).click();
        assert.equal(await host.locator("#invite-password").getAttribute("type"), "password");
        assert.equal(await host.locator("#invite-password").inputValue(), secret);
        invite = createRoomInvitationUrl(origin, room, secret);
        if (a === "chromium") {
          await host.locator("#btn-copy-invite").click();
          await host.getByText("Link copied. Paste it in a message to your friend.").waitFor();
          assert.equal(await host.evaluate(() => navigator.clipboard.readText()), invite);
        }
        await host.locator("#btn-close-invite").click();
        await send(host, "before membership");
        await messages(host, "before membership").first().waitFor();
      });
      await step("admit and withhold earlier content", async () => {
        await guest.goto(invite, { waitUntil: "domcontentloaded" });
        await untilVisible(guest, "#join-name");
        assert.equal(new URL(guest.url()).hash, "");
        await guest.locator("#join-name").fill("Rowan");
        await guest.locator("#btn-enter").click();
        await host.locator("#btn-approve-admission").click();
        await untilVisible(guest, "#msg-input");
        await host.getByText("Buddies (2)", { exact: true }).waitFor();
        await send(guest, "peer is here");
        await messages(host, "peer is here").first().waitFor();
        assert.equal(await messages(guest, "before membership").count(), 0);
      });
      await step("styled mention while away from chat and private reply", async () => {
        await guest.locator("#btn-open-games").click();
        await guest.locator("#chat-btn-min").click();
        await untilVisible(guest, "#btn-return-room");
        await host.locator("#fmt-bold").click();
        await send(host, "@Rowan ready");
        await guest.getByLabel("1 unread mention", { exact: true }).waitFor();
        await guest.locator("#btn-return-room").click();
        await guest.locator(".chat-message-mentioned b mark").filter({ hasText: "@Rowan" }).waitFor();
        await send(guest, "ready from Rowan");
        await messages(host, "ready from Rowan").first().waitFor();
      });
      await step("away presence reaches the other device", async () => {
        await menu(guest);
        guest.once("dialog", (d) => d.accept("back at noon"));
        await guest.getByRole("button", { name: "Away…", exact: true }).click();
        await untilVisible(host, '.member-entry.is-away[title*="back at noon"]');
        await menu(guest);
        await guest.getByRole("button", { name: "Available", exact: true }).click();
        await host.waitForFunction(() => !document.querySelector(".member-entry.is-away"));
      });
      await step("export transcript and clear only one copy", async () => {
        await menu(guest);
        const transfer = guest.waitForEvent("download");
        await guest.getByRole("button", { name: "Save chat", exact: true }).click();
        const dl = await transfer;
        const file = await dl.path();
        assert(file);
        const transcript = await readFile(file, "utf8");
        assert(
          transcript.includes("ready from Rowan") &&
            !transcript.includes("before membership") &&
            !transcript.includes(secret),
        );
        await menu(guest);
        await guest.getByRole("button", { name: "Clear messages", exact: true }).click();
        await guest.getByText("Messages cleared on this device.", { exact: true }).waitFor();
        assert.equal(await messages(guest, "ready from Rowan").count(), 0);
        assert(await messages(host, "ready from Rowan").first().isVisible());
      });
      await step("reopen stored guest and exchange fresh chat", async () => {
        await guest.goto("about:blank");
        await guest.goto(invite, { waitUntil: "domcontentloaded" });
        await guest.locator("#join-name").waitFor();
        await guest.getByRole("button", { name: /Join fort|Reconnect|Recover/ }).click();
        await untilVisible(guest, "#msg-input");
        await send(guest, "same guest returned");
        await messages(host, "same guest returned").first().waitFor();
        assert(
          authModes.includes("join") &&
            authModes.includes("resume") &&
            devices.size === 1 &&
            !devices.has(undefined as any),
        );
      });
      await step(
        retoss
          ? "refuse, re-offer, then catch without evicting the host"
          : "catch a deliberate handoff without evicting the host",
        async () => {
          for (const choice of retoss ? ["#btn-duck", "#btn-catch"] : ["#btn-catch"]) {
            await menu(host);
            await host.locator("#aim-btn-toss").click();
            await member(host, "Rowan");
            await guest.locator(choice).click();
            await guest.locator("#host-offer-overlay").waitFor({ state: "hidden" });
            if (choice === "#btn-duck") {
              at = "send after declining";
              await send(guest, "not hosting yet");
              await messages(host, "not hosting yet").first().waitFor();
            }
          }
          at = "verify new host controls";
          await menu(guest);
          await untilVisible(guest, "#btn-knock-down");
          await menu(guest);
          at = "send as former host";
          await send(host, "handoff complete");
          await messages(guest, "handoff complete").first().waitFor();
        },
      );
      await step("new host retires the room on both devices", async () => {
        await end(guest);
        await Promise.all(
          [host, guest].map((p) => p.getByText("Fort has been knocked down.", { exact: true }).waitFor()),
        );
      });
    } catch (e) {
      const err = e as Error;
      errors.push(
        `${at}: ${err.name}: ${err.message.split("\n")[0].replace(/https?:\/\/\S+|pf[23]_[\w-]+|f-[a-z2-7]{10}/g, "[private]")}${relayErrors.length ? " (" + relayErrors.join(", ") + ")" : ""}`,
      );
    } finally {
      await Promise.all([hc.close(), pc.close()]);
      await Promise.all([hostBrowser.close(), peerBrowser.close()]);
    }
    console.log(a, b, passed.length, errors);
  }
} finally {
  server.stop(true);
  await writeFile(target, JSON.stringify(runs, null, 2) + "\n");
}
process.exit(!runs.length || runs.some((r) => (r as { errors: string[] }).errors.length) ? 1 : 0);
