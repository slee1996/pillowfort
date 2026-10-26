import { useStore, type UseBoundStore } from "zustand";
import { createParticipantStore, type GameStore, type ParticipantStore } from "../../../src/participant/gameStore";

const STORED_NAME_KEY = "pillowfort-name";

function readStoredName(): string {
  try {
    return globalThis.localStorage?.getItem(STORED_NAME_KEY) || "";
  } catch {
    // A display-name preference must not prevent application startup.
    return "";
  }
}

function writeStoredName(name: string): void {
  try {
    globalThis.localStorage?.setItem(STORED_NAME_KEY, name);
  } catch {
    // Keep the in-memory name when persistence is unavailable.
  }
}

export const participantStore = createParticipantStore({ readName: readStoredName, writeName: writeStoredName });
export const useGameStore: UseBoundStore<ParticipantStore> = Object.assign(
  ((selector?: (state: GameStore) => unknown) =>
    useStore(participantStore, selector ?? ((state) => state))) as UseBoundStore<ParticipantStore>,
  participantStore,
);
