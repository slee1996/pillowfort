import { describe, expect, test } from "bun:test";
import { ParticipantEventQueue } from "../src/participant/eventQueue";

describe("participant-scoped attention stream", () => {
  test("filters and paginates without skipping selected events", () => {
    const queue = new ParticipantEventQueue();
    const cursor = queue.cursor();
    queue.push("lifecycle", { state: "connected" });
    queue.push("mention", { messageId: 1 });
    queue.push("mention", { messageId: 2 });
    const first = queue.read(cursor, ["mention"], 1);
    expect(first.events.map(event => event.data)).toEqual([{ messageId: 1 }]);
    expect(queue.read(first.cursor, ["mention"], 1).events.map(event => event.data)).toEqual([{ messageId: 2 }]);
    expect(first.missed).toBe(false);
  });

  test("detects overflow and rejects foreign, malformed and future cursors", () => {
    const queue = new ParticipantEventQueue(2);
    const cursor = queue.cursor();
    for (let id = 1; id <= 3; id++) queue.push("mention", { messageId: id });
    const batch = queue.read(cursor, ["mention"]);
    expect(batch.missed).toBe(true);
    expect(batch.events.map(event => event.data)).toEqual([{ messageId: 2 }, { messageId: 3 }]);
    expect(() => new ParticipantEventQueue().read(cursor, ["mention"])).toThrow();
    expect(() => queue.read(cursor.replace(/:0$/, ":01"), ["mention"])).toThrow();
    expect(() => queue.read(cursor.replace(/:0$/, ":99"), ["mention"])).toThrow();
  });

  test("owns event data across insertion and reads", () => {
    const queue = new ParticipantEventQueue();
    const data = { text: "original" };
    queue.push("mention", data);
    data.text = "changed";
    const batch = queue.read(undefined, ["mention"]);
    const returned = batch.events[0].data;
    if (returned && typeof returned === "object" && !Array.isArray(returned)) returned.text = "changed again";
    expect(queue.read(undefined, ["mention"]).events[0].data).toEqual({ text: "original" });
  });

  test("waits through unrelated events and wakes on a selected event", async () => {
    const queue = new ParticipantEventQueue();
    const waiting = queue.wait(queue.cursor(), ["mention"], 16, 1000);
    queue.push("admission", { id: "pending" });
    queue.push("mention", { messageId: 1 });
    expect((await waiting).events.map(event => event.type)).toEqual(["mention"]);
  });

  test("cancels waits and reports closure to existing waiters", async () => {
    const queue = new ParticipantEventQueue();
    const abort = new AbortController();
    const cancelled = queue.wait(queue.cursor(), ["mention"], 16, 1000, abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    const closed = queue.wait(queue.cursor(), ["mention"], 16, 1000);
    queue.close();
    expect((await closed).closed).toBe(true);
  });

  test("returns a bounded timeout rather than requiring another model turn for every state change", async () => {
    const queue = new ParticipantEventQueue();
    const batch = await queue.wait(queue.cursor(), ["mention"], 16, 1);
    expect(batch).toMatchObject({ events: [], missed: false, closed: false, liveOnly: true });
  });
});
