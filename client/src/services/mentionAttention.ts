import type { GameStore } from "../../../src/participant/gameStore";
import type { ChatMessage } from "../../../src/participant/protocol";

type MentionState = Pick<GameStore, "roomId" | "name" | "messages" | "mutedNames">;

/** A receiver-local live cursor: mounting or changing rooms never replays history. */
export function createMentionObserver(initial: MentionState): (state: MentionState) => ChatMessage[] {
  let roomId = initial.roomId;
  let name = initial.name;
  let latestId = initial.messages.reduce((latest, message) => Math.max(latest, message.id), 0);
  return (state) => {
    const latest = state.messages.reduce((id, message) => Math.max(id, message.id), 0);
    if (state.roomId !== roomId || state.name !== name) {
      roomId = state.roomId;
      name = state.name;
      latestId = latest;
      return [];
    }
    const ownName = name.normalize("NFC");
    const received = state.roomId ? state.messages.filter((message) =>
      message.id > latestId && message.kind === "chat" && !message.replayed
      && message.from?.normalize("NFC") !== ownName
      && !state.mutedNames.has(message.from ?? "")
      && message.mentions?.includes(ownName),
    ) : [];
    latestId = Math.max(latestId, latest);
    return received;
  };
}
