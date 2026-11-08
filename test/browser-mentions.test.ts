import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../src/participant/protocol";
import { formatMention, findMentions } from "../src/participant/mentions";
import { mentionQuery } from "../client/src/services/mentionComposer";
import { createMentionObserver } from "../client/src/services/mentionAttention";

const members = ["bob", "Bob Smith", 'a@b "quoted"', "café"];

function chat(id: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, kind: "chat", from: "alice", text: "@bob", timestamp: "12:00", mentions: ["bob"], ...overrides };
}

describe("mention composer completion", () => {
  it("offers roster matches at the caret and inserts parser-recognized names", () => {
    expect(mentionQuery("Hi @bo", 6, 6, members)).toEqual({ start: 3, end: 6, names: ["bob", "Bob Smith"] });
    expect(mentionQuery('@"Bob S', 7, 7, members)?.names).toEqual(["Bob Smith"]);
    expect(mentionQuery('@"a@b \\"q', 9, 9, members)?.names).toEqual(['a@b "quoted"']);
    expect(mentionQuery("@cafe\u0301", 6, 6, members)?.names).toEqual(["café"]);
    for (const name of members) {
      const inserted = `${formatMention(name)} `;
      expect(findMentions(inserted, members).map((mention) => mention.name)).toEqual([name]);
    }
  });

  it("does not complete emails, embedded words, closed tokens, selections or middle-of-token carets", () => {
    for (const text of ["mail@bo", "mail+@bo", "mail.@bo", "𐐀@bo", "@@bo", '@"Bob Smith"', "@bob\n"]) {
      expect(mentionQuery(text, text.length, text.length, members)).toBeNull();
    }
    expect(mentionQuery("@bob", 3, 3, members)).toBeNull();
    expect(mentionQuery("@bo", 0, 3, members)).toBeNull();
    expect(mentionQuery("@nobody", 7, 7, members)).toBeNull();
  });
});

describe("live browser mention cursor", () => {
  it("ignores initial history, repeated store updates, replay, own, muted and non-chat rows", () => {
    const state = { roomId: "fort-a", name: "bob", messages: [chat(1)], mutedNames: new Set<string>() };
    const observe = createMentionObserver(state);
    expect(observe(state)).toEqual([]);
    state.messages.push(chat(2));
    expect(observe(state).map((message) => message.id)).toEqual([2]);
    expect(observe(state)).toEqual([]);
    state.mutedNames.add("muted");
    state.messages.push(
      chat(3, { replayed: true }),
      chat(4, { from: "bob" }),
      chat(5, { from: "muted" }),
      chat(6, { kind: "system" }),
      chat(7, { mentions: ["bobby"] }),
    );
    expect(observe(state)).toEqual([]);
    state.mutedNames.clear();
    expect(observe(state)).toEqual([]);
    state.messages.push(chat(8));
    expect(observe(state).map((message) => message.id)).toEqual([8]);
  });

  it("keeps its cursor through clearing and resets its baseline across room/name changes", () => {
    const state = { roomId: "fort-a", name: "bob", messages: [chat(10)], mutedNames: new Set<string>() };
    const observe = createMentionObserver(state);
    state.messages = [];
    expect(observe(state)).toEqual([]);
    state.messages = [chat(10), chat(11)];
    expect(observe(state).map((message) => message.id)).toEqual([11]);
    state.roomId = "fort-b";
    state.messages = [chat(20)];
    expect(observe(state)).toEqual([]);
    state.messages.push(chat(21));
    expect(observe(state).map((message) => message.id)).toEqual([21]);
    state.name = "cafe\u0301";
    state.messages.push(chat(22, { mentions: ["café"] }));
    expect(observe(state)).toEqual([]);
    state.messages.push(chat(23, { mentions: ["café"] }));
    expect(observe(state).map((message) => message.id)).toEqual([23]);
  });
});
