// Private loopback qualification only. Observers and relay never suspend with the original host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";

type Condition = "network" | "suspend" | "reply" | "close" | "absence";
interface Client { data: { upstream?: WebSocket; url: string }; readyState: number; send(s: string): unknown; close(code?: number, reason?: string): void }
interface Room { participants: { page: Page }[] }
type Configure = (p: { page: Page }, index: number) => Promise<void>;
const now = () => Math.round(performance.now());
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const guard = AbortSignal.timeout(ms);
  return Promise.race([p, new Promise<never>((_, reject) => guard.addEventListener("abort", () => reject(Error(`Timed out: ${label}`)), { once: true }))]);
}

// A second browser instance keeps the participants and stopwatch out of the host's process set.
async function browserSleep(host: Browser) {
  const session = await host.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const ids = [...new Set(processInfo.map(p => p.id))];
  assert(processInfo.some(p => p.type === "browser") && processInfo.some(p => p.type === "renderer"));
  assert(ids.every(id => Number.isSafeInteger(id) && id > 1 && id !== process.pid && id !== process.ppid));
  await session.detach();
  const stopped: number[] = [];
  function resume() { for (const id of stopped.splice(0)) { try { process.kill(id, "SIGCONT"); } catch (e: any) { if (e.code !== "ESRCH") throw e; } } }
  return { pause() { try { for (const id of ids) { process.kill(id, "SIGSTOP"); stopped.push(id); } } catch (e) { resume(); throw e; } },
    confirm() { const states = execFileSync("ps", ["-o", "state=", "-p", ids.join(",")], { encoding: "utf8" }).trim().split(/\s+/);
      assert(states.length === ids.length && states.every(s => s.includes("T")), "not all reported host-browser processes stopped"); return states.length; }, resume };
}

// Forward genuine messages on the original socket. Never construct a probe answer or reconnect
// using a saved credential. If fencing closes the socket, do not replay held bytes on its replacement.
function hostGateway(origin: string, condition: Condition, holdMs: number) {
  const started = Promise.withResolvers<number>(), restored = Promise.withResolvers<number>(), nextAnswer = Promise.withResolvers<void>();
  let phase: "idle" | "armed" | "hold" | "restored" = "idle", nonce = "", lastChallenge = "";
  let original: Client | undefined, sleep: Awaited<ReturnType<typeof browserSleep>> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let originalClosedAt: number | null = null, heldMatchingReplies = 0, forwardedMatchingReplies = 0, processesStopped = 0;
  const queue: (() => void)[] = [];
  function release() { sleep?.resume(); phase = "restored"; for (const flush of queue.splice(0)) flush(); restored.resolve(now()); }
  function forward(c: Client, text: string, fromHost: boolean) {
    const msg = JSON.parse(text);
    const first = !fromHost && msg.type === "host-path-probe" && msg.nonce !== lastChallenge;
    if (!fromHost && msg.type === "host-path-probe") lastChallenge = msg.nonce;
    const isReply = fromHost && msg.kind === "host-path-reply";
    const emit = () => {
      if (c.readyState !== 1 || c.data.upstream?.readyState !== WebSocket.OPEN) return;
      if (fromHost) c.data.upstream.send(text); else c.send(text);
      if (isReply && c === original && msg.nonce === nonce) forwardedMatchingReplies++;
      if (phase === "restored" && isReply && c === original && msg.nonce === lastChallenge && msg.nonce !== nonce) nextAnswer.resolve();
    };
    if (phase === "armed" && first) {
      const t = now(); phase = "hold"; nonce = msg.nonce; original = c;
      started.resolve(t); timer = setTimeout(release, holdMs);
      if (condition === "suspend") { sleep!.pause(); setTimeout(() => { try { processesStopped = sleep!.confirm(); } catch (e) { restored.reject(e); } }, 80); }
      if (condition === "close") { c.data.upstream!.close(1001, "private test link disconnected"); c.close(1001, "private test link disconnected"); return; }
    }
    if (phase === "hold" && c === original && (condition === "network" || condition === "absence" || condition === "reply" && isReply && msg.nonce === nonce)) {
      if (isReply && msg.nonce === nonce) heldMatchingReplies++;
      queue.push(emit); return;
    }
    emit();
  }
  const server = Bun.serve<{ upstream?: WebSocket; url: string }>({ hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      const url = new URL(req.url); const target = new URL(url.pathname + url.search, origin);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (req.headers.get("origin") !== url.origin || url.pathname !== "/ws") return new Response(null, {status:403});
        if (phase === "hold" && condition === "close") return new Response(null, {status:503});
        target.protocol = "ws:";
        if (server.upgrade(req, {data:{url:target.href}})) return;
        return new Response(null, {status:400});
      }
      // Same-origin assets keep the application CSP intact. Do not relay the browser's
      // Host or compressed length: fetch decodes content, and this authority is different.
      const headers = new Headers(req.headers);
      for (const key of ["host", "connection", "content-length"]) headers.delete(key);
      headers.set("accept-encoding", "identity");
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await fetch(target.href, {method:req.method, headers, redirect:"manual", body:hasBody ? await req.arrayBuffer() : undefined});
      const outgoing = new Headers(response.headers);
      outgoing.delete("content-encoding"); outgoing.delete("content-length");
      const body = req.method === "HEAD" || [204,205,304].includes(response.status) ? null : await response.arrayBuffer();
      return new Response(body, {status:response.status, headers:outgoing});
    },
    websocket: {
      open(c) { const upstream = new WebSocket(c.data.url, {headers:{Origin: origin}}); c.data.upstream = upstream;
        upstream.onmessage = e => forward(c, String(e.data), false);
        upstream.onclose = () => { if (c === original && originalClosedAt === null) originalClosedAt = now(); if (c.readyState === 1) c.close(1012, "upstream closed"); };
        upstream.onerror = () => { if (c.readyState === 1) c.close(1011, "upstream unavailable"); }; },
      message(c, text) { forward(c, text.toString(), true); },
      close(c) { if (c === original && originalClosedAt === null) originalClosedAt = now(); c.data.upstream?.close(); },
    } });
  return { origin: `http://127.0.0.1:${server.port}`, started: started.promise, restored: restored.promise, nextAnswer: nextAnswer.promise,
    arm(stopper?: typeof sleep) { sleep = stopper; phase = "armed"; },
    metrics() { return { originalClosedAt, heldMatchingReplies, forwardedMatchingReplies, processesStopped }; },
    stop() { clearTimeout(timer); sleep?.resume(); server.stop(true); } };
}

export async function prematureSuccession<T extends Room>(origin: string,
  setup: (host: Browser, configure: Configure, hostOrigin: string) => Promise<T>, close: (r: T) => Promise<void>,
  deliver: (from: Page, to: Page, marker: string) => Promise<number>) {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const setting = process.env.PILLOWFORT_STUDY_CASE ?? "";
  const match = /^(network|suspend|reply|close|absence)-(\d+)$/.exec(setting);
  assert(match && (match[1] === "absence" ? match[2] === "52000" : [3000,12000,18000].includes(Number(match[2]))), "expected a named local trial and hold duration");
  const condition = match[1] as Condition, holdMs = Number(match[2]);
  const hostBrowser = await chromium.launch(); const gate = hostGateway(origin, condition, holdMs);
  let room: T | undefined, policyFrame = "", candidateId = "", acceptAt: number | null = null, switchAt: number | null = null;
  const offers = new Set<string>(), policy = Promise.withResolvers<void>(), visible = Promise.withResolvers<number>();
  let firstOfferAt: number | null = null, observing = true;
  try {
    room = await setup(hostBrowser, async ({page}, i) => {
      page.on("websocket", ws => {
        ws.on("framesent", ({payload}) => { const f = JSON.parse(payload.toString()), a = f.authorityEvent?.content;
          if (i === 0 && a?.type === "host-succession-policy" && a.deviceIds.length === 2) policyFrame = f.envelope.messageId;
          if (i === 1 && a?.type === "host-succession" && a.action === "accept") acceptAt ??= now(); });
        ws.on("framereceived", ({payload}) => { const f = JSON.parse(payload.toString());
          if (i === 0 && policyFrame && f.type === "application-result" && f.result === "accepted" && f.messageId === policyFrame) policy.resolve();
          if (i === 1 && f.type === "authenticated") candidateId = f.deviceId;
          if (observing && i === 1 && f.type === "host-transfer-authorized") { offers.add(f.authorizationId); firstOfferAt ??= now(); }
          if (observing && i === 2 && f.type === "host-changed" && f.deviceId === candidateId) switchAt ??= now(); });
      });
    }, gate.origin);
    const [old, candidate, sender] = room.participants.map(p => p.page);
    await within(policy.promise, 8000, "two eligible devices in accepted policy");
    await deliver(sender, candidate, "before controlled interruption");
    const stopper = condition === "suspend" ? await browserSleep(hostBrowser) : undefined;
    const offer = candidate.locator("#host-offer-overlay");
    void offer.waitFor({timeout:75000}).then(() => visible.resolve(now()), () => {});
    gate.arm(stopper);
    const start = await within(gate.started, 18000, "fresh relay challenge");
    let duringHoldChatAtMs: number | null = null;
    if (condition === "reply") {
      await deliver(sender, candidate, "ordinary traffic while only the reachability reply is delayed");
      duringHoldChatAtMs = now() - start;
      assert(duringHoldChatAtMs < holdMs && firstOfferAt === null);
    }
    // For the long-absence comparison, accept on observation instead of waiting for restoration.
    // The host remains unavailable through the receiver's first ordinary message in both runs.
    const absence = condition === "absence";
    const end = absence ? null : await within(gate.restored, holdMs + 6000, "controlled recovery");
    if (absence) await within(visible.promise, 50000, "offer while original host is still absent");
    assert.equal(acceptAt, null); assert.equal(switchAt, null);
    const offerObserved = firstOfferAt !== null;
    if (absence) assert(offerObserved);
    let visibleAt: number | null = null;
    if (offerObserved) {
      visibleAt = await within(visible.promise, 4000, "offer on candidate surface");
      await candidate.locator("#btn-catch").click();
      await candidate.getByText("Buddies (2)", { exact:true }).waitFor({timeout:15000});
    }
    await deliver(sender, candidate, "ordinary message after controlled interruption");
    const received = now();
    if (!offerObserved) {
      await deliver(old, sender, "original host still validates and communicates");
      await within(gate.nextAnswer, 28000, "fresh challenge answered on original socket after recovery");
      assert.equal(firstOfferAt, null); assert.equal(switchAt, null);
    } else { assert(acceptAt !== null && switchAt !== null && switchAt >= acceptAt && (end === null || acceptAt >= end)); }
    assert.equal(offers.size, offerObserved ? 1 : 0);
    if (absence) assert(received-start < holdMs, "original host returned before traffic was observed");
    const m = gate.metrics(); if (condition === "reply") assert(m.heldMatchingReplies >= 1);
    if (condition === "suspend") assert(m.processesStopped > 1);
    const elapsed = (t: number | null) => t === null ? null : t-start;
    return { setting, controlExtraFinalWaitMs: Number(process.env.PILLOWFORT_STUDY_EXTRA_MS || 0), holdRequestedMs: holdMs, holdObservedMs: end === null ? null : end-start,
      duringHoldChatAtMs, offers:offers.size, originalRetained: !offerObserved, signedAcceptances: acceptAt === null ? 0 : 1,
      offerAtMs: elapsed(firstOfferAt), visibleAtMs: elapsed(visibleAt), acceptanceAtMs: elapsed(acceptAt), peerObservedChangeAtMs: elapsed(switchAt),
      originalSocketClosedAtMs: elapsed(m.originalClosedAt), matchingRepliesHeld: m.heldMatchingReplies, matchingRepliesForwardedWhileOpen: m.forwardedMatchingReplies,
      hostBrowserProcessesStopped: m.processesStopped, ordinaryChatAtReceiverMs: received-start, restorationToReceiverMs: end === null ? null : received-end };
  } finally { observing = false; gate.stop(); if (room) await close(room); await hostBrowser.close(); }
}
