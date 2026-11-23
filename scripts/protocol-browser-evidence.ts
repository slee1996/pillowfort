import { chromium, type Browser, type BrowserContext, type Page, type WebSocket as BrowserSocket } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { startLocalServer } from "../server";
import type { SecureRelayStateV4 } from "../src/secureRelayV4";
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
if (selectedFault !== null && !["acceptance-result-unreceived", "removal-before-policy", "permanent-no-policy", "peer-storage", "guest-resume-after-succession", "second-resume", "former-host-removal", "prompt-host-succession", "planned-then-unplanned", "persisted-offer", "silent-host-loss", "silent-host-uplink", "silent-host-downlink", "probe-restart", "guest-backpressure", "full-room", "healthy-host", "suspended-host", "paused-host", "idle-retirement", "idle-retirement-prefix", "lost-guest-keys", "natural-idle"].includes(selectedFault)) {
  throw new Error("Unknown fault scenario");
}
const live = process.argv.includes("--production");
if (live && (mode !== "faults" || !["prompt-host-succession", "healthy-host", "natural-idle"].includes(selectedFault ?? ""))) {
  throw new Error("Production permits only ordinary healthy-host, voluntary succession and natural idle closure");
}
await mkdir(output, { recursive: true });
const report: Record<string, unknown> = {
  scope: live ? "One self-created production room, production browser clients. Not a latency distribution or capacity test."
    : "Actual local Bun relay, production browser bundle, WebSockets, MLS and IndexedDB. Not WAN or production capacity.",
  environment: { os: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    memoryBytes: totalmem(), bun: Bun.version, playwright: "1.65.0" },
  benchmarks: [], faults: [], passed: false,
};
const staged = process.env.PILLOWFORT_QUALIFICATION_ORIGIN;
if (staged && (live || !process.send || !/^http:\/\/127\.0\.0\.1:\d+$/.test(staged))) throw Error("Qualification requires an isolated loopback Worker");
type FixtureReceipt = { detectedAt: number } | { offer: NonNullable<SecureRelayStateV4["pendingHostTransfer"]> };
const fixtureReceipt = staged ? new Promise<FixtureReceipt>(resolve => {
  process.once("message", message => resolve(message as FixtureReceipt));
}) : null;
const workerCuts = ["persisted-offer", "silent-host-loss", "silent-host-uplink", "silent-host-downlink", "probe-restart", "idle-retirement", "idle-retirement-prefix"] as const;
type WorkerCut = typeof workerCuts[number];
const workerCut = workerCuts.find(cut => cut === selectedFault);
if (workerCut && !staged) throw Error("Use protocol-workerd-evidence.mjs");
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
async function setupRoom(browser: Browser, count: number, configure?: (participant: Participant, index: number) => Promise<void>, hostOrigin = origin, interAdmissionMs = 250,
  names = Array.from({ length: count }, (_, i) => i === 0 ? "Evidence Host" : `Evidence Guest ${i}`)): Promise<RoomEvidence> {
  const participants: Participant[] = [];
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
    await wait(interAdmissionMs);
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

async function promptHostSuccession(browser: Browser, condition: "close" | "freeze" | "pause" = "close") {
  const suspend = condition !== "close";
  const keptAnswering = Promise.withResolvers<"responsive">(), fresh = new Set<string>();
  let measuring = false;
  const policyReady = Promise.withResolvers<void>();
  const choices: string[] = [];
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    page.on("websocket", socket => {
      let policyFrame: string | undefined;
      socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (index === 0 && measuring && f.kind === "host-path-reply") {
          fresh.add(f.nonce);
          if (fresh.size >= 2) keptAnswering.resolve("responsive");
        }
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
    if (suspend) {
      if (live || staged) throw Error("Suspension is restricted to a private local browser");
      const backend = await host.context.newCDPSession(host.page);
      await first.page.bringToFront();
      if (condition === "freeze") await backend.send("Page.setWebLifecycleState", { state: "frozen" });
      else {
        await backend.send("Debugger.enable");
        const paused = Promise.withResolvers<void>();
        backend.once("Debugger.paused", () => paused.resolve());
        await backend.send("Debugger.pause");
        await awaitBoundary(paused.promise, "JavaScript actually paused");
      }
      measuring = true;
      if (condition === "freeze") {
        // Some browser task sources keep servicing a socket after page freeze.
        // Do not call that path dead if the participant actually answers probes.
        const firstOutcome = await Promise.race([keptAnswering.promise,
          first.page.locator("#host-offer-overlay").waitFor({timeout: 35_000}).then(() => "offered" as const)]);
        if (firstOutcome === "responsive") {
          if (choices.length || await first.page.locator("#host-offer-overlay").isVisible()) throw Error("responsive frozen page was fenced");
          await backend.send("Page.setWebLifecycleState", { state: "active" });
          await deliver(host.page, first.page, "original host after thaw");
          await deliver(first.page, host.page, "peer after thaw");
          return {fault:"suspended-host", outcome:"frozen page answered challenges", distinctReplies: fresh.size, offered:false, deliveredBothDirections:true};
        }
      }
    } else await host.context.close();
    await first.page.locator("#host-offer-overlay").waitFor({ timeout: suspend ? 35_000 : 5_000 });
    const elapsedMs = Math.round(performance.now() - start);
    if (choices.length || await second.page.locator("#host-offer-overlay").isVisible()) throw new Error("Offer bypassed consent or order");
    await first.page.locator("#btn-duck").click();
    await second.page.locator("#host-offer-overlay").waitFor({ timeout: 5_000 });
    await second.page.locator("#btn-catch").click();
    await second.page.getByText("Buddies (2)", { exact: true }).waitFor({ timeout: 15_000 });
    await deliver(first.page, second.page, "first guest stayed in the room");
    await deliver(second.page, first.page, "second guest is hosting");
    if (choices.join(",") !== "1:reject,2:accept") throw new Error("Missing signed refusal or acceptance");
    return { ...(suspend ? {fault: condition === "pause" ? "paused-host" : "suspended-host", suspensionToFirstVisibleOfferMs: elapsedMs,
      scope: condition === "pause" ? "Debugger confirmed the original live host’s JavaScript was stopped; no simulated network fault." : "Chromium page frozen by its lifecycle API, not an actual locked phone."}
      : {fault: "prompt-host-succession", closeToFirstVisibleOfferMs: elapsedMs}), signedChoices: choices, deliveredBothDirections: true };
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
async function hostPath(destination: string, direction: "both" | "uplink" | "downlink") {
  let blocked = false;
  const sockets = new Set<Socket>();
  const sink = createServer(client => {
    if (blocked) { client.destroy(); return; }
    const upstream = connect(Number(new URL(destination).port), "127.0.0.1");
    for (const [from, to] of [[client, upstream], [upstream, client]]) {
      sockets.add(from);
      from.on("data", data => { if ((!blocked || direction === "uplink" && from === upstream || direction === "downlink" && from === client) && !to.destroyed && !to.write(data)) from.pause(); });
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

async function idleRetirement(browser: Browser, fault: "idle-retirement" | "idle-retirement-prefix" | "natural-idle") {
  const ordinary = fault === "natural-idle";
  const wires: string[][] = [[], []];
  const room = await setupRoom(browser, 2, async ({page}, i) => {
    page.on("websocket", ws => {
      ws.on("framereceived", ({payload}) => { if (JSON.parse(payload.toString()).type === "room-retired") wires[i].push("retired"); });
      ws.on("close", () => wires[i].push("close"));
    });
  }, origin, 250, ordinary ? ["Cedar", "cedar"] : undefined);
  try {
    if (ordinary) await room.participants[1].page.getByText("That name's taken — you're cedar2 now", {exact:true}).waitFor();
    await deliver(room.participants[0].page, room.participants[1].page, "before idle retirement");
    const start = performance.now();
    // From here the two real clients take no action. Recovery must not depend on a reload, new join or chat send.
    await Promise.all(room.participants.map(({page}) => page.getByRole("heading", {name:"Fort has been knocked down."}).waitFor({timeout:ordinary ? 720_000 : 22_000})));
    if (wires.some(w => w[0] !== "retired")) throw Error("terminal UI was not preceded by a retirement notice on the original socket");
    return { fault, originalPeersReachedTerminal: wires.length, noUserActionUntilNotice: true, noticeBeforeDisconnect: true,
      ...(ordinary && { caseInsensitiveNameResolved: true, elapsedMsSinceChat: Math.round(performance.now() - start) }) };
  } finally { await closeRoom(room); }
}

async function lostGuestKeys(browser: Browser) {
  const joins: {device: string; key: string; request: string}[] = [], resume: string[] = [];
  const room = await setupRoom(browser, 2, async ({page}, i) => {
    if (i !== 1) return;
    page.on("websocket", ws => ws.on("framesent", ({payload}) => {
      const f = JSON.parse(payload.toString());
      if (f.kind !== "secure-authenticate") return;
      if (f.mode === "join") joins.push({device:f.frame.hello.deviceId, key:f.frame.signaturePublicKey, request:f.frame.requestId});
      if (f.mode === "resume") resume.push(f.frame.deviceId);
    }));
  });
  const [host, guest] = room.participants;
  try {
    const original = joins[0], before = "only the previous leaf received this";
    await deliver(host.page, guest.page, before);
    const cdp = await guest.context.newCDPSession(guest.page);
    const names = async () => (await cdp.send("IndexedDB.requestDatabaseNames", {securityOrigin:origin})).databaseNames;
    await cdp.send("IndexedDB.enable");
    if (!(await names()).includes("pillowfort-crypto-state-v1")) throw Error("participant database missing before cut");
    await guest.page.goto("about:blank"); // Drop the old runtime before removing its persisted keys.
    await cdp.send("Storage.clearDataForOrigin", {origin, storageTypes:"indexeddb"});
    await guest.page.goto(origin);
    if ((await names()).includes("pillowfort-crypto-state-v1")) throw Error("participant database survived cut");
    await reopen(room, 1); // Same profile, link and display name; this is an explicit join, never silent recovery.
    const approve = host.page.getByRole("button", {name:"Approve", exact:true});
    await approve.waitFor({timeout:15_000});
    const next = joins[1];
    if (!original?.key || !next?.key || !original.device || !next.device || !original.request || !next.request ||
        original.device === next.device || original.key === next.key || original.request === next.request || resume.length ||
        await guest.page.locator("#msg-input").isVisible()) throw Error("key loss did not require distinct authenticated admission");
    await approve.click();
    await deliver(guest.page, host.page, "newly approved device talking");
    const originalName = room.names[1], newName = `${originalName}2`;
    await guest.page.getByText(`That name's taken — you're ${newName} now`, {exact:true}).waitFor();
    const oldTarget = `@${JSON.stringify(originalName)}`, newTarget = `@${JSON.stringify(newName)}`;
    await deliver(host.page, guest.page, `${oldTarget} old label`);
    await deliver(host.page, guest.page, `${newTarget} new label`);
    const marked = guest.page.locator(".chat-message-mentioned mark");
    await marked.filter({hasText:newTarget}).waitFor();
    if (await marked.filter({hasText:oldTarget}).count()) throw Error("mention addressed to old label reached new identity");
    if (await guest.page.getByText(before, {exact:true}).count()) throw Error("the new device obtained previous chat history");
    room.names[1] = newName;
    await guest.page.goto("about:blank");
    await reopen(room, 1);
    await deliver(host.page, guest.page, "new leaf after reconnect");
    await deliver(guest.page, host.page, "still the newly admitted identity");
    if (joins.length !== 2 || !resume.length || resume.some(d => d !== next.device)) throw Error("restored the wrong identity");
    return { fault:"lost-guest-keys", erasedRealIndexedDb:true, originalIdentityNotResumed:true, freshKeyAndAdmission:true,
      hostApprovalRequired:true, previousChatWithheld:true, disambiguatedName:true, mentionsTargetOnlyNewLabel:true, newIdentityResumed:true, encryptedChatBothDirections:true };
  } finally { await closeRoom(room); }
}

async function workerdHandoff(browser: Browser, fault: WorkerCut) {
  const direction = fault === "silent-host-uplink" ? "uplink" : fault === "silent-host-downlink" ? "downlink" : "both";
  const path = fault.startsWith("silent-host-") ? await hostPath(origin, direction) : null;
  const hostProbes = new Set<string>(), hostReplies = new Set<string>();
  const healthy = Promise.withResolvers<void>();
  const policyReady = Promise.withResolvers<void>();
  const choices: string[] = [], notices: any[] = [], resumes: string[] = [], switches = new Set<string>();
  let consecutiveCancellations = 0, maxConsecutiveCancellations = 0;
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    let policyId: string | undefined;
    page.on("websocket", socket => {
      socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString()), action = f.authorityEvent?.content;
        if (index === 0 && f.kind === "host-path-reply" && hostProbes.has(f.nonce)) {
          hostReplies.add(f.nonce);
          if (hostReplies.size >= 2) healthy.resolve();
        }
        if (index === 0 && action?.type === "host-succession-policy" && action.deviceIds.length === 2) policyId = f.envelope.messageId;
        if (action?.type === "host-succession") choices.push(`${index}:${action.action}`);
      });
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (index === 0 && f.type === "host-path-probe") hostProbes.add(f.nonce);
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
    if (fault === "probe-restart") {
      // The first challenge is persisted but never sent. Evict the object;
      // the retry must reach the healthy host and start another fresh round.
      await Promise.race([healthy.promise, wait(36_000).then(() => { throw Error("restored host did not answer two probes"); })]);
      if (notices.length || switches.size || choices.length) throw Error("healthy host lost authority during restore");
      await deliver(first.page, host.page, "reachable after probe retry");
      await deliver(host.page, first.page, "host survived hibernation");
      return { fault, sawFreshNonces: hostReplies.size, noUnwantedOffer: true, deliveredBothDirections: true };
    }
    if (path) {
      // No forced close is allowed to turn a missed detector into a passing run.
      const onset = Date.now(); path.block();
      await offer.waitFor({ timeout: 32_000 });
      const observed = Date.now();
      const receipt = await awaitBoundary(fixtureReceipt!, "relay detection receipt");
      if (!("detectedAt" in receipt)) throw Error("Wrong detection receipt");
      const detected = receipt.detectedAt;
      if (!Number.isSafeInteger(detected) || detected < onset || detected > observed) throw Error("Inconsistent host loss clock");
      Object.assign(metrics, { lossToRelayDetectionMs: detected - onset, relayDetectionToObservedVisibleOfferMs: observed - detected,
        forcedClose: false, direction, transport: "Dropped application bytes on a still-open loopback path; no FIN/RST at onset." });
    } else {
      await host.context.close();
      await offer.waitFor({ timeout: 17_000 }); // Must precede the original 30-second authorization deadline.
      const receipt = await awaitBoundary(fixtureReceipt!, "committed offer receipt");
      if (!("offer" in receipt)) throw Error("Wrong offer receipt");
      const saved = receipt.offer;
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

// Emulate a relay's documented rate-limit closure on one ordinary delivery ACK.
// No overload traffic is generated; this cut is disallowed against production.
async function guestBackpressure(browser: Browser) {
  let armed = false, cutAt = 0, retriedAt = 0, original = "", restored = "", completion = "";
  const ready = Promise.withResolvers<void>();
  const room = await setupRoom(browser, 2, async ({ page }, index) => {
    if (index !== 1) return;
    await page.routeWebSocket("**", socket => {
      if (cutAt && !retriedAt) retriedAt = Date.now();
      const remote = socket.connectToServer();
      socket.onMessage(message => {
        const f = JSON.parse(message.toString());
        if (armed && !cutAt && f.kind === "delivery-ack") {
          cutAt = Date.now();
          socket.send(JSON.stringify({ kind: "secure-server", v: 4, suite: 1, type: "error", code: "rate-limited" }));
          socket.close({ code: 1008, reason: "rate limit exceeded" });
          remote.close();
          return;
        }
        if (restored && f.kind === "resume-complete") completion = f.requestId;
        remote.send(message);
      });
      remote.onMessage(message => {
        const f = JSON.parse(message.toString());
        if (f.type === "authenticated" && f.mode === "join") original = f.deviceId;
        if (f.type === "authenticated" && f.mode === "resume") restored = f.deviceId;
        socket.send(message);
        if (completion && f.type === "frame-accepted" && f.messageId === completion) ready.resolve();
      });
    });
  });
  const [host, guest] = room.participants;
  try {
    await deliver(guest.page, host.page, "before transport pressure");
    armed = true;
    await deliver(host.page, guest.page, "durable before limited ACK");
    await awaitBoundary(ready.promise, "authenticated guest resumed after rate-limit close");
    await deliver(guest.page, host.page, "recovered without readmission");
    await deliver(host.page, guest.page, "recipient still active");
    const copies = await guest.page.locator("#messages .chat-content").getByText("durable before limited ACK", { exact: true }).count();
    if (!cutAt || retriedAt - cutAt < 5000 || !original || restored !== original || copies !== 1)
      throw Error("Rate-limit recovery lost identity, retried early or duplicated delivery");
    return { fault: "guest-backpressure", retryDelayMs: retriedAt - cutAt, sameDevice: true, receivedCopies: copies, deliveredBothDirections: true };
  } finally { await closeRoom(room); }
}

async function healthyHost(browser: Browser) {
  const seen = new Set<string>(), echoed = new Set<string>();
  const two = Promise.withResolvers<void>();
  let offered = false;
  const room = await setupRoom(browser, 2, async ({ page }, index) => {
    page.on("websocket", socket => {
      socket.on("framereceived", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (index === 0 && f.type === "host-path-probe") seen.add(f.nonce);
        if (f.type === "host-transfer-authorized") offered = true;
      });
      if (index === 0) socket.on("framesent", ({ payload }) => {
        const f = JSON.parse(payload.toString());
        if (f.kind === "host-path-reply" && seen.has(f.nonce)) echoed.add(f.nonce);
        if (echoed.size >= 2) two.resolve();
      });
    });
  });
  try {
    await Promise.race([two.promise, wait(38_000).then(() => { throw Error("two healthy path exchanges not observed"); })]);
    await deliver(room.participants[1].page, room.participants[0].page, "still here after two checks");
    await deliver(room.participants[0].page, room.participants[1].page, "room remains active");
    if (offered) throw Error("unexpected host offer on a healthy path");
    return { fault: "healthy-host", distinctEchoedChallenges: echoed.size, offered, deliveredBothDirections: true };
  } finally { await closeRoom(room); }
}

async function fullRoom(browser: Browser) {
  const room = await setupRoom(browser, 20, undefined, origin, 3_000);
  try {
    const [host, ...peers] = room.participants;
    const extra = await newParticipant(browser);
    const denied = Promise.withResolvers<void>();
    extra.page.on("websocket", s => s.on("framereceived", ({ payload }) => {
      const f = JSON.parse(payload.toString());
      if (f.type === "error" && f.code === "member-limit") denied.resolve();
    }));
    try {
      await extra.page.goto(room.invitation);
      await extra.page.locator("#join-name").fill("Capacity Guest");
      await extra.page.getByRole("button", { name: "Join fort", exact: true }).click();
      await awaitBoundary(denied.promise, "21st device is refused");
      if (await host.page.locator("#btn-approve-admission").isVisible()) throw Error("over-capacity device offered for approval");
    } finally { await extra.context.close(); }
    const submittedToLastPeerMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const mark = `full-room message ${i}`, sender = peers[i].page;
      const start = performance.now();
      await deliver(sender, host.page, mark);
      await Promise.all(room.participants.map(({ page }) => page.waitForFunction(m => document.body.innerText.includes(m), mark, { timeout: 15_000 })));
      submittedToLastPeerMs.push(Math.round(performance.now() - start));
      await wait(1200);
    }
    await deliver(host.page, peers.at(-1)!.page, "room remains usable at capacity");
    return { fault: "full-room", admitted: 20, extraDeniedBeforeApproval: true, fullFanoutSamplesMs: submittedToLastPeerMs,
      scope: "20 isolated Chromium profiles, local relay, serial pace. UI measurement includes observer overhead; not maximum throughput." };
  } finally { await closeRoom(room); }
}

async function peerStorageFailure(browser: Browser) {
  let original = "", resumed = "";
  const trace: string[] = [];
  const room = await setupRoom(browser, 3, async ({ page }, index) => {
    if (index !== 2) return;
    page.on("websocket", socket => {
      socket.on("close", () => trace.push("close"));
      socket.on("framesent", ({ payload }) => { const f = JSON.parse(payload.toString()); trace.push(["out", f.kind, f.mode, f.relayKind].filter(Boolean).join("/")); });
      socket.on("framereceived", ({ payload }) => {
      const f = JSON.parse(payload.toString());
      trace.push(["in", f.type ?? f.kind, f.mode, f.code, f.frame?.kind, f.frame?.relayKind].filter(Boolean).join("/"));
      if (f.type === "authenticated" && f.mode === "join") original ||= f.deviceId;
      if (f.type === "authenticated" && f.mode === "resume") resumed = f.deviceId;
      });
    });
  });
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
    await reopen(room, 2);
    await failingPeer.page.waitForFunction(() => (globalThis as any).__pillowfortEvidenceFrames.some((f: any) => f.direction === "send" && f.kind === "resume-complete"), null, {timeout: 15_000}).catch(error => {
      report.storageTrace = trace; // Kinds only; never include private configuration or decrypted content.
      throw error;
    });
    await deliver(failingPeer.page, joiner.page, "retained device can reach newly added leaf");
    await deliver(joiner.page, failingPeer.page, "recovered device processes new epoch");
    if (!original || original !== resumed) throw Error("lost the retained guest after temporary storage failure");
    return { fault: "peer-membership-storage-failure", outcome: "unacknowledged-Add-replayed-on-original-device",
      recoveredOriginalDevice: true, encryptedChatWithNewLeafBothDirections: true,
      scope: "One transient IndexedDB failure and an intact prior state. Does not merge divergent branches or restore a missing key." };
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
    if (selectedFault === null || selectedFault === "guest-backpressure") results.push(await guestBackpressure(browser!));
    if (selectedFault === null || selectedFault === "peer-storage") results.push(await peerStorageFailure(browser!));
    if (selectedFault === null || selectedFault === "guest-resume-after-succession") results.push(await guestResumeAfterSuccession(browser!));
    if (selectedFault === null || selectedFault === "second-resume") results.push(await secondResume(browser!));
    if (selectedFault === null || selectedFault === "former-host-removal") results.push(await formerHostRemoval(browser!));
    if (selectedFault === null || selectedFault === "prompt-host-succession") results.push(await promptHostSuccession(browser!));
    if (selectedFault === "suspended-host" || selectedFault === "paused-host") results.push(await promptHostSuccession(browser!, selectedFault === "paused-host" ? "pause" : "freeze"));
    if (selectedFault === "healthy-host") results.push(await healthyHost(browser!));
    if (selectedFault === "full-room") results.push(await fullRoom(browser!));
    if (selectedFault === "lost-guest-keys") results.push(await lostGuestKeys(browser!));
    if (selectedFault === "natural-idle") results.push(await idleRetirement(browser!, selectedFault));
    if (workerCut === "idle-retirement" || workerCut === "idle-retirement-prefix") results.push(await idleRetirement(browser!, workerCut));
    else if (workerCut) results.push(await workerdHandoff(browser!, workerCut));
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
