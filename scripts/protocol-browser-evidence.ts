import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { startLocalServer } from "../server";
import { createRoomInvitationUrl } from "../src/participant/roomInvitation";

const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("Required: --output DIRECTORY");
const output = resolve(process.argv[outputIndex + 1]);
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? "all" : process.argv[modeIndex + 1];
if (!["all", "benchmark", "faults"].includes(mode)) throw new Error("Mode must be all, benchmark, or faults");
const profileIndex = process.argv.indexOf("--profile");
const selectedProfile = profileIndex < 0 ? null : process.argv[profileIndex + 1];
if (selectedProfile !== null && !["2:0", "3:0", "3:100", "6:0"].includes(selectedProfile)) {
  throw new Error("Profile must be 2:0, 3:0, 3:100, or 6:0");
}
const faultIndex = process.argv.indexOf("--fault");
const selectedFault = faultIndex < 0 ? null : process.argv[faultIndex + 1];
if (selectedFault !== null && !["acceptance-result-unreceived", "removal-before-policy", "permanent-no-policy", "peer-storage"].includes(selectedFault)) {
  throw new Error("Unknown fault scenario");
}
await mkdir(output, { recursive: true });
const report: Record<string, unknown> = {
  scope: "Actual local Bun relay, production browser bundle, WebSockets, MLS and IndexedDB. Not WAN or production capacity.",
  environment: { os: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    memoryBytes: totalmem(), bun: Bun.version, playwright: "1.65.0" },
  benchmarks: [], faults: [], passed: false,
};
const server = startLocalServer(0);
const origin = `http://127.0.0.1:${server.port}`;
let browser: Browser | null = null;
const save = () => writeFile(resolve(output, "browser-results.json"), JSON.stringify(report, null, 2) + "\n");
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const text = (page: Page) => page.locator("body").innerText();

interface Participant { context: BrowserContext; page: Page }
interface RoomEvidence { participants: Participant[]; invitation: string; names: string[] }
type Fault = "acceptance-result-unreceived" | "removal-before-policy" | "permanent-no-policy";

async function newParticipant(browser: Browser): Promise<Participant> {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  if (process.argv.includes("--diagnose")) {
    const session = await context.newCDPSession(page);
    await session.send("Debugger.enable");
    session.on("Debugger.paused", event => {
      if (event.reason === "exception") {
        const exceptions = (report.browserExceptions ??= []) as unknown[];
        if (exceptions.length < 40) exceptions.push({
          description: event.data?.description,
          function: event.callFrames[0]?.functionName,
        });
      }
      void session.send("Debugger.resume").catch(() => {});
    });
    await session.send("Debugger.setPauseOnExceptions", { state: "all" });
  }
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __pillowfortEvidenceActive: boolean;
      __pillowfortEvidenceFrames: Record<string, unknown>[];
      __pillowfortEvidenceMembershipWriteArmed: boolean;
      __pillowfortEvidenceFailMembershipWrite: boolean;
      __pillowfortEvidenceMembershipWriteFailed: boolean;
    };
    state.__pillowfortEvidenceActive = false;
    state.__pillowfortEvidenceFrames = [];
    state.__pillowfortEvidenceMembershipWriteArmed = false;
    state.__pillowfortEvidenceFailMembershipWrite = false;
    state.__pillowfortEvidenceMembershipWriteFailed = false;
    const record = (direction: string, frame: Record<string, any>) => {
      state.__pillowfortEvidenceFrames.push({ direction, kind: frame.kind, type: frame.type,
        code: frame.code, relayKind: frame.relayKind ?? frame.frame?.relayKind,
        order: frame.logicalOrder ?? frame.grant?.logicalOrder,
        messageId: frame.messageId ?? frame.envelope?.messageId ?? frame.frame?.envelope?.messageId });
      if (state.__pillowfortEvidenceFrames.length > 128) state.__pillowfortEvidenceFrames.shift();
    };
    const NativeWebSocket = WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        let ownDevice: string | undefined;
        this.addEventListener("message", event => {
          if (typeof event.data !== "string") return;
          const frame = JSON.parse(event.data);
          record("receive", frame);
          if (state.__pillowfortEvidenceMembershipWriteArmed && frame.type === "relay" &&
              frame.frame?.relayKind === "commit" && frame.frame.admissionId) {
            state.__pillowfortEvidenceFailMembershipWrite = true;
          }
          if (frame.type === "authenticated") {
            ownDevice = frame.deviceId;
            state.__pillowfortEvidenceActive = frame.status === "active";
          }
          if (frame.type === "member-lifecycle" && frame.deviceId === ownDevice) {
            state.__pillowfortEvidenceActive = frame.status === "active";
          }
        });
        this.addEventListener("close", event => record("close", { kind: event.reason, code: event.code }));
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === "string") record("send", JSON.parse(data));
        super.send(data);
      }
    };
  });
  return { context, page };
}
async function setupRoom(browser: Browser, count: number, configure?: (participant: Participant, index: number) => Promise<void>): Promise<RoomEvidence> {
  const participants: Participant[] = [];
  const names = Array.from({ length: count }, (_, i) => i === 0 ? "Evidence Host" : `Evidence Guest ${i}`);
  const host = await newParticipant(browser);
  participants.push(host);
  await configure?.(host, 0);
  await host.page.goto(origin);
  await host.page.locator("input").fill(names[0]);
  await host.page.getByRole("button", { name: "Start a new fort", exact: true }).click();
  const secret = await host.page.locator("#setup-password").inputValue();
  await host.page.getByRole("button", { name: "Copy password & create fort", exact: true }).click();
  await host.page.getByRole("textbox", { name: "Message", exact: true }).waitFor().catch(async error => {
    report.setupFailure = await text(host.page);
    await host.page.screenshot({ path: resolve(output, "setup-failure.png"), fullPage: true });
    throw error;
  });
  const roomId = (await text(host.page)).match(/\bf-[a-z2-7]{10}\b/)?.[0];
  if (!roomId) throw new Error("Generated room code not visible");
  const invitation = createRoomInvitationUrl(origin, roomId, secret);
  for (let i = 1; i < count; i++) {
    const guest = await newParticipant(browser);
    participants.push(guest);
    await configure?.(guest, i);
    await guest.page.goto(invitation);
    await guest.page.locator("#join-name").fill(names[i]);
    await guest.page.getByRole("button", { name: "Join fort", exact: true }).click();
    await host.page.getByRole("button", { name: "Approve", exact: true }).click({ timeout: 20_000 });
    await guest.page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 20_000 });
    await guest.page.waitForFunction(() =>
      (globalThis as typeof globalThis & { __pillowfortEvidenceActive: boolean }).__pillowfortEvidenceActive,
      undefined, { timeout: 20_000 });
    await host.page.getByText(`Buddies (${i + 1})`, { exact: true }).waitFor();
    await wait(250);
  }
  return { participants, invitation, names };
}
async function closeRoom(room: RoomEvidence) {
  await Promise.all(room.participants.map(p => p.context.close()));
}
async function deliver(sender: Page, receiver: Page, marker: string) {
  await sender.getByRole("textbox", { name: "Message", exact: true }).fill(marker);
  const start = performance.now();
  await sender.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
  await receiver.waitForFunction(marker => document.body.innerText.includes(marker), marker, { timeout: 15_000 });
  return performance.now() - start;
}
function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1];
}
async function benchmark(browser: Browser, members: number, previewDelayMs: number) {
  let previews = 0;
  const room = await setupRoom(browser, members, async ({ page }, index) => {
    if (index !== 0) return;
    let closed = false;
    page.on("close", () => { closed = true; });
    await page.routeWebSocket("**", socket => {
      const remote = socket.connectToServer();
      socket.onMessage(message => remote.send(message));
      remote.onMessage(message => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "application-preview") {
          previews++;
          if (previewDelayMs) { setTimeout(() => { if (!closed) socket.send(message); }, previewDelayMs); return; }
        }
        socket.send(message);
      });
    });
  });
  try {
    const host = room.participants[0].page;
    const guest = room.participants[1].page;
    await deliver(guest, host, `warmup-${members}-${previewDelayMs}`);
    const samples: number[] = [];
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      samples.push(await deliver(guest, host, `sample-${members}-${previewDelayMs}-${i}`));
      await wait(500); // Closed-loop pacing: never burst to catch up after a scheduler stall.
    }
    const elapsedMs = performance.now() - start;
    if (previews < 20) throw new Error("Benchmark did not exercise host previews");
    return { members, previewDelayMs, samples: samples.length, offeredMessagesPerSecondCeiling: 2,
      deliveredMessagesPerSecond: samples.length * 1000 / elapsedMs, elapsedMs,
      medianMs: percentile(samples, .5), p95Ms: percentile(samples, .95), rawLatencyMs: samples,
      observedHostPreviews: previews,
      measurement: "UI submit to host-recipient DOM application, including grant, durable writes, MLS, preview and rendering. Single outstanding message; 500 ms quiet period after completion; achieved paced throughput, not maximum capacity." };
  } catch (error) {
    report.benchmarkFailure = {
      members, previewDelayMs,
      host: await text(room.participants[0].page),
      sender: await text(room.participants[1].page),
      senderFrames: await room.participants[1].page.evaluate(() =>
        (globalThis as typeof globalThis & { __pillowfortEvidenceFrames: unknown[] }).__pillowfortEvidenceFrames),
    };
    await room.participants[0].page.screenshot({ path: resolve(output, "benchmark-failure.png"), fullPage: true });
    throw error;
  } finally { await closeRoom(room); }
}
async function faultScenario(browser: Browser, fault: Fault) {
  let acceptanceId: string | null = null;
  let held = false;
  let dropIncoming = false;
  let authIdentity: string | null = null;
  const resumeIdentities: string[] = [];
  let resolveHeld!: () => void;
  const boundaryReached = new Promise<void>(done => { resolveHeld = done; });
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    if (index !== 1) return;
    await page.routeWebSocket("**", socket => {
      const remote = socket.connectToServer();
      socket.onMessage(message => {
        const frame = JSON.parse(message.toString());
        if (frame.kind === "secure-authenticate") {
          const device = frame.frame.deviceId ?? frame.frame.hello?.deviceId;
          if (frame.mode === "join") authIdentity = device;
          if (frame.mode === "resume") resumeIdentities.push(device);
        }
        if (frame.authorityEvent?.content.type === "host-succession" && frame.authorityEvent.content.action === "accept") {
          acceptanceId = frame.envelope.messageId;
        }
        if (fault !== "acceptance-result-unreceived" && acceptanceId && !held &&
            frame.authorityEvent?.content.type === "host-succession-policy") {
          held = true;
          resolveHeld();
          return; // Sender state is durable, but the new policy never reaches the relay.
        }
        remote.send(message);
      });
      remote.onMessage(message => {
        const frame = JSON.parse(message.toString());
        if (fault === "acceptance-result-unreceived" && !held && acceptanceId &&
            frame.type === "application-result" && frame.result === "accepted" && frame.messageId === acceptanceId) {
          held = true;
          dropIncoming = true;
          resolveHeld();
          return; // Relay authority is committed; the browser has not received its result.
        }
        if (!dropIncoming) socket.send(message);
      });
    });
  });
  const [host, successor, peer] = room.participants;
  try {
    await deliver(peer.page, host.page, `before-${fault}`);
    await host.page.goto("about:blank");
    await successor.page.locator("#host-offer-overlay").waitFor({ timeout: 140_000 });
    if ((await text(successor.page)).includes("\nHost\n")) throw new Error("Promotion without consent");
    await successor.page.locator("#btn-catch").click();
    await Promise.race([boundaryReached, wait(20_000).then(() => { throw new Error("Crash boundary not reached"); })]);
    if (fault === "permanent-no-policy") {
      await successor.context.close();
      await peer.page.getByText("Fort has been knocked down.", { exact: true }).waitFor({ timeout: 140_000 });
      await peer.page.screenshot({ path: resolve(output, fault + ".png"), fullPage: true });
      return { fault, boundaryReached: held, outcome: "room-retired-after-successor-grace", noOldPolicyReused: true };
    }
    dropIncoming = false;
    await successor.page.goto(room.invitation);
    await successor.page.locator("#join-name").fill(room.names[1]);
    await successor.page.getByRole("button", { name: /Join fort|Reconnect|Recover/ }).click();
    await successor.page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 20_000 });
    await successor.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 20_000 });
    if (!authIdentity || !resumeIdentities.includes(authIdentity)) throw new Error("Successor replaced rather than restored its identity");
    await deliver(peer.page, successor.page, `recovered-${fault}`);
    await deliver(successor.page, peer.page, `response-${fault}`);
    await successor.page.screenshot({ path: resolve(output, fault + ".png"), fullPage: true });
    return { fault, boundaryReached: held, outcome: "same-identity-recovery-and-encrypted-delivery", restoredSameDevice: true };
  } catch (error) {
    const diagnostics = (report.faultDiagnostics ??= []) as unknown[];
    diagnostics.push({ fault, held, acceptanceObserved: acceptanceId !== null,
      successor: successor.page.isClosed() ? "[closed]" : await text(successor.page),
      peer: peer.page.isClosed() ? "[closed]" : await text(peer.page),
      peerFrames: peer.page.isClosed() ? [] : await peer.page.evaluate(() =>
        (globalThis as typeof globalThis & { __pillowfortEvidenceFrames: unknown[] }).__pillowfortEvidenceFrames),
      frames: successor.page.isClosed() ? [] : await successor.page.evaluate(() =>
        (globalThis as typeof globalThis & { __pillowfortEvidenceFrames: unknown[] }).__pillowfortEvidenceFrames) });
    throw new Error(`${fault}: ${String(error)}`);
  } finally { await closeRoom(room); }
}

async function peerStorageFailure(browser: Browser) {
  const room = await setupRoom(browser, 3);
  const [host, sender, failingPeer] = room.participants;
  try {
    await deliver(sender.page, host.page, "before-peer-storage-failure");
    await failingPeer.page.waitForFunction(() => document.body.innerText.includes("before-peer-storage-failure"));
    await failingPeer.page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __pillowfortEvidenceMembershipWriteArmed: boolean;
        __pillowfortEvidenceFailMembershipWrite: boolean;
        __pillowfortEvidenceMembershipWriteFailed: boolean;
      };
      state.__pillowfortEvidenceMembershipWriteArmed = true;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
        if (args[1] === "readwrite" && state.__pillowfortEvidenceFailMembershipWrite) {
          IDBDatabase.prototype.transaction = original;
          state.__pillowfortEvidenceMembershipWriteFailed = true;
          throw new DOMException("Injected membership persistence failure", "QuotaExceededError");
        }
        return Reflect.apply(original, this, args);
      };
    });
    const joiner = await newParticipant(browser);
    room.participants.push(joiner);
    await joiner.page.goto(room.invitation);
    await joiner.page.locator("#join-name").fill("Evidence Late Joiner");
    await joiner.page.getByRole("button", { name: "Join fort", exact: true }).click();
    await host.page.getByRole("button", { name: "Approve", exact: true }).click();
    await joiner.page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 20_000 });
    await failingPeer.page.getByRole("button", { name: "Start a new fort", exact: true }).waitFor({ timeout: 20_000 });
    const injected = await failingPeer.page.evaluate(() =>
      (globalThis as typeof globalThis & { __pillowfortEvidenceMembershipWriteFailed: boolean }).__pillowfortEvidenceMembershipWriteFailed);
    if (!injected) throw new Error("Membership write fault was not exercised");
    if (await failingPeer.page.getByRole("textbox", { name: "Message", exact: true }).count()) {
      throw new Error("Peer continued sending after membership persistence failure");
    }
    await deliver(sender.page, host.page, "remaining-members-after-peer-failure");
    await failingPeer.page.screenshot({ path: resolve(output, "peer-membership-storage-failure.png"), fullPage: true });
    return { fault: "peer-membership-storage-failure", outcome: "affected-peer-failed-closed-other-members-continued",
      scope: "A real IndexedDB write failure during delivery of an Add commit; not proof of automatic repair of arbitrary epoch disagreement." };
  } finally { await closeRoom(room); }
}

try {
  browser = await chromium.launch({ headless: true });
  report.environment = { ...(report.environment as object), chromium: browser.version() };
  if (mode !== "faults") {
    for (const [members, delay] of [[2, 0], [3, 0], [3, 100], [6, 0]]) {
      if (selectedProfile !== null && selectedProfile !== `${members}:${delay}`) continue;
      const result = await benchmark(browser, members, delay);
      (report.benchmarks as unknown[]).push(result);
      await save();
      console.log(JSON.stringify(result));
    }
  }
  if (mode !== "benchmark") {
    if (mode === "all") await wait(60_000); // Respect the normal five-new-rooms/minute ceiling.
    const faults: Fault[] = ["acceptance-result-unreceived", "removal-before-policy", "permanent-no-policy"];
    // Separate rooms overlap only the real 120-second disconnect grace, not model inference.
    const results: unknown[] = await Promise.all(faults.filter(fault => selectedFault === null || fault === selectedFault)
      .map(fault => faultScenario(browser!, fault)));
    if (selectedFault === null || selectedFault === "peer-storage") results.push(await peerStorageFailure(browser!));
    (report.faults as unknown[]).push(...results);
  }
  report.passed = true;
  await save();
  console.log(JSON.stringify({ passed: true, output: resolve(output, "browser-results.json") }));
} catch (error) {
  report.error = String(error);
  await save();
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.stop(true);
}
process.exit(process.exitCode ?? 0);
