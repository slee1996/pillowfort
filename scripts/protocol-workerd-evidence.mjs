// Run one isolated browser scenario. No deployed binding or admin route.
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const [fault, directory] = process.argv.slice(2);
const idleCut = fault === "idle-retirement" || fault === "idle-retirement-prefix";
const sleepStudy = fault === "physical-sleep" || fault === "sleep-awake-control";
const powerEvents = [], switches = [];
const replayCut = fault === "offline-two-transfers";
const restartCut = replayCut || idleCut || fault === "probe-restart" || fault === "persisted-offer";
if ((!restartCut && !sleepStudy && !["silent-host-loss", "silent-host-uplink", "silent-host-downlink", "premature-succession", "terminal-storage"].includes(fault)) || !directory) throw Error("Usage: node scripts/protocol-workerd-evidence.mjs persisted-offer|silent-host-{loss,uplink,downlink}|probe-restart|idle-retirement[-prefix]|premature-succession|terminal-storage|offline-two-transfers|physical-sleep|sleep-awake-control OUTPUT");
const extra = Number(process.env.PILLOWFORT_STUDY_EXTRA_MS || 0);
if (![0, 30000].includes(extra) || extra && fault !== "premature-succession" && !sleepStudy) throw Error("Invalid study control");
const output = resolve(directory);
await mkdir(output, { recursive: !sleepStudy }); // Preserve independent hardware observations.
const disk = await mkdtemp(join(tmpdir(), "pillowfort-workerd-"));
const bundle = await build({ entryPoints: ["scripts/qualification-worker.mjs"], format: "esm", target: "es2022", bundle: true, write: false });
const worker = "pillowfort-qualification";
let cut, woke, evicted = false, evictionError, evict;
let mf, child, studyPolicy, published = false;
// The browser observes the network effect independently; the measured relay
// timestamp/offer may arrive later. Deliver one complete record, never a file prefix.
function publishReceipt(receipt) {
  if (!published) { published = true; child.send(receipt); }
}
try {
  mf = new Miniflare({ host: "127.0.0.1", port: 0, cf: false, unsafeInspectDurableObjects: true,
    resourcePersistencePath: disk, logRequests: false, workers: [{ config: {
      name: worker, compatibilityDate: "2026-07-20",
      manifest: { mainModule: "fixture.mjs", modules: { "fixture.mjs": { type: "esm", contents: bundle.outputFiles[0].text } } },
      exports: { Room: { type: "durable-object", storage: "legacy-kv" } },
      assets: { directory: resolve(process.env.PILLOWFORT_QUALIFICATION_ASSETS || "client/dist"), hasUserWorker: true, runWorkerFirst: true },
      env: { ROOM: { type: "durable-object", worker, exportName: "Room" }, ASSETS: { type: "assets" },
        STUDY_EXTRA_MS: { type: "text", value: String(extra) }, CUT: { type: "text", value: fault }, EVIDENCE: { type: "fetcher", handler: async request => {
      const event = await request.json();
      if (sleepStudy && event.kind === "power-observation") {
        powerEvents.push({event:event.event, at:event.at});
        if (event.event === "policy-ready") studyPolicy = event.policy;
        if (event.event === "original-probe-reply-committed" && studyPolicy) publishReceipt({studyPolicy});
      } else if (replayCut && event.kind === "switch") switches.push(event);
      else if (event.kind === "cut" && !cut) {
        cut = event;
        if (fault === "persisted-offer") publishReceipt({ offer: event.offer });
        // Return from the instrumented handler first; no request is sent to wake it.
        evict = new Promise(done => setImmediate(done)).then(async () => {
          await mf.unsafeEvictDurableObject(worker, "Room", { name: event.room, webSockets: "hibernate" });
          evicted = true;
          if (replayCut) publishReceipt({ checkpoint: event.checkpoint });
        }).catch(e => { evictionError = String(e); });
      } else if (replayCut && event.kind === "cut" && cut && event.room === cut.room && event.instance !== cut.instance &&
          event.checkpoint.host === cut.checkpoint.host && event.checkpoint.policy === cut.checkpoint.policy && event.checkpoint.revision >= cut.checkpoint.revision) woke = true;
      else if (!replayCut && event.kind === "awoke" && cut && event.room === cut.room && event.instance !== cut.instance && (fault !== "probe-restart" || event.nonce === cut.offer.nonce && Number.isSafeInteger(cut.idle) && event.idle === cut.idle)) woke = true;
      else if (idleCut && cut?.deletionCommitted && event.kind === "terminal-replayed" && event.instance !== cut.instance) woke = true;
      else if (event.kind === "detected" && fault.startsWith("silent-host-")) publishReceipt({ detectedAt: event.at });
      return new Response(null, { status: 204 });
    } } },
    } }] });
  const origin = (await mf.ready).origin;
  const landing = await fetch(origin, { redirect: "manual" });
  if (!landing.ok) throw Error(`Local fixture did not serve the app: ${landing.status}: ${(await landing.text()).slice(0,300)}`);
  child = spawn("bun", ["scripts/protocol-browser-evidence.ts", "--mode", "faults", "--fault", fault, "--output", output], {
    env: { ...process.env, PILLOWFORT_QUALIFICATION_ORIGIN: origin },
    stdio: ["inherit", "inherit", "inherit", "ipc"], serialization: "json",
  });
  const [code] = await once(child, "exit");
  await evict;
  if (sleepStudy) {
    await writeFile(join(output,"relay-observations.json"), JSON.stringify({fault,extraFinalWaitMs:extra,events:powerEvents},null,2)+"\n");
    if (!powerEvents.some(x=>x.event==="policy-ready") || !powerEvents.some(x=>x.event==="original-probe-reply-committed")) process.exitCode=1;
  }
  const bothDisconnected = replayCut && switches.length === 2 && switches.every((s,i)=>s.room === cut?.room && s.holderRank === i+2 && s.observerDisconnected) &&
    switches[0].instance === cut.instance && switches[1].instance !== cut.instance;
  if (replayCut && !bothDisconnected) process.exitCode=1;
  if (restartCut) await writeFile(join(output, "eviction.json"), JSON.stringify({ cutAfterCommit: !!cut, socketsHibernated: evicted, recoveredExactPendingWork: !!woke, ...(replayCut && { distinctInstanceObservedWithFirstSuccessorPolicy: !!woke, guestDisconnectedAtBothDurableSwitches: !!bothDisconnected }), ...(idleCut && { deletionCommitted: cut?.deletionCommitted === true, sentBeforeInterruption: cut?.sent }), ...(fault === "probe-restart" && { originalIdleDeadlineUnchanged: !!woke }), evictionError: evictionError ?? null }, null, 2) + "\n");
  if (code !== 0 || evictionError || restartCut && (!cut || !evicted || !woke || idleCut && cut.sent !== (fault === "idle-retirement-prefix" ? 1 : 0))) process.exitCode = 1;
} finally { await mf?.dispose(); await rm(disk, { recursive: true, force: true }); }
