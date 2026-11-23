import { chromium, type Browser, type BrowserContext, type Page, type WebSocket as BrowserSocket } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
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
if (selectedFault !== null && !["acceptance-result-unreceived", "removal-before-policy", "permanent-no-policy", "peer-storage", "guest-resume-after-succession", "second-resume", "former-host-removal", "prompt-host-succession", "planned-then-unplanned", "persisted-offer", "silent-host-loss"].includes(selectedFault)) {
  throw new Error("Unknown fault scenario");
}
const live = process.argv.includes("--production");
if (live && (mode !== "faults" || selectedFault !== "prompt-host-succession")) {
  throw new Error("--production is only for the prompt-host-succession public UI check");
}
await mkdir(output, { recursive: true });
const report: Record<string, unknown> = {
  scope: live ? "One production room, three browser profiles, public UI. Not a latency distribution or capacity test."
    : "Actual local Bun relay, production browser bundle, WebSockets, MLS and IndexedDB. Not WAN or production capacity.",
  environment: { os: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    memoryBytes: totalmem(), bun: Bun.version, playwright: "1.65.0" },
  benchmarks: [], faults: [], passed: false,
};
const staged = process.env.PILLOWFORT_QUALIFICATION_ORIGIN;
const cuts = process.env.PILLOWFORT_QUALIFICATION_CUTS;
if (staged && (live || !cuts || !/^http:\/\/127\.0\.0\.1:\d+$/.test(staged))) throw Error("Qualification requires an isolated loopback Worker");
if (["persisted-offer", "silent-host-loss"].includes(selectedFault ?? "") && !staged) throw Error("Use protocol-workerd-evidence.mjs");
const server = live || staged ? null : startLocalServer(0);
const origin = staged ?? (server ? `http://127.0.0.1:${server.port}` : "https://pillowfort.xyz");
if (staged) report.scope = "Dedicated local workerd Durable Object, hibernatable WebSockets, production browser bundle, MLS and IndexedDB. Not the Cloudflare edge.";
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
async function setupRoom(browser: Browser, count: number, configure?: (participant: Participant, index: number) => Promise<void>, hostOrigin = origin): Promise<RoomEvidence> {
  const participants: Participant[] = [];
  const names = Array.from({ length: count }, (_, i) => i === 0 ? "Evidence Host" : `Evidence Guest ${i}`);
  const host = await newParticipant(browser);
  participants.push(host);
  await configure?.(host, 0);
  await host.page.goto(hostOrigin);
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
    await successor.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
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

async function guestResumeAfterSuccession(browser: Browser) {
  let successorSocket: BrowserSocket | undefined;
  let policyId: string | undefined, newHost: string | undefined;
  let joined: string | undefined, resumed: string | undefined, signer: string | undefined, snapshotHost: string | undefined;
  let end: string | undefined, completion: string | undefined;
  const replay: string[] = [];
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    if (index === 0) return;
    page.on("websocket", socket => {
      if (index === 1) successorSocket = socket;
      socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (index === 1 && f.authorityEvent?.content.type === "host-succession-policy") {
          policyId = f.envelope.messageId;
          newHost = f.authorityEvent.deviceId;
        }
        if (index !== 2 || !resumed) return;
        if (f.kind === "resume-complete" && end && f.lastMessageId === end) {
          completion = f.requestId;
          replay.push("exact completion");
        }
        if (f.kind === "relay" && f.relayKind === "application" && !replay.includes("completion ACK")) {
          replay.push("early application");
        }
      });
      if (index !== 2) return;
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (f.type === "authenticated" && f.mode === "join") joined ??= f.deviceId;
        if (f.type === "authenticated" && f.mode === "resume") resumed = f.deviceId;
        if (!resumed) return;
        const authority = f.frame?.authorityEvent;
        if (f.type === "relay" && authority?.content.type === "host-succession" && authority.content.action === "accept") {
          signer = authority.deviceId;
          replay.push("signed acceptance");
        } else if (f.type === "room-state-snapshot") {
          snapshotHost = f.hostDeviceId;
          replay.push("snapshot");
        } else if (f.type === "backlog-end") {
          end = f.lastMessageId;
          replay.push("terminator");
        } else if (f.type === "frame-accepted" && completion && f.messageId === completion) {
          replay.push("completion ACK");
        }
      });
    });
  });
  const [host, successor, guest] = room.participants;
  try {
    await deliver(guest.page, host.page, "before guest recovery");
    await host.page.goto("about:blank");
    await successor.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    // Disconnect the observer before acceptance so it must recover that event by replay.
    await guest.page.goto("about:blank");
    if (!successorSocket) throw new Error("Successor socket not observed");
    await Promise.all([
      successorSocket.waitForEvent("framereceived", { timeout: 20_000, predicate: ({ payload }) => {
        const f = JSON.parse(payload.toString());
        return !!policyId && f.type === "application-result" && f.result === "accepted" && f.messageId === policyId;
      } }),
      successor.page.locator("#btn-catch").click(),
    ]);
    await guest.page.goto(room.invitation);
    await guest.page.locator("#join-name").fill(room.names[2]);
    await guest.page.getByRole("button", { name: /Join fort|Reconnect|Recover/ }).click();
    await guest.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 20_000 });
    await deliver(guest.page, successor.page, "guest message after recovery");
    await deliver(successor.page, guest.page, "new host reply after recovery");
    if (!joined || resumed !== joined || !newHost || signer !== newHost || snapshotHost !== newHost ||
        replay.join(",") !== "signed acceptance,snapshot,terminator,exact completion,completion ACK") {
      throw new Error(`Guest identity, authority or replay boundary mismatch: ${replay.join(", ")}`);
    }
    return { fault: "guest-resume-after-succession", restoredSameDevice: true, replay, deliveredBothDirections: true };
  } finally { await closeRoom(room); }
}

async function awaitBoundary<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Missing browser boundary: ${name}`)), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function reopen(room: RoomEvidence, index: number) {
  const page = room.participants[index].page;
  await page.goto(room.invitation);
  await page.locator("#join-name").fill(room.names[index]);
  await page.getByRole("button", { name: /Join fort|Reconnect|Recover/ }).click();
}

async function promptHostSuccession(browser: Browser) {
  const policyReady = Promise.withResolvers<void>();
  const choices: string[] = [];
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    page.on("websocket", socket => {
      let policyFrame: string | undefined;
      socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        const action = f.authorityEvent?.content;
        if (index === 0 && action?.type === "host-succession-policy" && action.deviceIds.length === 2) {
          policyFrame = f.envelope.messageId;
        }
        if (action?.type === "host-succession") choices.push(`${index}:${action.action}`);
      });
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (policyFrame && f.type === "application-result" && f.messageId === policyFrame && f.result === "accepted") {
          policyReady.resolve();
        }
      });
    });
  });
  const [host, first, second] = room.participants;
  try {
    await awaitBoundary(policyReady.promise, "signed policy covering both guests");
    const start = performance.now();
    await host.context.close();
    await first.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    const closeToFirstVisibleOfferMs = Math.round(performance.now() - start);
    if (choices.length || await second.page.locator("#host-offer-overlay").isVisible()) throw new Error("Offer bypassed consent or order");
    await first.page.locator("#btn-duck").click();
    await second.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    await second.page.locator("#btn-catch").click();
    await second.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 15_000 });
    await deliver(first.page, second.page, "first guest stayed in the room");
    await deliver(second.page, first.page, "second guest is hosting");
    if (choices.join(",") !== "1:reject,2:accept") throw new Error("Missing signed refusal or acceptance");
    return { fault: "prompt-host-succession", closeToFirstVisibleOfferMs, signedChoices: choices, deliveredBothDirections: true };
  } finally { await closeRoom(room); }
}

async function plannedThenUnplanned(browser: Browser) {
  const ready = Promise.withResolvers<void>(), refreshed = Promise.withResolvers<void>();
  const devices: string[] = [], signedChoices: string[] = [];
  let originalPolicy = "", replacementPolicy = "", deliveredPolicy = "", previewedAcceptance = false;
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    page.on("websocket", socket => {
      let policyFrame = "";
      socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString()), action = f.authorityEvent?.content;
        if (action?.type === "host-succession-policy" && action.deviceIds.length === 2) {
          policyFrame = f.envelope.messageId;
          if (index === 0) originalPolicy ||= f.authorityEvent.eventId;
          if (index === 2 && action.deviceIds.join() === [devices[0], devices[1]].join()) replacementPolicy = f.authorityEvent.eventId;
        }
        if (action?.type === "host-succession") signedChoices.push(`${index}:${action.action}`);
      });
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (f.type === "authenticated") devices[index] = f.deviceId;
        if (index === 0 && f.type === "application-preview" && f.frame?.relayKind === "host-transfer-accept") previewedAcceptance = true;
        if (index === 0 && f.type === "host-transfer-authorized" && f.policyEventId) deliveredPolicy = f.policyEventId;
        if (policyFrame && f.type === "application-result" && f.messageId === policyFrame && f.result === "accepted") {
          if (index === 0) ready.resolve();
          if (index === 2 && replacementPolicy) refreshed.resolve();
        }
      });
    });
  });
  const [old, peer, next] = room.participants;
  try {
    await awaitBoundary(ready.promise, "first tenure committed policy");
    await old.page.locator("#btn-room-menu").click();
    await old.page.locator("#aim-btn-toss").click();
    await old.page.locator("#member-picker-body .member-picker-item", { hasText: room.names[2] }).click();
    await next.page.locator("#btn-catch").click();
    await awaitBoundary(refreshed.promise, "manual successor published its own policy");
    await deliver(old.page, peer.page, "former host remains admitted after manual transfer");
    await next.context.close();
    await old.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    if (!previewedAcceptance || !replacementPolicy || replacementPolicy === originalPolicy || deliveredPolicy !== replacementPolicy || signedChoices.length) throw Error("Transfer modes or tenures were conflated");
    await old.page.locator("#btn-duck").click();
    await peer.page.locator("#btn-catch").click();
    await peer.page.getByText("Buddies (2)", { exact: true }).waitFor();
    await deliver(old.page, peer.page, "declining member still present");
    await deliver(peer.page, old.page, "second transfer is usable");
    if (signedChoices.join(",") !== "0:reject,1:accept") throw Error("Wrong succession choices");
    return { fault: "planned-then-unplanned", formerHostRemainedAdmitted: true, manualAcceptancePreviewed: true,
      freshPolicyBoundToOffer: true, signedChoices, deliveredBothDirections: true };
  } finally { await closeRoom(room); }
}

// Drop WebSocket bytes in both directions on the host's dedicated loopback TCP
// path. Keep both TCP legs open; do not forward FIN/RST or answer WebSocket pings.
async function hostPath(destination: string) {
  let blocked = false;
  const sockets = new Set<Socket>();
  const sink = createServer(client => {
    if (blocked) { client.destroy(); return; }
    const upstream = connect(Number(new URL(destination).port), "127.0.0.1");
    for (const [from, to] of [[client, upstream], [upstream, client]]) {
      sockets.add(from);
      from.on("data", data => { if (!blocked && !to.destroyed && !to.write(data)) from.pause(); });
      to.on("drain", () => from.resume());
      from.on("error", () => {});
      from.on("close", () => { sockets.delete(from); if (!blocked) to.destroy(); });
    }
  });
  await new Promise<void>((ok, fail) => { sink.once("error", fail); sink.listen(0, "127.0.0.1", ok); });
  const address = sink.address();
  if (!address || typeof address === "string") throw Error("Missing TCP port");
  return { origin: `http://127.0.0.1:${address.port}`, block() { blocked = true; },
    closePaths() { for (const socket of sockets) socket.destroy(); },
    stop() { this.closePaths(); sink.close(); } };
}

async function workerdHandoff(browser: Browser, fault: "persisted-offer" | "silent-host-loss") {
  const path = fault === "silent-host-loss" ? await hostPath(origin) : null;
  const policyReady = Promise.withResolvers<void>();
  const choices: string[] = [], notices: any[] = [], resumes: string[] = [], switches = new Set<string>();
  let consecutiveCancellations = 0, maxConsecutiveCancellations = 0;
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    let policyId: string | undefined;
    page.on("websocket", socket => {
      socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString()), action = f.authorityEvent?.content;
        if (index === 0 && action?.type === "host-succession-policy" && action.deviceIds.length === 2) policyId = f.envelope.messageId;
        if (action?.type === "host-succession") choices.push(`${index}:${action.action}`);
      });
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (policyId && f.type === "application-result" && f.messageId === policyId && f.result === "accepted") policyReady.resolve();
        if (index === 1) {
          if (f.type === "order-cancelled") maxConsecutiveCancellations = Math.max(maxConsecutiveCancellations, ++consecutiveCancellations);
          else consecutiveCancellations = 0;
        }
        if (index === 1 && f.type === "host-transfer-authorized") notices.push(f);
        if (index === 1 && f.type === "authenticated") resumes.push(`${f.mode}:${f.deviceId}`);
        if (index === 2 && f.type === "host-changed") switches.add(f.deviceId);
      });
    });
  }, path?.origin ?? origin);
  try {
    await awaitBoundary(policyReady.promise, "both admitted devices in committed policy");
    const [host, first, second] = room.participants;
    const offer = first.page.locator("#host-offer-overlay");
    const metrics: Record<string, unknown> = {};
    if (path) {
      const windowMs = 150_000;
      const onset = Date.now(); path.block();
      let forced: number | null = null;
      try { await offer.waitFor({ timeout: windowMs }); } catch (error) {
        if ((error as Error).name !== "TimeoutError") throw error;
        forced = Date.now(); path.closePaths();
        await offer.waitFor({ timeout: 15_000 });
      }
      const observed = Date.now();
      const detected = JSON.parse(await readFile(resolve(cuts!, "detected.json"), "utf8"));
      const silent = forced === null || detected < forced;
      if (detected < onset || detected > observed) throw Error("Inconsistent host loss clock");
      Object.assign(metrics, { observationWindowMs: windowMs, actualSilentObservationMs: (forced ?? detected) - onset,
        lossToRelayDetectionMs: silent ? detected - onset : null, rightCensored: !silent,
        forcedCloseToRelayDetectionMs: silent ? null : detected - forced!, relayDetectionToObservedVisibleOfferMs: observed - detected,
        transport: "Two loopback TCP legs ACK locally; dropped WebSocket bytes, no forwarded FIN/RST at onset. Not packet-level WAN loss." });
    } else {
      await host.context.close();
      await offer.waitFor({ timeout: 17_000 }); // Must precede the original 30-second authorization deadline.
      const saved = JSON.parse(await readFile(resolve(cuts!, "cut.json"), "utf8"));
      const n = notices[0];
      if (!n || n.authorizationId !== saved.authorizationId || n.offerMessageId !== saved.offerMessageId ||
          n.expiresAt !== saved.expiresAt || n.policyEventId !== saved.policyEventId || n.fromHostDeviceId !== saved.hostDeviceId ||
          resumes[0] !== `join:${saved.targetDeviceId}` || Date.now() >= saved.expiresAt) throw Error("Restored offer differs from durable authorization");
      Object.assign(metrics, { sameAuthorizationPolicyTargetAndDeadline: true, originalTtlMs: saved.expiresAt-saved.authorizedAt,
        remainingMsWhenVisible: saved.expiresAt-Date.now(), sameDeviceResume: resumes.includes(`resume:${saved.targetDeviceId}`) });
    }
    if (choices.length || await second.page.locator("#host-offer-overlay").isVisible()) throw Error("Transferred before consent or skipped first candidate");
    await first.page.locator("#btn-duck").click();
    await second.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    if (fault === "persisted-offer") await wait(500); // Deliberate human choice interval; the declining client must not spin.
    await second.page.locator("#btn-catch").click();
    await second.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 15_000 });
    await deliver(first.page, second.page, "resumed room: one to two");
    await deliver(second.page, first.page, "resumed room: two to one");
    if (choices.join(",") !== "1:reject,2:accept" || switches.size !== 1 || maxConsecutiveCancellations > 1) throw Error("Missing exact consent or host transition");
    return { fault, ...metrics, maxConsecutiveCancellations, signedChoices: choices, distinctNewHosts: switches.size, deliveredBothDirections: true };
  } catch (e) {
    report.failureDiagnostics = await Promise.all(room.participants.filter(p => !p.page.isClosed()).map(async p => ({
      surface: (await text(p.page)).replace(/f-[a-z2-7]{10}/g, "[room]"),
      frames: await p.page.evaluate(() => (globalThis as typeof globalThis & { __pillowfortEvidenceFrames: unknown[] }).__pillowfortEvidenceFrames),
    })));
    throw e;
  } finally { path?.stop(); await closeRoom(room); }
}

async function secondResume(browser: Browser) {
  const withheld = Promise.withResolvers<() => void>();
  let joined: string | undefined, oldAck: string | undefined;
  const returning: string[] = [], completions: string[] = [];
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    if (index !== 2) return;
    await page.routeWebSocket("**", client => {
      const server = client.connectToServer();
      let completion: string | undefined;
      client.onMessage(raw => {
        const f = JSON.parse(raw.toString());
        if (f.kind === "resume-complete") { completion = f.requestId; completions.push(f.requestId); }
        server.send(raw);
      });
      server.onMessage(raw => {
        const f = JSON.parse(raw.toString());
        if (f.type === "authenticated" && f.mode === "join") joined = f.deviceId;
        if (f.type === "authenticated" && f.mode === "resume") returning.push(f.deviceId);
        if (completion && f.type === "frame-accepted" && f.messageId === completion) {
          if (returning.length === 1) {
            // Relay accepted A. Its ACK is in flight when the connection drops.
            oldAck = raw.toString();
            client.close({ code: 1011, reason: "interrupted completion" });
            server.close();
            return;
          }
          if (returning.length === 2 && oldAck) {
            client.send(oldAck); // Real older ACK, while B waits for its own.
            withheld.resolve(() => client.send(raw));
            return;
          }
        }
        client.send(raw);
      });
    });
  });
  const [host, successor, guest] = room.participants;
  try {
    await host.page.goto("about:blank");
    await successor.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    await guest.page.goto("about:blank");
    await successor.page.locator("#btn-catch").click();
    await successor.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 20_000 });
    await reopen(room, 2);
    const release = await awaitBoundary(withheld.promise, "second completion ACK");
    // An observed, later encrypted message fences processing of the old ACK.
    await deliver(successor.page, guest.page, "message after the delayed ACK");
    const input = guest.page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("must not send before the current ACK");
    await input.press("Enter");
    await guest.page.getByText("The secure room is reconnecting. Try again in a moment.", { exact: true }).first().waitFor();
    release();
    await deliver(successor.page, guest.page, "message after the current ACK");
    await deliver(guest.page, successor.page, "sent after the current ACK");
    if (!joined || returning.length !== 2 || returning.some(id => id !== joined) ||
        completions.length !== 2 || completions[0] === completions[1] ||
        (await text(successor.page)).includes("must not send before the current ACK")) {
      throw new Error("Second resume replaced the device or released an old send");
    }
    return { fault: "second-resume", sameDeviceResumes: 2, staleAckRefusedSend: true, currentAckReleasedSend: true };
  } finally { await closeRoom(room); }
}

async function formerHostRemoval(browser: Browser) {
  const beforeRemove = Promise.withResolvers<void>(), beforeResult = Promise.withResolvers<void>();
  const peerRemove = Promise.withResolvers<() => void>(), allowPeerReplay = Promise.withResolvers<void>();
  const newPolicy = Promise.withResolvers<void>(), peerReady = Promise.withResolvers<void>();
  let hostId: string | undefined, joined: string | undefined, binding: string | undefined;
  let removal: string | undefined, policy: string | undefined, closes = 0, reloads = 0;
  const restored: string[] = [], replayedMarkers: string[] = [];
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    if (index === 0) {
      page.on("websocket", s => s.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (f.type === "authenticated" && f.mode === "setup") hostId = f.deviceId;
      }));
      return;
    }
    await page.routeWebSocket("**", client => {
      const server = client.connectToServer();
      let paused = false;
      let peerCompletion: string | undefined;
      client.onMessage(raw => {
        if (paused) return;
        const f = JSON.parse(raw.toString());
        if (index === 2 && f.kind === "resume-complete") peerCompletion = f.requestId;
        if (index === 1 && f.kind === "relay") {
          if (f.relayKind === "commit" && binding && f.retirementDeviceId === hostId &&
              f.retirementAdmissionCommitMessageId === binding) removal = f.envelope.messageId;
          if (f.authorityEvent?.content.type === "host-succession-policy") policy = f.envelope.messageId;
        }
        server.send(raw);
      });
      server.onMessage(raw => {
        if (paused) return;
        const f = JSON.parse(raw.toString());
        if (index === 2) {
          if (closes && f.kind === "secure-auth-challenge") {
            void allowPeerReplay.promise.then(() => client.send(raw));
            return;
          }
          if (!closes && removal && f.type === "relay" && f.frame?.envelope.messageId === removal) {
            paused = true; // No later packet may overtake this held Remove.
            peerRemove.resolve(() => {
              closes++;
              client.send(raw);
              client.close({ code: 1011, reason: "close directly after Remove" });
              server.close();
            });
            return;
          }
          if (peerCompletion && f.type === "frame-accepted" && f.messageId === peerCompletion) peerReady.resolve();
        } else {
          if (f.type === "authenticated" && f.mode === "join") joined = f.deviceId;
          if (f.type === "authenticated" && f.mode === "resume") restored.push(f.deviceId);
          if (hostId && f.type === "zombie-removal-required" && f.deviceId === hostId) {
            binding ??= f.admissionCommitMessageId;
            replayedMarkers.push(f.admissionCommitMessageId);
          }
          if (!reloads && binding && f.type === "order-granted") {
            paused = true;
            beforeRemove.resolve();
            return; // Marker received; grant never reached the local MLS engine.
          }
          if (reloads === 1 && removal && f.type === "frame-accepted" && f.messageId === removal) {
            paused = true;
            beforeResult.resolve();
            return; // Both sides stored the Remove; sender has not observed its result.
          }
          if (reloads === 2 && policy && f.type === "application-result" && f.result === "accepted" && f.messageId === policy) {
            newPolicy.resolve();
          }
        }
        client.send(raw);
      });
    });
  });
  const [host, successor, peer] = room.participants;
  try {
    await host.page.goto("about:blank");
    await successor.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    await successor.page.locator("#btn-catch").click();
    await awaitBoundary(beforeRemove.promise, "marker before Remove grant");
    if (removal) throw new Error("Remove preceded the first interruption");
    for (const boundary of [beforeRemove, beforeResult]) {
      await awaitBoundary(boundary.promise, "successor reload checkpoint");
      await successor.page.goto("about:blank");
      reloads++;
      await reopen(room, 1);
    }
    const sendThenClose = await awaitBoundary(peerRemove.promise, "former-host MLS Remove at peer");
    await peer.page.getByText("Buddies (3)", { exact: true }).waitFor();
    sendThenClose();
    // The roster must change without a replacement socket supplying any replay.
    await peer.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 15_000 });
    allowPeerReplay.resolve();
    await awaitBoundary(newPolicy.promise, "successor policy after exact cleanup");
    await awaitBoundary(peerReady.promise, "peer completion after close");
    await deliver(successor.page, peer.page, "after former-host removal");
    await deliver(peer.page, successor.page, "peer retained the removal");
    if (!joined || restored.length !== 2 || restored.some(id => id !== joined) ||
        !binding || replayedMarkers.length < 2 || replayedMarkers.some(id => id !== binding)) {
      throw new Error("Recovery changed successor identity or removal binding");
    }
    return { fault: "former-host-removal", successorReloads: reloads, sameDevice: true, exactMarkerReplayed: true,
      withheldAcceptedRemoveResult: true, rosterChangedBeforePeerReplay: true, successorPolicyAccepted: true, deliveredBothDirections: true };
  } catch (error) {
    // Keep only wire categories and error codes, never invitations, keys, or payloads.
    report.removalBoundary = { reloads, closes, resumes: restored.length, markers: replayedMarkers.length,
      policySent: !!policy, participants: await Promise.all([successor, peer].map(({ page }) =>
        page.evaluate(() => (globalThis as any).__pillowfortEvidenceFrames.map((f: any) =>
          [f.direction, f.type ?? f.kind, f.relayKind, f.code].filter(Boolean).join(":"))))) };
    throw error;
  } finally { allowPeerReplay.resolve(); await closeRoom(room); }
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
    const planned = selectedFault === null || selectedFault === "planned-then-unplanned" ? await plannedThenUnplanned(browser!) : null;
    const faults: Fault[] = ["acceptance-result-unreceived", "removal-before-policy", "permanent-no-policy"];
    const results: unknown[] = await Promise.all(faults.filter(fault => selectedFault === null || fault === selectedFault)
      .map(fault => faultScenario(browser!, fault)));
    if (planned) results.unshift(planned);
    if (selectedFault === null || selectedFault === "peer-storage") results.push(await peerStorageFailure(browser!));
    if (selectedFault === null || selectedFault === "guest-resume-after-succession") results.push(await guestResumeAfterSuccession(browser!));
    if (selectedFault === null || selectedFault === "second-resume") results.push(await secondResume(browser!));
    if (selectedFault === null || selectedFault === "former-host-removal") results.push(await formerHostRemoval(browser!));
    if (selectedFault === null || selectedFault === "prompt-host-succession") results.push(await promptHostSuccession(browser!));
    if (selectedFault === "persisted-offer" || selectedFault === "silent-host-loss") results.push(await workerdHandoff(browser!, selectedFault));
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
  server?.stop(true);
}
process.exit(process.exitCode ?? 0);
