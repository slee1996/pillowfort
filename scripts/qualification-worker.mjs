// Local workerd fixture only. wrangler.toml never imports this module.
export { default } from "../src/index.ts";
import { Room as ProductionRoom } from "../src/room.ts";
import { SECURE_RELAY_MANIFEST_KEY_V4 } from "../src/secureRelayPersistenceV4.ts";

export class Room extends ProductionRoom {
  instance = crypto.randomUUID();
  report(event) {
    this.state.waitUntil((async () => {
      if (event.kind === "cut" && this.idleCut) event.deletionCommitted =
        await this.state.storage.get(SECURE_RELAY_MANIFEST_KEY_V4) === undefined && await this.state.storage.get("roomId") === undefined;
      if (this.env.CUT === "probe-restart") event.idle = (await this.state.storage.get("alarmSchedule"))?.idle;
      await this.env.EVIDENCE.fetch("https://evidence.invalid/", {
        method: "POST", body: JSON.stringify({ ...event, instance: this.instance, room: this.roomId }),
      });
    })());
  }
  // Paired counterfactual only: keep the same host, nonce and socket, but give a late reply
  // another 30 s after the retry. Never used in the deployed Worker or the treatment runs.
  get sleepStudy() { return this.env.CUT === "physical-sleep" || this.env.CUT === "sleep-awake-control"; }
  power(event, details = {}) { this.report({kind:"power-observation", event, at:Date.now(), ...details}); }
  originalSocket(ws) { return this.studySubject && this.att(ws).secureConnectionId === this.studySubject.connection; }
  async webSocketClose(ws, ...rest) {
    if (this.originalSocket(ws)) this.power("original-socket-close-observed");
    return super.webSocketClose(ws, ...rest);
  }
  async webSocketError(ws, ...rest) {
    if (this.originalSocket(ws)) this.power("original-socket-error-observed");
    return super.webSocketError(ws, ...rest);
  }
  async persistHostPath(next) {
    const prior = this.hostPath;
    if ((this.env.CUT === "premature-succession" || this.sleepStudy) && this.env.STUDY_EXTRA_MS === "30000" &&
        prior?.phase === "retry" && next?.phase === "expire") next = { ...next, dueAt: next.dueAt + 30_000 };
    await super.persistHostPath(next);
    if (this.studySubject && prior?.nonce && next?.phase === "quiet" && next.connectionId === this.studySubject.connection) {
      this.power("original-probe-reply-committed");
    }
  }
  get idleCut() { return this.env.CUT === "idle-retirement" || this.env.CUT === "idle-retirement-prefix"; }
  async webSocketMessage(ws, message) {
    await super.webSocketMessage(ws, message);
    if (!this.idleCut || this.armed || typeof message !== "string" || JSON.parse(message).kind !== "host-path-reply") return;
    await this.withSecureLock(async () => {
      if (this.armed || this.secureRelayState?.members.filter(m => m.status === "active").length !== 2) return;
      this.armed = true;
      // Exercise the real idle alarm, without waiting ten minutes in CI.
      await this.setAlarmDeadline("idle", Date.now());
    });
  }
  sendSecure(ws, frame) {
    if (frame.type === "host-path-probe" && this.originalSocket(ws)) this.power("original-probe-send-attempt");
    if (this.idleCut && frame.type === "room-retired") {
      if (this.armed) {
        const sent = this.sentBeforeCut ?? 0;
        if (sent === (this.env.CUT === "idle-retirement-prefix" ? 1 : 0)) {
          this.report({ kind: "cut", sent });
          throw Error("fixture: interruption after idle deletion");
        }
        this.sentBeforeCut = sent + 1;
      } else this.report({ kind: "terminal-replayed" });
    }
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
    if (this.sleepStudy && !this.studySubject) {
      const s = this.secureRelayState, policy = s.hostSuccession?.event;
      const h = s.members.find(m=>m.deviceId === s.hostDeviceId);
      const guests = s.members.filter(m=>m.deviceId !== s.hostDeviceId && m.status === "active" && m.connectionId);
      if (h?.joinedOrder === 3 && h.connectionId && policy?.deviceId === h.deviceId && policy.content.type === "host-succession-policy" &&
          guests.length === 2 && policy.content.deviceIds.length === 2 && guests.every(m=>policy.content.deviceIds.includes(m.deviceId))) {
        this.studySubject = {connection:h.connectionId}; this.power("policy-ready", {policy:policy.eventId});
      }
    }
    if (this.env.CUT === "offline-two-transfers" && effects.some(e=>e.type === "host-changed")) {
      const s = this.secureRelayState, returning = s.members.find(m=>m.joinedOrder === 4);
      this.report({kind:"switch", holderRank:s.members.find(m=>m.deviceId === s.hostDeviceId)?.joinedOrder,
        observerDisconnected:returning?.status === "disconnected" && returning.connectionId === null});
    }
    if (this.env.CUT === "offline-two-transfers" && !this.reportedTenure) {
      const s = this.secureRelayState, policy = s?.hostSuccession?.event;
      // Report from each instance independently; never hold back a real effect.
      if (policy?.deviceId === s?.hostDeviceId && policy?.content.type === "host-succession-policy" &&
          policy.content.deviceIds.length === 2 && s.members.find(m => m.deviceId === s.hostDeviceId)?.joinedOrder === 2 &&
          !s.pendingZombieRemovals.length && !s.pendingHostTransfer) {
        this.reportedTenure = true;
        this.report({ kind: "cut", checkpoint: { host: s.hostDeviceId, policy: policy.eventId, revision: s.revision } });
      }
    }
  }
  async commitSecureDisconnect(actor, ws) {
    const host = this.secureRelayState?.members.find(m => m.deviceId === this.secureRelayState.hostDeviceId);
    const tracked = host?.deviceId === actor.deviceId && host.connectionId === actor.connectionId;
    const at = Date.now();
    const committed = await super.commitSecureDisconnect(actor, ws);
    if (committed && tracked && !this.secureRelayState?.members.some(m => m.deviceId === actor.deviceId && m.connectionId === actor.connectionId)) {
      if (this.studySubject?.connection === actor.connectionId) this.power("relay-committed-original-disconnect");
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
