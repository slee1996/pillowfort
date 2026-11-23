// Local workerd fixture only. wrangler.toml never imports this module.
export { default } from "../src/index.ts";
import { Room as ProductionRoom } from "../src/room.ts";

export class Room extends ProductionRoom {
  instance = crypto.randomUUID();
  report(event) {
    this.state.waitUntil(this.env.EVIDENCE.fetch("https://evidence.invalid/", {
      method: "POST", body: JSON.stringify({ ...event, instance: this.instance, room: this.roomId }),
    }));
  }
  dispatchSecureEffects(effects) {
    const offer = effects.find(e => e.type === "host-transfer-authorized");
    if (this.env.CUT === "persisted-offer" && offer && effects.some(e =>
      e.type === "fresh-admission-required" && e.deviceId === offer.fromHostDeviceId)) {
      // The base method is reached only *after* the relay transaction commits.
      // Lose the entire first emission, not just a network frame after send().
      this.report({ kind: "cut", offer: this.secureRelayState.pendingHostTransfer });
      return;
    }
    super.dispatchSecureEffects(effects);
  }
  async webSocketClose(ws, ...args) {
    const a = ws.deserializeAttachment();
    const h = this.secureRelayState?.members.find(m => m.deviceId === this.secureRelayState.hostDeviceId);
    if (h && a?.secureDeviceId === h.deviceId && a.secureConnectionId === h.connectionId) {
      this.report({ kind: "detected", at: Date.now() });
    }
    return super.webSocketClose(ws, ...args);
  }
  async alarm() {
    if (this.secureRelayState?.pendingHostTransfer) this.report({ kind: "awoke", at: Date.now() });
    return super.alarm();
  }
}
