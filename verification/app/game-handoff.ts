// One disposable v4 relay and room per process, using the real npm JSONL founder and SDK guests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
const [game, output, pkg, target] = process.argv.slice(2);
if (target !== undefined && (target !== "--production" || game !== "fresh-admission"))
  throw Error("Production covers only one normal, self-owned successor-admission journey");
if (
  !["ttt", "rps", "koth", "vote", "saboteur", "breakout", "fresh-admission", "all-decline"].includes(game) ||
  !output ||
  !pkg
)
  throw Error("Usage: node verification/app/game-handoff.ts GAME OUTPUT INSTALLED_PACKAGE_DIRECTORY [--production]");
const { PillowfortAgent } = await import(pathToFileURL(resolve(pkg, "scripts/agent-sdk.mjs")).href);
const relay = target ? null : spawn("bun", ["-e", 'import {startLocalServer} from "./server.ts"; startLocalServer(0);'], {
  stdio: ["ignore", "pipe", "inherit"],
});
const relayLines = relay ? createInterface({ input: relay.stdout }) : null;
const [ready] = relayLines ? await once(relayLines, "line") : [""];
const port = /^pillowfort :(\d+)$/.exec(ready)?.[1];
if (relay && !port) {
  relay.kill();
  throw Error("Local relay did not start");
}
const url = target ? "https://pillowfort.xyz" : `http://127.0.0.1:${port}`,
  sdk = new PillowfortAgent({ baseURL: url });
const child = spawn("node", [resolve(pkg, "scripts/agent.mjs"), "jsonl", "--url", url], {
  stdio: ["pipe", "pipe", "ignore"],
});
const exited = new Promise<void>((r) => child.once("exit", () => r()));
let id = 0;
const waiting = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  waiting.get(msg.id)?.resolve(msg);
});
child.once("close", () => {
  for (const pending of waiting.values()) pending.reject(Error("JSONL process closed before replying"));
});
async function cli(tool: string, args: object = {}) {
  const n = ++id;
  const pending = Promise.withResolvers<any>();
  waiting.set(n, pending);
  const deadline = setTimeout(() => pending.reject(Error(`JSONL ${tool} timed out`)), 35_000);
  try {
    child.stdin.write(JSON.stringify({ id: n, tool, arguments: args }) + "\n");
    const reply = await pending.promise;
    if (!reply.ok) throw Error(tool + ": " + reply.error.code);
    return reply.data;
  } finally {
    clearTimeout(deadline);
    waiting.delete(n);
  }
}
let host = "",
  room = "",
  invite = "",
  at = "JSONL founder";
const checks: string[] = [];
const errors: string[] = [];
const act = async (who: string, n: string, input: object = {}) => {
  if (who === "Host") return cli(n, { session: host, input: { roomId: room, ...input } });
  const r = await sdk.execute(who, n, { roomId: room, ...input });
  if (!r.ok) throw Error(n + ": " + r.error.code);
  return r.data;
};
const read = (who: string) => (who === "Host" ? cli("session_observe", { session: host }) : sdk.observe(who));
async function see(who: string, test: (s: any) => boolean) {
  const deadline = Date.now() + 18_000;
  let s = await read(who);
  while (!test(s)) {
    if (Date.now() > deadline)
      throw Error(
        who +
          " did not observe " +
          at +
          "; screen=" +
          s.connection.screen +
          "; approval=" +
          !!s.room.pendingJoinFingerprint +
          "; host=" +
          s.connection.isHost +
          "; display=" +
          s.connection.terminalPresentation +
          "; error=" +
          s.error,
      );
    s =
      who === "Host"
        ? await cli("session_wait", { session: host, afterRevision: s.revision, timeoutMs: 1000 })
        : await sdk.wait(who, s.revision, 1000);
  }
  return s;
}
async function enter(name: string, authority: string, accept = true) {
  const step = at;
  at = step + " / " + name + " requests";
  await sdk.createSession(name);
  let r = await sdk.execute(name, "room_join_link", {
    displayName: name,
    invitationUrl: invite,
    confirm: true,
  });
  assert(r.ok);
  const pending = await see(name, (s) => !!s.room.pendingJoinFingerprint),
    fp = pending.room.pendingJoinFingerprint;
  at = step + " / owner sees " + name;
  const owner = await see(authority, (s) =>
    s.room.pendingAdmissions.some((a: any) => a.deviceFingerprint === fp && a.status === "pending"),
  );
  const a = owner.room.pendingAdmissions.find(
    (a: any) => a.deviceFingerprint === fp && a.status === "pending",
  );
  await act(authority, accept ? "admission_approve" : "admission_reject", {
    admissionId: a.admissionId,
    deviceFingerprint: fp,
    confirm: true,
  });
  at = step + " / " + name + " observes decision";
  if (!accept) {
    await see(name, (s) => !s.connection.connecting && !s.legalActions.canAct);
    await see(
      authority,
      (s) => !s.room.pendingAdmissions.length && !s.room.members.some((m: any) => m.name === name),
    );
    await sdk.closeSession(name);
    at = step;
    return;
  }
  await see(name, (s) => s.connection.roomId === room && s.legalActions.canAct);
  await see(authority, (s) => s.room.members.some((m: any) => m.name === name));
  at = step;
}
async function openGame(owner: string) {
  if (game === "ttt" || game === "rps") {
    await act("Alpha", game + "_challenge", { target: "Beta" });
    await see("Beta", (s) => s.games[game]?.phase === "challenged");
    await act("Beta", game + "_accept");
    await see("Alpha", (s) => s.games[game]?.phase === (game === "ttt" ? "playing" : "picking"));
    if (game === "ttt") {
      await act("Alpha", "ttt_move", { cell: 4 });
      await see("Beta", (s) => !!s.games.ttt?.board[4]);
    }
  } else if (game === "koth") {
    await act("Beta", "koth_challenge", { confirm: true });
    await see(owner, (s) => s.games.rps?.koth && s.games.rps.phase === "picking");
  } else if (game === "vote") {
    await act("Alpha", "vote_start", { target: "Beta", confirm: true });
    await see("Gamma", (s) => s.games.vote?.target === "Beta");
  } else if (game === "saboteur") {
    await act(owner, "saboteur_start");
    for (const name of ["Alpha", "Beta", "Gamma", "Fourth"])
      await see(name, (s) => !!s.games.saboteur.myRole && s.legalActions.canAct);
  } else {
    await act("Beta", "breakout_start");
    await see("Beta", (s) => s.breakout != null);
    await act("Beta", "breakout_move", { x: 0.25 });
  }
}
async function exercise() {
  host = (await cli("session_create")).session;
  const made = await cli("room_setup", { session: host, input: { displayName: "Host", confirm: true } });
  room = made.roomId;
  invite = made.invitationUrl;
  await see("Host", (s) => s.connection.roomId === room && s.connection.isHost && s.legalActions.canAct);
  checks.push(at);
  at = "exact rejection";
  if (game === "ttt") {
    await enter("Visitor", "Host", false);
    checks.push(at);
  }
  at = "admit independent SDK participants";
  for (const n of game === "saboteur" ? ["Alpha", "Beta", "Gamma", "Fourth"] : ["Alpha", "Beta", "Gamma"])
    await enter(n, "Host");
  checks.push(at);
  if (game === "rps") {
    at = "mute and unmute";
    await act("Beta", "member_mute", { target: "Alpha", muted: true });
    await act("Alpha", "chat_send", { text: "@Beta before unmute" });
    await see("Gamma", (s) => s.messages.some((m: any) => m.text === "@Beta before unmute"));
    await act("Beta", "member_mute", { target: "Alpha", muted: false });
    await act("Alpha", "chat_send", { text: "@Beta after unmute" });
    let seen = await see("Beta", (s) =>
      s.mentions.messages.some((m: any) => m.text === "@Beta after unmute"),
    );
    assert(!seen.mentions.messages.some((m: any) => m.text === "@Beta before unmute"));
    checks.push(at);
  }
  if (game !== "fresh-admission" && game !== "all-decline") {
    at = "active " + game;
    await openGame("Host");
    checks.push(at);
  }
  at = "observed founder disconnect and voluntary catch";
  child.stdin.end();
  await exited;
  await see("Alpha", (s) => !!s.room.hostOffer && !s.connection.isHost);
  if (game === "all-decline") {
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      at = name + " may decline without becoming the host";
      await see(name, s => !!s.room.hostOffer && !s.connection.isHost);
      await act(name, "host_reject", { confirm: true });
      checks.push(at);
    }
    at = "room retired on every refusing device";
    for (const name of ["Alpha", "Beta", "Gamma"]) await see(name, s =>
      s.connection.terminalPresentation === "room-destroyed" && !s.connection.roomId && !s.legalActions.canAct);
    checks.push(at);
    return;
  }
  await act("Alpha", "host_accept", { confirm: true });
  for (const name of ["Alpha", "Beta", "Gamma"])
    await see(
      name,
      (s) =>
        s.room.host === "Alpha" &&
        s.room.members.length === (game === "saboteur" ? 4 : 3) &&
        !s.room.members.some((m: any) => m.name === "Host"),
    );
  checks.push(at);
  at =
    game === "fresh-admission"
      ? "admission with the successor-exported invite"
      : "post-change game semantics";
  if (game === "fresh-admission") {
    await sdk.createSession("OldInvite");
    const attempt = await sdk.execute("OldInvite", "room_join_link", { invitationUrl: invite, displayName: "Visitor", confirm: true });
    assert(attempt.ok);
    await see("OldInvite", s => s.operations.some((op: any) => op.error?.code === "invitation-host-changed"));
    const current = await read("Alpha");
    assert(!current.room.pendingAdmissions.length && !current.room.members.some((m: any) => m.name === "Visitor"));
    await sdk.closeSession("OldInvite");
    checks.push("old founder invite refused before asking anyone to approve");
    await act("Alpha", "chat_send", { text: "before Delta joined" });
    await see("Beta", s => s.messages.some((m: any) => m.text === "before Delta joined"));
    invite = (await act("Alpha", "invitation_export", { confirm: true })).invitationUrl;
    await enter("Delta", "Alpha");
    assert(!(await read("Delta")).messages.some((m: any) => m.text === "before Delta joined"));
    await act("Delta", "chat_send", { text: "newcomer under successor" });
    await see("Alpha", s => s.messages.some((m: any) => m.from === "Delta" && m.text === "newcomer under successor"));
    checks.push("newcomer has no prior chat and its new encrypted message reaches the successor");
  } else if (game === "breakout") {
    await act("Beta", "breakout_move", { x: 0.75 });
    await act("Beta", "breakout_stop", { confirm: true });
  } else {
    for (const n of ["Alpha", "Beta", "Gamma"])
      await see(
        n,
        (s) =>
          !s.games.queue.current && !s.games.vote && !s.games.ttt && !s.games.rps && !s.games.saboteur.myRole,
      );
    at = "restart " + game + " under successor";
    await openGame("Alpha");
  }
  checks.push(at);
  at = "surviving room delivers fresh encrypted chat";
  await act("Alpha", "chat_send", { text: "new host can send" });
  await see("Beta", (s) => s.messages.some((m: any) => m.text === "new host can send" && m.from === "Alpha"));
  await act("Beta", "chat_send", { text: "peer can answer" });
  await see("Alpha", (s) => s.messages.some((m: any) => m.text === "peer can answer" && m.from === "Beta"));
  checks.push(at);
  at = "successor-authorized closure";
  await act("Alpha", "room_end", { confirm: true });
  await see("Beta", (s) => s.connection.terminalPresentation === "room-destroyed");
  checks.push(at);
}
try {
  await exercise();
} catch (e) {
  errors.push(
    at +
      ": " +
      (e as Error).message
        .split("\n")[0]
        .replace(/https?:\/\/\S+|pf[23]_[\w-]+|f-[a-z2-7]{10}/g, "[private]"),
  );
} finally {
  if (!child.stdin.destroyed) child.stdin.end();
  await sdk.close();
  await exited;
  lines.close();
  relayLines?.close();
  relay?.kill();
  await writeFile(output, JSON.stringify({ game, checks, errors }, null, 2) + "\n");
  console.log(game, checks, errors);
}
process.exit(errors.length ? 1 : 0);
