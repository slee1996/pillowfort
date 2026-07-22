import { describe, expect, it } from "bun:test";
import { track } from "../client/src/services/analytics";

describe("client analytics privacy boundary", () => {
  it("never submits protected room, member, invitation, message, or game metadata", () => {
    const submitted: string[] = [];
    const prior = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: (_url: string, body: Blob) => {
        submitted.push(String(body.size));
        return true;
      },
    });
    try {
      track("room_created", { role: "host", memberCount: 1 });
      track("room_joined", { role: "guest", memberCount: 2 });
      track("guest_joined", { memberCount: 2 });
      track("invite_copied", { source: "room_code" });
      track("first_message_sent", { role: "host" });
      track("game_started", { kind: "saboteur" });
      track("room_knocked_down", { role: "host" });
      track("activation_nudge_shown", { source: "empty_room" });
      track("activation_nudge_clicked", { source: "empty_room" });
      expect(submitted).toHaveLength(0);

      track("fort_pass_status_checked", { source: "setup" });
      expect(submitted).toHaveLength(1);
    } finally {
      if (prior) Object.defineProperty(navigator, "sendBeacon", prior);
      else delete (navigator as Navigator & { sendBeacon?: unknown }).sendBeacon;
    }
  });
});
