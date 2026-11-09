import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { StdioWire, SUBSCRIPTION, changeAndRearm, mentionUri, turn } from "./mcp-wire";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const wire = new StdioWire();
  cleanups.push(() => wire.close());
  return wire;
}
const mentionResource = z.object({
  session: z.string(), revision: z.number(), ephemeral: z.boolean(), liveOnly: z.boolean(),
  latestMessageId: z.number(), retainedCount: z.number(),
  messages: z.array(z.object({ id: z.number(), from: z.string(), text: z.string(), mentions: z.array(z.string()) })),
});
async function read(wire: StdioWire, uri: string) {
  const result = await wire.result("resources/read", { uri });
  expect(result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
  const contents = z.array(z.object({ text: z.string() })).parse(result.contents);
  return mentionResource.parse(JSON.parse(contents[0].text));
}

test("real modern wire delivers URI-only own mentions and retains tools, resources and prompts", async () => {
  const wire = fixture();
  const { agent } = wire;
  const receiver = await wire.create();
  const other = await wire.create("Other");
  await changeAndRearm(agent, () => receiver.store.getState().addChatMessage("Sender", "@Receiver before listening"));
  expect(wire.updates()).toEqual([]);
  expect((await wire.result("server/discover")).capabilities).toMatchObject({ resources: { subscribe: true } });
  expect((await wire.result("resources/templates/list")).resourceTemplates).toMatchObject([{ uriTemplate: "pillowfort://sessions/{session}/mentions" }]);
  expect((await wire.result("resources/list")).resources).toContainEqual(expect.objectContaining({ uri: "pillowfort://agents/security" }));
  expect((await wire.result("resources/read", { uri: "pillowfort://agents/security" })).contents).toHaveLength(1);
  expect((await wire.result("prompts/list")).prompts).toContainEqual(expect.objectContaining({ name: "join_room" }));
  const prompt = await wire.result("prompts/get", { name: "join_room" });
  expect(z.array(z.unknown()).parse(prompt.messages).length).toBeGreaterThan(1);
  expect((await wire.result("tools/list")).tools).toContainEqual(expect.objectContaining({ name: "session_observe" }));
  expect((await wire.tool("session_observe", { session: receiver.session })).isError).toBe(false);

  const subscription = await wire.listen([receiver.uri]);
  expect(agent.pendingWaits).toBe(2);
  await changeAndRearm(agent, () => receiver.store.getState().addChatMessage("Sender", "not a mention: email@Receiver @Receivers"));
  await changeAndRearm(agent, () => receiver.store.getState().addChatMessage("Receiver", "@Receiver self"));
  await changeAndRearm(agent, () => receiver.store.getState().addSystemMessage("@Receiver system"));
  await changeAndRearm(agent, () => receiver.store.getState().addChatMessage("Sender", "@Receiver replay", undefined, true));
  await changeAndRearm(agent, () => receiver.store.getState().toggleMute("Sender"));
  receiver.store.getState().addChatMessage("Sender", "@Receiver muted");
  await turn();
  await changeAndRearm(agent, () => receiver.store.getState().toggleMute("Sender"));
  expect(wire.updates()).toEqual([]);

  await changeAndRearm(agent, () => receiver.store.getState().addChatMessage("Sender", "@Receiver fresh @Receiver @Other"));
  expect(wire.updates()).toHaveLength(1);
  expect(wire.updates()[0]).toMatchObject({ method: "notifications/resources/updated", params: { uri: receiver.uri, _meta: { [SUBSCRIPTION]: subscription } } });
  expect(Object.keys(wire.updates()[0].params ?? {}).sort()).toEqual(["_meta", "uri"]);
  const resource = await read(wire, receiver.uri);
  expect(resource).toMatchObject({ session: receiver.session, ephemeral: true, liveOnly: true });
  expect(resource.messages.at(-1)).toMatchObject({ from: "Sender", text: "@Receiver fresh @Receiver @Other", mentions: ["Receiver", "Other"] });
  expect(resource.latestMessageId).toBe(resource.messages.at(-1)!.id);
  expect(resource.messages.every(message => !message.text.includes("muted") && !message.text.includes("replay"))).toBe(true);
  await changeAndRearm(agent, () => other.store.getState().addChatMessage("Sender", "@Other isolated"));
  expect((await read(wire, other.uri)).messages.at(-1)!.text).toBe("@Other isolated");
  expect((await read(wire, receiver.uri)).messages.some(message => message.text.includes("isolated"))).toBe(false);
  expect(wire.updates()).toHaveLength(1);
});

test("mention URIs are exact and handles must belong to this owner, including listen filters", async () => {
  const first = fixture();
  const second = fixture();
  const receiver = await first.create();
  const missing = crypto.randomUUID();
  for (const invalid of [
    mentionUri(missing), `${receiver.uri}?x=1`, `${receiver.uri}#x`,
    receiver.uri.replace(receiver.session[0], `%${receiver.session.charCodeAt(0).toString(16)}`),
    "pillowfort://sessions/../mentions", `${receiver.uri}/`,
    `pillowfort://sessions/${receiver.session}%2Fother/mentions`, "pillowfort://sessions/_receiver/mentions",
    `${receiver.uri}\n`, `${receiver.uri}\r\n`,
  ]) {
    expect((await first.request("resources/read", { uri: invalid })).error).toBeDefined();
    expect((await first.request("subscriptions/listen", { notifications: { resourceSubscriptions: [invalid] } })).error).toBeDefined();
  }
  expect((await second.request("resources/read", { uri: receiver.uri })).error).toBeDefined();
  expect((await second.request("subscriptions/listen", { notifications: { resourceSubscriptions: [receiver.uri] } })).error).toBeDefined();
  expect(first.agent.pendingWaits).toBe(1);
  expect(second.agent.pendingWaits).toBe(0);
});

test("mention reads retain bounded real receipts and explicitly private ephemeral cache semantics", async () => {
  const wire = fixture();
  const receiver = await wire.create();
  for (let index = 0; index < 40; index++) receiver.store.getState().addChatMessage("Sender", `@Receiver ${index} ${"x".repeat(1800)}`);
  const resource = await read(wire, receiver.uri);
  expect(resource.messages.length).toBeGreaterThan(0);
  expect(resource.messages.length).toBeLessThanOrEqual(16);
  expect(new TextEncoder().encode(JSON.stringify(resource.messages)).byteLength).toBeLessThanOrEqual(16 * 1024);
  expect(resource.retainedCount).toBe(40);
  expect(resource.latestMessageId).toBe(resource.messages.at(-1)!.id);
  expect(resource).toMatchObject({ liveOnly: true, ephemeral: true });
});

test("repeated listen cancellation cannot exhaust capacity or interfere with a real tool wait", async () => {
  const wire = fixture();
  const receiver = await wire.create();
  const revision = (await wire.agent.observe(receiver.session)).revision;
  const count = wire.agent.waitCount;
  const toolWait = wire.tool("session_wait", { session: receiver.session, afterRevision: revision, timeoutMs: 30_000 });
  await wire.agent.afterWait(count);
  for (let index = 0; index < 80; index++) {
    const id = await wire.listen([receiver.uri]);
    wire.cancel(id);
    await wire.result("tools/list");
    expect(wire.agent.pendingWaits).toBe(2);
  }
  receiver.store.getState().addChatMessage("Sender", "@Receiver tool waiter and owner watcher remain");
  expect((await toolWait).isError).toBe(false);
  await turn();
  expect(wire.agent.pendingWaits).toBe(1);
  expect(wire.updates()).toEqual([]);
  expect(wire.agent.listSessions()).toEqual([{ name: receiver.session, state: "ready" }]);
});

test("a participant closed during its watcher baseline cannot bind a replacement identity", async () => {
  const wire = fixture();
  const gate = wire.agent.pauseNextObservation();
  cleanups.unshift(async () => { gate.release.resolve(); });
  const creating = wire.tool("session_create");
  await gate.entered.promise;
  const original = wire.agent.listSessions()[0].name;
  await wire.agent.closeSession(original);
  const replacement = await wire.create();
  expect(replacement.session).not.toBe(original);
  const id = await wire.listen([replacement.uri]);
  gate.release.resolve();
  expect((await creating).isError).toBe(true);
  expect((await wire.request("resources/read", { uri: mentionUri(original) })).error).toBeDefined();
  await changeAndRearm(wire.agent, () => replacement.store.getState().addChatMessage("Sender", "@Receiver after replacement baseline"));
  expect(wire.updates()).toHaveLength(1);
  expect(wire.updates()[0].params?._meta?.[SUBSCRIPTION]).toBe(id);
});

test("close and recreation cannot leak a completed old wait or attach an old handle to the new participant", async () => {
  const wire = fixture();
  const receiver = await wire.create();
  const signal = wire.agent.sessionSignal(receiver.session);
  await wire.listen([receiver.uri]);
  const gate = wire.agent.pauseNextResult();
  cleanups.unshift(async () => { gate.release.resolve(); });
  receiver.store.getState().addChatMessage("Sender", "@Receiver old pending delivery");
  await gate.entered.promise;
  expect((await wire.tool("session_close", { session: receiver.session, confirm: true })).isError).toBe(false);
  expect(signal.aborted).toBe(true);
  const replacement = await wire.create();
  await changeAndRearm(wire.agent, () => replacement.store.getState().addChatMessage("Sender", "@Receiver replacement baseline"));
  gate.release.resolve();
  await turn();
  expect(wire.updates()).toEqual([]);
  expect((await wire.request("subscriptions/listen", { notifications: { resourceSubscriptions: [receiver.uri] } })).error).toBeDefined();
  const id = await wire.listen([replacement.uri]);
  await changeAndRearm(wire.agent, () => replacement.store.getState().addChatMessage("Sender", "@Receiver replacement live"));
  expect(wire.updates()).toHaveLength(1);
  expect(wire.updates()[0]).toMatchObject({ params: { uri: replacement.uri, _meta: { [SUBSCRIPTION]: id } } });
});

test("overlapping listen cancellation and resubscribe cannot remove the new stream or cancel its owner watcher", async () => {
  const wire = fixture();
  const receiver = await wire.create();
  const oldId = await wire.listen([receiver.uri]);
  const signal = wire.agent.lastWaitSignal!;
  const gate = wire.agent.pauseNextResult();
  cleanups.unshift(async () => { gate.release.resolve(); });
  receiver.store.getState().addChatMessage("Sender", "@Receiver pending old result");
  await gate.entered.promise;
  wire.cancel(oldId);
  const newId = await wire.listen([receiver.uri]);
  expect(signal.aborted).toBe(false);
  gate.release.resolve();
  await turn();
  const before = wire.updates().length;
  await changeAndRearm(wire.agent, () => receiver.store.getState().addChatMessage("Sender", "@Receiver new subscription"));
  expect(wire.updates()).toHaveLength(before + 1);
  expect(wire.updates().every(message => message.params?._meta?.[SUBSCRIPTION] === newId)).toBe(true);
});

test("stdio close terminates all sixteen real participant watchers and destroys their identities", async () => {
  const wire = fixture();
  const participants = [];
  for (let index = 0; index < 16; index++) {
    const participant = await wire.create();
    participants.push(participant);
    await wire.listen([participant.uri]);
  }
  expect(wire.agent.pendingWaits).toBe(16);
  wire.input.end();
  await wire.finished;
  await turn();
  expect(wire.agent.pendingWaits).toBe(0);
  expect(wire.agent.listSessions()).toEqual([]);
  for (const participant of participants) participant.store.getState().addChatMessage("Sender", "@Receiver closed connection");
  await turn();
  expect(wire.updates()).toEqual([]);
});

test("cancelling an ordinary session_wait aborts only that waiter, not the participant watcher or identity", async () => {
  const wire = fixture();
  const participant = await wire.create();
  const revision = (await wire.agent.observe(participant.session)).revision;
  const count = wire.agent.waitCount;
  const id = wire.send("tools/call", { name: "session_wait", arguments: { session: participant.session, afterRevision: revision, timeoutMs: 30_000 } });
  await wire.agent.afterWait(count);
  wire.cancel(id);
  await wire.result("tools/list");
  await turn();
  expect(wire.agent.pendingWaits).toBe(1);
  expect(wire.agent.sessionSignal(participant.session).aborted).toBe(false);
  const subscription = await wire.listen([participant.uri]);
  await changeAndRearm(wire.agent, () => participant.store.getState().addChatMessage("Sender", "@Receiver after cancellation"));
  expect(wire.updates()[0].params?._meta?.[SUBSCRIPTION]).toBe(subscription);
});
