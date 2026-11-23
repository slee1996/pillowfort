// A test observer, not another relay. It compares consecutive snapshots and effects of
// the shipped reducer, including exact retries and idle/transport steps. Counts contain no IDs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as relay from "../src/secureRelayV4";
import type { SecureBacklogEntryV4 as Entry, SecureClientFrameV4 as Frame, SecureRelayStateV4 as State,
  SecureRelayActorV4 as Actor, SecureRelayTransitionV4 as Result } from "../src/secureRelayV4";

type Step = Exclude<Frame["kind"], "relay"> | Extract<Frame, {kind:"relay"}>["relayKind"] | "disconnect" | "alarm";
const required = {setup:1, join:1, resume:1, activate:1, "order-request":1, "authorize-host-transfer":1,
  "retire-member":1, "cancel-admission":1, "close-room":1, "application-decision":1, "commit-decision":1,
  "resume-complete":1, "delivery-ack":1, commit:1, welcome:1, bootstrap:1, "join-proof":1,
  application:1, "host-transfer-accept":1, disconnect:1, alarm:1} satisfies Record<Step, 1>;
const counts = {accepted: {} as Record<string, number>, rejected: {} as Record<string, number>, checked: {} as Record<string, number>};
const count = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
const hit = (name: string) => count(counts.checked, name);
const entryId = (entry: Entry) => entry.kind === "relay" ? entry.frame.envelope.messageId : entry.kind === "host-transfer-authorization" ? entry.authorizationId : entry.messageId;
const stable = new Set<relay.SecureReplayKindV4>(["application", "application-rejected", "commit", "commit-rejected", "join-proof"]);
const markerId = (m: { deviceId: string; admissionCommitMessageId: string }) => `${m.deviceId}/${m.admissionCommitMessageId}`;

function observe(result: Result, before: State | null, serializedBefore: string | null, actor: Actor | null,
  input: Frame | "alarm" | "disconnect", time: number) {
  if (before) { assert.equal(JSON.stringify(before), serializedBefore, "relay mutated its input snapshot"); hit("input-unchanged"); }
  if (!result.ok) { count(counts.rejected, result.code); return result; }
  const f = typeof input === "string" ? null : input;
  const step = f ? f.kind === "relay" ? f.relayKind : f.kind : input as Step;
  count(counts.accepted, step);
  const {state:s, effects} = result;
  assert.equal(s.revision, before ? before.revision + 1 : 1);
  assert.equal(s.clockHighWater, time);
  // A transition which cannot be reloaded identically cannot be committed by the adapter.
  assert.deepEqual(relay.importSecureRelayStateV4(relay.exportSecureRelayStateV4(s)), JSON.parse(JSON.stringify(s)));
  hit("persistable-poststate");
  if (!before) {
    assert(f?.kind === "setup" && actor?.authentication === "invitation");
    assert.equal(s.hostDeviceId, actor.deviceId); assert.equal(s.members.length, 1); assert.equal(s.members[0].status, "active");
    return result;
  }
  assert.equal(s.roomInstance, before.roomInstance); assert(s.nextLogicalOrder >= before.nextLogicalOrder);
  assert(s.clockHighWater >= before.clockHighWater); assert(s.nextMemberOrder >= before.nextMemberOrder);
  assert.deepEqual(s.recentKeyPackageDigests.slice(0,before.recentKeyPackageDigests.length), before.recentKeyPackageDigests);
  const old = new Map(before.members.map(m => [m.deviceId,m]));
  const records = new Map(s.recentMessages.map(r => [r.id,r]));
  if (f?.kind === "relay" && f.relayKind !== "welcome" && f.relayKind !== "join-proof" &&
      !before.recentMessages.some(r => r.id === f.envelope.messageId)) {
    const record = records.get(f.envelope.messageId);
    if (record && ["application","application-pending","bootstrap","commit","commit-pending"].includes(record.kind)) {
      const g = before.currentGrant; assert(g && actor && g.deviceId === actor.deviceId && g.connectionId === actor.connectionId);
      const {connectionId: _, ...wireGrant} = g; assert.deepEqual(f.grant, wireGrant);
      assert(time < g.expiresAt && g.logicalOrder === before.nextLogicalOrder); hit("exact-consumed-live-grant");
    }
  }
  for (const r of before.recentMessages) if (stable.has(r.kind) && records.has(r.id)) {
    assert.deepEqual(records.get(r.id), r, "a retained terminal outcome changed"); hit(`stable-${r.kind}`);
  }
  for (const m of s.members) {
    const b = old.get(m.deviceId);
    if (!b) { assert(f?.kind === "join" && m.deviceId === actor?.deviceId && m.status === "pending"); continue; }
    assert.equal(m.joinedOrder,b.joinedOrder); assert.deepEqual(m.memberBinding,b.memberBinding);
    if (b.status === "retired") assert.equal(m.status,"retired");
    if (m.status === "active" && b.status !== "active") {
      if (b.admissionId !== null) {
        assert(f?.kind === "activate" && actor?.deviceId === before.hostDeviceId && f.deviceId === m.deviceId);
        assert.equal(f.signaturePublicKey,b.signaturePublicKey); assert.equal(f.admissionId,b.admissionId);
        assert.equal(f.proofMessageId,b.proofFrame?.envelope.messageId); assert(b.welcomeMessageId && b.admissionCommitMessageId);
        assert.equal(m.membershipCommitMessageId,b.admissionCommitMessageId); hit("activated-exact-admission");
      } else {
        assert(f?.kind === "resume-complete" && b.resumePhase === "replaying-backlog" && b.resumeRequestId);
        assert.equal(b.connectionId,actor?.connectionId); assert.equal(b.deviceId, actor?.deviceId);
        assert.equal(f.lastMessageId,b.backlog.length ? entryId(b.backlog.at(-1)!) : b.resumeRequestId);
        hit("activated-exact-replay");
      }
    }
  }
  if (s.lifecycle === "retired") {
    assert.equal(s.hostDeviceId,null); assert(!s.pendingHostTransfer && !s.hostSuccession && !s.currentGrant);
    assert(s.members.every(m => m.status === "retired")); hit("retired-without-authority");
  } else {
    if (s.hostDeviceId !== before.hostDeviceId) {
      const offer = before.pendingHostTransfer; assert(offer && offer.hostDeviceId === before.hostDeviceId && offer.targetDeviceId === s.hostDeviceId && time < offer.expiresAt);
      if (offer.policyEventId) {
        assert(f?.kind === "relay" && f.relayKind === "host-transfer-accept" && actor?.deviceId === s.hostDeviceId);
        assert.equal(f.authorizationId,offer.authorizationId);
        const a = f.authorityEvent; assert(a && a.deviceId === s.hostDeviceId && a.content.type === "host-succession" && a.content.action === "accept");
        assert.equal(a.content.policyEventId,offer.policyEventId); assert.equal(a.content.authorizationId, offer.authorizationId);
        assert(s.pendingZombieRemovals.some(m => m.deviceId === before.hostDeviceId && m.admissionCommitMessageId === old.get(m.deviceId)?.memberBinding.admissionId));
        hit("consenting-policy-transfer");
      } else {
        const p = before.pendingApplication;
        assert(f?.kind === "application-decision" && f.decision === "approve" && actor?.deviceId === before.hostDeviceId);
        assert(p?.frame.relayKind === "host-transfer-accept" && p.fromDeviceId === s.hostDeviceId && p.frame.authorizationId === offer.authorizationId);
        assert.equal(f.messageId,p.frame.envelope.messageId); hit("consenting-manual-transfer");
      }
      assert(!s.hostSuccession && !s.pendingHostTransfer); assert(effects.some(e => e.type === "host-changed" && e.deviceId === s.hostDeviceId));
    }
    const bq = before.pendingZombieRemovals, aq = s.pendingZombieRemovals;
    const removed = bq.length && (!aq.length || markerId(bq[0]) !== markerId(aq[0])) ? 1 : 0;
    if (removed) {
      assert(f?.kind === "retire-member" && f.deviceId === bq[0].deviceId && f.commitMessageId === bq[0].removalCommitMessageId && actor?.deviceId === before.hostDeviceId);
      hit("removed-exact-head");
    }
    for (let i = removed; i < bq.length; i++) {
      const m = aq[i-removed]; assert(m && markerId(m) === markerId(bq[i]) && m.requestedAt === bq[i].requestedAt);
      if (bq[i].removalCommitMessageId !== null) assert.equal(m.removalCommitMessageId,bq[i].removalCommitMessageId);
    }
  }
  const owner = actor && old.get(actor.deviceId), current = actor && s.members.find(m => m.deviceId === actor.deviceId);
  if (f?.kind === "delivery-ack" && owner && current && records.get(f.requestId)?.kind === "delivery-ack" && !before.recentMessages.some(r=>r.id===f.requestId)) {
    const at = owner.backlog.findIndex(e=>entryId(e) === f.lastMessageId); assert(at >= 0 && owner.connectionId === actor?.connectionId);
    const suffix = owner.backlog.slice(at+1); assert.deepEqual(current.backlog.slice(0,suffix.length),suffix);
    assert(!current.backlog.some(e=>entryId(e) === f.lastMessageId)); hit("ack-exact-prefix");
  }
  if (f?.kind === "resume" && current?.resumeRequestId === f.requestId) {
    const messages: string[] = []; let lastMarker = "", end = "", snapshot = false;
    for (const e of effects) {
      if (e.type === "zombie-removal-required" && e.toDeviceIds.includes(current.deviceId)) lastMarker = markerId(e);
      if (e.type === "replay-backlog" && e.toDeviceId === current.deviceId) {
        assert(!snapshot && !end);
        for (const entry of e.entries) {
          if (entry.kind === "relay" && entry.frame.relayKind === "commit" && entry.frame.retirementDeviceId) {
            assert.equal(lastMarker,`${entry.frame.retirementDeviceId}/${entry.frame.retirementAdmissionCommitMessageId}`); hit("historical-marker-before-remove");
          }
          messages.push(entryId(entry));
        }
      }
      if (e.type === "room-state-snapshot" && e.toDeviceId === current.deviceId) { assert(!snapshot && !end); assert.equal(e.hostDeviceId,s.hostDeviceId); snapshot = true; }
      if (e.type === "backlog-end" && e.toDeviceId === current.deviceId) { assert(snapshot && !end); end = e.lastMessageId; }
    }
    assert.deepEqual(messages,current.backlog.map(entryId)); assert.equal(end,messages.at(-1) ?? f.requestId); hit("complete-ordered-replay");
  }
  return result;
}

export async function createSecureRelayStateV4(...args: Parameters<typeof relay.createSecureRelayStateV4>) {
  const [actor,frame,time] = args;
  return observe(await relay.createSecureRelayStateV4(...args),null,null,actor,frame as Frame,time);
}
export async function reduceSecureRelayV4(...args: Parameters<typeof relay.reduceSecureRelayV4>) {
  const [s,actor,frame,o] = args, prior = JSON.stringify(s);
  return observe(await relay.reduceSecureRelayV4(...args),s,prior,actor,frame as Frame,o.now);
}
export function disconnectSecureRelayDeviceV4(...args: Parameters<typeof relay.disconnectSecureRelayDeviceV4>) {
  const [s,actor,o] = args, prior = JSON.stringify(s);
  return observe(relay.disconnectSecureRelayDeviceV4(...args),s,prior,actor,"disconnect",o.now);
}
export function advanceSecureRelayV4(...args: Parameters<typeof relay.advanceSecureRelayV4>) {
  const [s,o] = args, prior = JSON.stringify(s);
  return observe(relay.advanceSecureRelayV4(...args),s,prior,null,"alarm",o.now);
}
export function reportRelayConformance() {
  const path = process.env.PILLOWFORT_RELAY_CONFORMANCE_REPORT;
  if (!path) return; // Partial named-test runs do not claim coverage of the entire corpus.
  assert.deepEqual(Object.keys(counts.accepted).sort(),Object.keys(required).sort());
  for (const property of ["activated-exact-admission","activated-exact-replay","consenting-policy-transfer","consenting-manual-transfer",
    "exact-consumed-live-grant","removed-exact-head","ack-exact-prefix","complete-ordered-replay","historical-marker-before-remove",...Array.from(stable,k=>`stable-${k}`)]) assert(counts.checked[property] > 0,property);
  writeFileSync(path,JSON.stringify(counts,null,2)+"\n");
}
