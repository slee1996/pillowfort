// Local workerd fixture only. wrangler.toml never imports this module.
export { default } from "../src/index.ts";
import { Room as ProductionRoom } from "../src/room.ts";

export class Room extends ProductionRoom {
  instance = crypto.randomUUID();
  report(event) {
    this.state.waitUntil((async () => {
      if (this.env.CUT === "probe-restart") event.idle = (await this.state.storage.get("alarmSchedule"))?.idle;
      await this.env.EVIDENCE.fetch("https://evidence.invalid/", {
        method: "POST", body: JSON.stringify({ ...event, instance: this.instance, room: this.roomId }),
      });
    })());
  }
  sendSecure(ws, frame) {
    if (this.env.CUT === "probe-restart" && frame.type === "host-path-probe" && this.hostPath?.phase === "retry" && !this.cutProbe) {
      this.cutProbe = true;
      // Lose the original emission; a restored retry must not be lost again.
      if (!this.restoredProbe) { this.report({ kind: "cut", offer: this.hostPath }); return; }
    }
    super.sendSecure(ws, frame);
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
  async commitSecureDisconnect(actor, ws) {
    const host = this.secureRelayState?.members.find(m => m.deviceId === this.secureRelayState.hostDeviceId);
    const tracked = host?.deviceId === actor.deviceId && host.connectionId === actor.connectionId;
    const at = Date.now();
    const committed = await super.commitSecureDisconnect(actor, ws);
    if (committed && tracked && !this.secureRelayState?.members.some(m => m.deviceId === actor.deviceId && m.connectionId === actor.connectionId)) {
      this.report({ kind: "detected", at });
    }
    return committed;
  }
  async alarm() {
    if (this.env.CUT === "probe-restart" && this.hostPath?.phase === "retry") {
      this.restoredProbe = true;
      this.report({ kind: "awoke", at: Date.now(), nonce: this.hostPath.nonce });
    } else if (this.secureRelayState?.pendingHostTransfer) this.report({ kind: "awoke", at: Date.now() });
    return super.alarm();
  }
}
