import { useStore, type UseBoundStore } from "zustand";
import { createParticipantFormatStore, type FormatStore, type ParticipantFormatStore } from "../../../src/participant/formatStore";

export const participantFormatStore = createParticipantFormatStore();
export const useFormatStore: UseBoundStore<ParticipantFormatStore> = Object.assign(
  ((selector?: (state: FormatStore) => unknown) =>
    useStore(participantFormatStore, selector ?? ((state) => state))) as UseBoundStore<ParticipantFormatStore>,
  participantFormatStore,
);
