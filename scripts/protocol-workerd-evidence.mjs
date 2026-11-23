// Run one isolated three-browser scenario. No deployed binding or admin route.
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const [fault, directory] = process.argv.slice(2);
if (!["persisted-offer", "silent-host-loss", "silent-host-uplink", "silent-host-downlink", "probe-restart"].includes(fault) || !directory) throw Error("Usage: node scripts/protocol-workerd-evidence.mjs persisted-offer|silent-host-{loss,uplink,downlink}|probe-restart OUTPUT");
const output = resolve(directory);
await mkdir(output, { recursive: true });
const disk = await mkdtemp(join(tmpdir(), "pillowfort-workerd-"));
const bundle = await build({ entryPoints: ["scripts/qualification-worker.mjs"], format: "esm", target: "es2022", bundle: true, write: false });
const worker = "pillowfort-qualification";
let cut, woke, evicted = false, evictionError, evict;
let mf;
try {
  mf = new Miniflare({ host: "127.0.0.1", port: 0, cf: false, unsafeInspectDurableObjects: true,
    resourcePersistencePath: disk, logRequests: false, workers: [{ config: {
      name: worker, compatibilityDate: "2026-07-20",
      manifest: { mainModule: "fixture.mjs", modules: { "fixture.mjs": { type: "esm", contents: bundle.outputFiles[0].text } } },
      exports: { Room: { type: "durable-object", storage: "legacy-kv" } },
      assets: { directory: resolve("client/dist"), hasUserWorker: true, runWorkerFirst: true },
      env: { ROOM: { type: "durable-object", worker, exportName: "Room" }, ASSETS: { type: "assets" },
        CUT: { type: "text", value: fault }, EVIDENCE: { type: "fetcher", handler: async request => {
      const event = await request.json();
      if (event.kind === "cut" && !cut) {
        cut = event;
        await writeFile(join(disk, "cut.json"), JSON.stringify(event.offer));
        // Return from the instrumented handler first; no request is sent to wake it.
        evict = new Promise(done => setImmediate(done)).then(async () => {
          await mf.unsafeEvictDurableObject(worker, "Room", { name: event.room, webSockets: "hibernate" });
          evicted = true;
        }).catch(e => { evictionError = String(e); });
      } else if (event.kind === "awoke" && cut && event.room === cut.room && event.instance !== cut.instance && (fault !== "probe-restart" || event.nonce === cut.offer.nonce && Number.isSafeInteger(cut.idle) && event.idle === cut.idle)) woke = true;
      else if (event.kind === "detected" && fault.startsWith("silent-host-")) await writeFile(join(disk, "detected.json"), JSON.stringify(event.at));
      return new Response(null, { status: 204 });
    } } },
    } }] });
  const origin = (await mf.ready).origin;
  const landing = await fetch(origin, { redirect: "manual" });
  if (!landing.ok) throw Error(`Local fixture did not serve the app: ${landing.status}: ${(await landing.text()).slice(0,300)}`);
  const child = spawn("bun", ["scripts/protocol-browser-evidence.ts", "--mode", "faults", "--fault", fault, "--output", output], {
    env: { ...process.env, PILLOWFORT_QUALIFICATION_ORIGIN: origin, PILLOWFORT_QUALIFICATION_CUTS: disk }, stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  await evict;
  if (fault === "persisted-offer" || fault === "probe-restart") await writeFile(join(output, "eviction.json"), JSON.stringify({ cutAfterCommit: !!cut, socketsHibernated: evicted, recoveredExactPendingWork: !!woke, ...(fault === "probe-restart" && { originalIdleDeadlineUnchanged: !!woke }), evictionError: evictionError ?? null }, null, 2) + "\n");
  if (code !== 0 || evictionError || ["persisted-offer", "probe-restart"].includes(fault) && (!cut || !evicted || !woke)) process.exitCode = 1;
} finally { await mf?.dispose(); await rm(disk, { recursive: true, force: true }); }
