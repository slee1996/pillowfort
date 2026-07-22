import {
  MAX_SECURE_GAME_QUEUE,
  MAX_SECURE_MEMBERS,
  MAX_SECURE_SEEN_EVENT_IDS,
  SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES,
  canonicalBase64UrlV4,
  canonicalJsonV4,
  isSecureApplicationEventV4,
  isSecureDisplayNameV4,
  isSecureRoomStateSnapshotV4,
  verifySecureApplicationEventV4,
  type SecureApplicationEventV4,
  type SecureChatStyleV4,
  type SecureRoomStateSnapshotV4,
  type SecureRpsPickV4,
  type SecureSnapshotLeaderboardV4,
} from "./applicationEventsV4";
import { SECURE_DEVICE_ID_BYTES, SECURE_MESSAGE_ID_BYTES, SECURE_ROOM_ID_BYTES, canonicalBase64UrlByteLength } from "./protocolV4";

const UTF8 = new TextEncoder();
const RPS_COMMIT_DOMAIN = "Pillowfort RPS commitment v4\0";
const SABOTEUR_COMMIT_DOMAIN = "Pillowfort Saboteur entropy commitment v4\0";
const SABOTEUR_DRAW_DOMAIN = "Pillowfort Saboteur unbiased draw v4\0";
const TTT_WINS = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;

export interface SecureMemberCredentialV4 {
  deviceId: string;
  signaturePublicKey: string;
  /** Null/omitted until this device binds its own first signed profile event. */
  displayName?: string | null;
}

export type SecureReducerEffectV4 =
  | { type: "profile"; deviceId: string; displayName: string }
  | { type: "presence"; deviceId: string; status: "available" | "away"; awayText: string | null }
  | { type: "chat"; eventId: string; deviceId: string; displayName: string; text: string; style: SecureChatStyleV4 | null }
  | { type: "typing"; deviceId: string; displayName: string }
  | {
      type: "drawing";
      eventId: string;
      deviceId: string;
      displayName: string;
      color: string;
      points: [number, number][];
      strokeStart: boolean;
    }
  | { type: "theme-changed"; theme: SecureRoomStateSnapshotV4["theme"] }
  | { type: "queue-changed" }
  | { type: "member-removed"; deviceId: string }
  | { type: "host-changed"; deviceId: string }
  | { type: "host-offered"; deviceId: string }
  | { type: "host-transfer-required"; deviceId: string }
  | { type: "pillow-tossed"; fromDeviceId: string; targetDeviceId: string }
  | { type: "host-rejected"; deviceId: string }
  | { type: "room-closed"; reason: string }
  | { type: "game-cancelled"; game: "vote" | "rps" | "ttt" | "saboteur"; gameId: string; byDeviceId: string; forfeited: boolean }
  | { type: "vote-started"; gameId: string; starterDeviceId: string; targetDeviceId: string }
  | { type: "vote-result"; gameId: string; targetDeviceId: string; yes: number; no: number; ejected: boolean }
  | { type: "member-removal-request"; deviceId: string; reason: "vote" | "leave" }
  | { type: "rps-challenged"; gameId: string; p1DeviceId: string; p2DeviceId: string }
  | { type: "rps-started"; gameId: string; p1DeviceId: string; p2DeviceId: string; koth: boolean }
  | { type: "rps-declined"; gameId: string; byDeviceId: string }
  | { type: "rps-result"; gameId: string; p1DeviceId: string; p2DeviceId: string; pick1: SecureRpsPickV4; pick2: SecureRpsPickV4; winnerDeviceId: string | null; koth: boolean }
  | { type: "ttt-result"; gameId: string; winnerDeviceId: string | null; draw: boolean }
  | { type: "ttt-challenged"; gameId: string; p1DeviceId: string; p2DeviceId: string }
  | { type: "ttt-started"; gameId: string; p1DeviceId: string; p2DeviceId: string }
  | { type: "ttt-declined"; gameId: string; byDeviceId: string }
  | { type: "ttt-updated"; gameId: string; cell: number; mark: "X" | "O"; turn: number }
  | { type: "saboteur-started"; gameId: string; starterDeviceId: string }
  | { type: "saboteur-ready"; gameId: string; saboteurDeviceId: string }
  | { type: "saboteur-accusation"; gameId: string; accuserDeviceId: string; suspectDeviceId: string }
  | { type: "saboteur-vote-result"; gameId: string; suspectDeviceId: string; yes: number; no: number; passed: boolean; wasSaboteur: boolean }
  | { type: "saboteur-strike"; gameId: string; strikes: number; saboteurDeviceId: string | null }
  | { type: "koth-started"; gameId: string; challengerDeviceId: string; hostDeviceId: string }
  | { type: "snapshot-restored"; revision: number };

export type SecureReducerErrorCodeV4 =
  | "invalid-state"
  | "invalid-membership"
  | "invalid-event"
  | "unknown-signer"
  | "invalid-signature"
  | "wrong-room"
  | "duplicate-event"
  | "out-of-order"
  | "bad-device-sequence"
  | "profile-required"
  | "membership-mismatch"
  | "room-closed"
  | "invalid-transition"
  | "state-limit";

export type SecureReducerResultV4 =
  | { ok: true; state: SecureRoomStateSnapshotV4; effects: SecureReducerEffectV4[] }
  | { ok: false; code: SecureReducerErrorCodeV4 };

function validDeviceId(value: unknown): value is string {
  return canonicalBase64UrlByteLength(value) === SECURE_DEVICE_ID_BYTES;
}

function validRoomInstance(value: unknown): value is string {
  return canonicalBase64UrlByteLength(value) === SECURE_ROOM_ID_BYTES;
}

function validDisplayName(value: unknown): value is string {
  return isSecureDisplayNameV4(value);
}

function validMembership(members: readonly SecureMemberCredentialV4[], allowEmpty = false): boolean {
  if (!Array.isArray(members) || Object.getPrototypeOf(members) !== Array.prototype ||
      members.length > MAX_SECURE_MEMBERS || (!allowEmpty && members.length < 1)) return false;
  const deviceIds = new Set<string>();
  const displayNames = new Set<string>();
  for (const member of members) {
    if (!member || typeof member !== "object" || Array.isArray(member) || Object.getPrototypeOf(member) !== Object.prototype) return false;
    const keys = Object.keys(member).sort().join(",");
    if (keys !== "deviceId,signaturePublicKey" && keys !== "deviceId,displayName,signaturePublicKey") return false;
    if (!validDeviceId(member.deviceId) ||
        !(member.displayName === undefined || member.displayName === null || validDisplayName(member.displayName)) ||
        canonicalBase64UrlByteLength(member.signaturePublicKey) !== SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES ||
        deviceIds.has(member.deviceId) || (member.displayName != null && displayNames.has(member.displayName.toLowerCase()))) return false;
    deviceIds.add(member.deviceId);
    if (member.displayName != null) displayNames.add(member.displayName.toLowerCase());
  }
  return true;
}

function cloneState(state: SecureRoomStateSnapshotV4): SecureRoomStateSnapshotV4 {
  return JSON.parse(canonicalJsonV4(state)) as SecureRoomStateSnapshotV4;
}

function currentMember(state: SecureRoomStateSnapshotV4, deviceId: string) {
  return state.members.find((member) => member.deviceId === deviceId);
}

function leaderboard(state: SecureRoomStateSnapshotV4, deviceId: string): SecureSnapshotLeaderboardV4 | undefined {
  return state.leaderboards.find((entry) => entry.deviceId === deviceId);
}

function bump(state: SecureRoomStateSnapshotV4, game: Exclude<keyof SecureSnapshotLeaderboardV4, "deviceId">, deviceId: string) {
  const entry = leaderboard(state, deviceId);
  if (entry) entry[game]++;
}

function activeGame(state: SecureRoomStateSnapshotV4): boolean {
  return activeGameId(state) !== null;
}

function activeGameId(state: SecureRoomStateSnapshotV4): string | null {
  return state.vote?.gameId ?? state.rps?.gameId ?? state.ttt?.gameId ?? state.saboteur?.gameId ?? null;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function consumeQueuedRequest(
  state: SecureRoomStateSnapshotV4,
  game: SecureRoomStateSnapshotV4["queue"][number]["game"],
  byDeviceId: string,
  targetDeviceId: string | null,
  effects: SecureReducerEffectV4[],
) {
  const index = state.queue.findIndex((item) => item.game === game && item.byDeviceId === byDeviceId && item.targetDeviceId === targetDeviceId);
  if (index >= 0) {
    state.queue.splice(index, 1);
    effects.push({ type: "queue-changed" });
  }
}

function markPendingRemoval(
  state: SecureRoomStateSnapshotV4,
  deviceId: string,
  effects: SecureReducerEffectV4[],
): void {
  if (deviceId === state.hostDeviceId || !currentMember(state, deviceId)) {
    throw new TypeError("host or unknown member cannot be marked for removal");
  }
  if (!state.pendingRemovalDeviceIds.includes(deviceId)) {
    state.pendingRemovalDeviceIds.push(deviceId);
    state.pendingRemovalDeviceIds.sort(codeUnitCompare);
  }
  if (state.pendingHostDeviceId !== null) {
    const pendingHostDeviceId = state.pendingHostDeviceId;
    state.pendingHostDeviceId = null;
    effects.push({ type: "host-rejected", deviceId: pendingHostDeviceId });
  }
  const queueLength = state.queue.length;
  state.queue = state.queue.filter((entry) =>
    entry.byDeviceId !== deviceId && entry.targetDeviceId !== deviceId);
  if (state.queue.length !== queueLength) effects.push({ type: "queue-changed" });
}

function drainNextQueuedGame(state: SecureRoomStateSnapshotV4, effects: SecureReducerEffectV4[]) {
  // A host offer is an authority transition, so queued games must not start
  // until it is accepted or rejected. Otherwise a game can straddle two hosts
  // even though offers themselves are forbidden once a game is active.
  if (activeGame(state) || state.pendingHostDeviceId !== null ||
      state.pendingRemovalDeviceIds.length !== 0 || state.closedReason !== null) return;
  let changed = false;
  while (state.queue.length > 0) {
    const item = state.queue.shift()!;
    changed = true;
    const actorExists = !!currentMember(state, item.byDeviceId);
    const targetExists = item.targetDeviceId === null || !!currentMember(state, item.targetDeviceId);
    if (!actorExists || !targetExists) continue;
    if (item.game === "vote" && item.targetDeviceId && item.targetDeviceId !== item.byDeviceId &&
        item.targetDeviceId !== state.hostDeviceId && state.members.length >= 3) {
      state.vote = { gameId: item.requestId, starterDeviceId: item.byDeviceId, targetDeviceId: item.targetDeviceId, votes: [{ deviceId: item.byDeviceId, choice: "yes" }] };
      effects.push({ type: "vote-started", gameId: item.requestId, starterDeviceId: item.byDeviceId, targetDeviceId: item.targetDeviceId });
      break;
    }
    if (item.game === "rps" && item.targetDeviceId && item.targetDeviceId !== item.byDeviceId) {
      state.rps = { gameId: item.requestId, p1DeviceId: item.byDeviceId, p2DeviceId: item.targetDeviceId, phase: "pending", koth: false, commitments: [], reveals: [] };
      effects.push({ type: "rps-challenged", gameId: item.requestId, p1DeviceId: item.byDeviceId, p2DeviceId: item.targetDeviceId });
      break;
    }
    if (item.game === "ttt" && item.targetDeviceId && item.targetDeviceId !== item.byDeviceId) {
      state.ttt = { gameId: item.requestId, p1DeviceId: item.byDeviceId, p2DeviceId: item.targetDeviceId, phase: "pending", board: ["", "", "", "", "", "", "", "", ""], turn: 0 };
      effects.push({ type: "ttt-challenged", gameId: item.requestId, p1DeviceId: item.byDeviceId, p2DeviceId: item.targetDeviceId });
      break;
    }
    if (item.game === "saboteur" && state.members.length >= 4) {
      state.saboteur = {
        gameId: item.requestId,
        starterDeviceId: item.byDeviceId,
        phase: "committing",
        participantDeviceIds: state.members.map((member) => member.deviceId).sort(codeUnitCompare),
        commitments: [],
        reveals: [],
        saboteurDeviceId: null,
        accusation: null,
        strikes: 0,
        canStrike: false,
      };
      effects.push({ type: "saboteur-started", gameId: item.requestId, starterDeviceId: item.byDeviceId });
      break;
    }
    if (item.game === "koth" && state.hostDeviceId && state.pendingHostDeviceId === null &&
        item.byDeviceId !== state.hostDeviceId) {
      state.rps = { gameId: item.requestId, p1DeviceId: item.byDeviceId, p2DeviceId: state.hostDeviceId, phase: "committing", koth: true, commitments: [], reveals: [] };
      effects.push({ type: "koth-started", gameId: item.requestId, challengerDeviceId: item.byDeviceId, hostDeviceId: state.hostDeviceId });
      effects.push({ type: "rps-started", gameId: item.requestId, p1DeviceId: item.byDeviceId, p2DeviceId: state.hostDeviceId, koth: true });
      break;
    }
  }
  if (changed) effects.push({ type: "queue-changed" });
}

function rpsWinner(p1: string, p2: string, pick1: SecureRpsPickV4, pick2: SecureRpsPickV4): string | null {
  if (pick1 === pick2) return null;
  const beats: Record<SecureRpsPickV4, SecureRpsPickV4> = { rock: "scissors", scissors: "paper", paper: "rock" };
  return beats[pick1] === pick2 ? p1 : p2;
}

async function sha256(domain: string, value: unknown): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", UTF8.encode(`${domain}${canonicalJsonV4(value)}`));
  return new Uint8Array(digest);
}

export async function computeRpsCommitmentV4(
  gameId: string,
  deviceId: string,
  pick: SecureRpsPickV4,
  nonce: string,
): Promise<string> {
  if (canonicalBase64UrlByteLength(gameId) !== SECURE_MESSAGE_ID_BYTES || !validDeviceId(deviceId) ||
      (pick !== "rock" && pick !== "paper" && pick !== "scissors") || canonicalBase64UrlByteLength(nonce) !== 32) {
    throw new TypeError("invalid RPS commitment input");
  }
  return canonicalBase64UrlV4(await sha256(RPS_COMMIT_DOMAIN, { deviceId, gameId, nonce, pick }));
}

export async function computeSaboteurCommitmentV4(gameId: string, deviceId: string, nonce: string): Promise<string> {
  if (canonicalBase64UrlByteLength(gameId) !== SECURE_MESSAGE_ID_BYTES || !validDeviceId(deviceId) || canonicalBase64UrlByteLength(nonce) !== 32) {
    throw new TypeError("invalid Saboteur commitment input");
  }
  return canonicalBase64UrlV4(await sha256(SABOTEUR_COMMIT_DOMAIN, { deviceId, gameId, nonce }));
}

/** Deterministically maps jointly revealed entropy without modulo bias. */
export async function selectSaboteurDeviceV4(
  gameId: string,
  reveals: readonly { deviceId: string; nonce: string }[],
): Promise<string> {
  if (reveals.length < 4 || reveals.length > MAX_SECURE_MEMBERS) throw new TypeError("invalid saboteur reveal set");
  const sorted = [...reveals].sort((left, right) => codeUnitCompare(left.deviceId, right.deviceId));
  if (canonicalBase64UrlByteLength(gameId) !== SECURE_MESSAGE_ID_BYTES ||
      sorted.some((entry) => !validDeviceId(entry.deviceId) || canonicalBase64UrlByteLength(entry.nonce) !== 32) ||
      new Set(sorted.map((entry) => entry.deviceId)).size !== sorted.length) throw new TypeError("invalid saboteur reveal");
  const range = 1n << 256n;
  const count = BigInt(sorted.length);
  const limit = range - (range % count);
  for (let counter = 0; counter < 256; counter++) {
    const digest = await sha256(SABOTEUR_DRAW_DOMAIN, { counter, gameId, reveals: sorted });
    let candidate = 0n;
    for (const byte of digest) candidate = (candidate << 8n) | BigInt(byte);
    if (candidate < limit) return sorted[Number(candidate % count)].deviceId;
  }
  throw new Error("unbiased saboteur draw failed");
}

export function createSecureRoomStateV4(
  roomInstance: string,
  members: readonly SecureMemberCredentialV4[],
  hostDeviceId: string,
): SecureRoomStateSnapshotV4 {
  if (!validRoomInstance(roomInstance) || !validMembership(members) || members.some((member) => member.displayName == null) ||
      !members.some((member) => member.deviceId === hostDeviceId)) {
    throw new TypeError("invalid secure room state seed");
  }
  const state: SecureRoomStateSnapshotV4 = {
    v: 4,
    roomInstance,
    logicalOrder: 0,
    revision: 0,
    hostDeviceId,
    pendingHostDeviceId: null,
    pendingRemovalDeviceIds: [],
    membershipAdmissionBindings: members.map((member) => ({
      deviceId: member.deviceId,
      admissionId: null,
    })).sort((left, right) => codeUnitCompare(left.deviceId, right.deviceId)),
    theme: "away-message",
    closedReason: null,
    members: members.map((member) => ({
      deviceId: member.deviceId,
      displayName: member.displayName!,
      status: "available",
      awayText: null,
      lastSequence: 0,
    })),
    messages: [],
    drawings: [],
    queue: [],
    vote: null,
    rps: null,
    ttt: null,
    saboteur: null,
    leaderboards: members.map((member) => ({
      deviceId: member.deviceId,
      pillowFight: 0,
      rps: 0,
      ttt: 0,
      saboteur: 0,
      koth: 0,
    })),
    seenEventIds: [],
  };
  if (!isSecureRoomStateSnapshotV4(state)) throw new TypeError("failed to create secure room state");
  return state;
}

/** Pre-admission state. The first admitted roster should use createSecureRoomStateV4. */
export function createEmptySecureRoomStateV4(roomInstance: string): SecureRoomStateSnapshotV4 {
  if (!validRoomInstance(roomInstance)) throw new TypeError("invalid room instance");
  const state: SecureRoomStateSnapshotV4 = {
    v: 4,
    roomInstance,
    logicalOrder: 0,
    revision: 0,
    hostDeviceId: null,
    pendingHostDeviceId: null,
    pendingRemovalDeviceIds: [],
    membershipAdmissionBindings: [],
    theme: "away-message",
    closedReason: null,
    members: [],
    messages: [],
    drawings: [],
    queue: [],
    vote: null,
    rps: null,
    ttt: null,
    saboteur: null,
    leaderboards: [],
    seenEventIds: [],
  };
  if (!isSecureRoomStateSnapshotV4(state)) throw new TypeError("failed to create empty secure room state");
  return state;
}

/**
 * Applies an already-validated MLS roster change. Call this atomically with the
 * MLS epoch transition; the function never treats a relay claim as membership.
 * A host must transfer authority before its removal unless the room is closed.
 */
export function reconcileSecureRoomMembershipV4(
  current: SecureRoomStateSnapshotV4,
  membership: readonly SecureMemberCredentialV4[],
): SecureReducerResultV4 {
  if (!isSecureRoomStateSnapshotV4(current)) return { ok: false, code: "invalid-state" };
  if (!validMembership(membership, true)) return { ok: false, code: "invalid-membership" };
  const nextCredentials = new Map(membership.map((member) => [member.deviceId, member]));
  if (current.members.some((member) => {
    const next = nextCredentials.get(member.deviceId);
    return next !== undefined && next.displayName != null && next.displayName !== member.displayName;
  })) return { ok: false, code: "membership-mismatch" };

  const removed = new Set([
    ...current.members.filter((member) => !nextCredentials.has(member.deviceId)).map((member) => member.deviceId),
    ...current.membershipAdmissionBindings
      .filter((binding) => !nextCredentials.has(binding.deviceId))
      .map((binding) => binding.deviceId),
  ]);
  if (removed.size === 0) return { ok: true, state: cloneState(current), effects: [] };
  if (current.hostDeviceId !== null && removed.has(current.hostDeviceId) && current.closedReason === null) {
    return { ok: false, code: "invalid-transition" };
  }

  const state = cloneState(current);
  const effects: SecureReducerEffectV4[] = [...removed].sort().map((deviceId) => ({ type: "member-removed" as const, deviceId }));
  state.members = state.members.filter((member) => !removed.has(member.deviceId));
  state.membershipAdmissionBindings = state.membershipAdmissionBindings.filter((binding) => !removed.has(binding.deviceId));
  state.leaderboards = state.leaderboards.filter((entry) => !removed.has(entry.deviceId));
  const pendingRemovalCount = state.pendingRemovalDeviceIds.length;
  state.pendingRemovalDeviceIds = state.pendingRemovalDeviceIds.filter((deviceId) => !removed.has(deviceId));
  const queueLength = state.queue.length;
  state.queue = state.queue.filter((entry) => !removed.has(entry.byDeviceId) && (entry.targetDeviceId === null || !removed.has(entry.targetDeviceId)));
  if (state.queue.length !== queueLength) effects.push({ type: "queue-changed" });
  let shouldDrainQueue = pendingRemovalCount !== state.pendingRemovalDeviceIds.length;
  if (state.pendingHostDeviceId !== null && removed.has(state.pendingHostDeviceId)) {
    state.pendingHostDeviceId = null;
    shouldDrainQueue = true;
  }
  if (state.hostDeviceId !== null && removed.has(state.hostDeviceId)) state.hostDeviceId = null;

  if (state.vote) {
    if (removed.has(state.vote.starterDeviceId) || removed.has(state.vote.targetDeviceId)) {
      state.vote = null;
      shouldDrainQueue = true;
    }
    else {
      state.vote.votes = state.vote.votes.filter((vote) => !removed.has(vote.deviceId));
      if (allEligibleVoted(state)) resolveVote(state, effects);
    }
  }
  if (state.rps && (removed.has(state.rps.p1DeviceId) || removed.has(state.rps.p2DeviceId))) {
    state.rps = null;
    shouldDrainQueue = true;
  }
  if (state.ttt && (removed.has(state.ttt.p1DeviceId) || removed.has(state.ttt.p2DeviceId))) {
    state.ttt = null;
    shouldDrainQueue = true;
  }
  // Changing the participant set after commitments would let a departure bias
  // the draw, so any such MLS membership change aborts Saboteur fail-closed.
  if (state.saboteur && state.saboteur.participantDeviceIds.some((deviceId) => removed.has(deviceId))) {
    state.saboteur = null;
    shouldDrainQueue = true;
  }
  if (shouldDrainQueue) drainNextQueuedGame(state, effects);
  state.revision++;
  if (!isSecureRoomStateSnapshotV4(state) || !snapshotMatchesMembership(state, membership, false)) {
    return { ok: false, code: "invalid-transition" };
  }
  return { ok: true, state, effects };
}

function snapshotMatchesMembership(
  state: SecureRoomStateSnapshotV4,
  members: readonly SecureMemberCredentialV4[],
  requireExact = true,
): boolean {
  if ((requireExact && state.members.length !== members.length) || state.leaderboards.length !== state.members.length ||
      state.membershipAdmissionBindings.length !== members.length) return false;
  const memberMap = new Map(members.map((member) => [member.deviceId, member]));
  if (!state.membershipAdmissionBindings.every((binding) => memberMap.has(binding.deviceId))) return false;
  if (!state.members.every((member) => {
    const credential = memberMap.get(member.deviceId);
    return credential !== undefined && (credential.displayName == null || credential.displayName === member.displayName);
  })) return false;
  if (!state.leaderboards.every((entry) => memberMap.has(entry.deviceId))) return false;
  const ids = new Set(state.members.map((member) => member.deviceId));
  const known = (deviceId: string | null) => deviceId === null || ids.has(deviceId);
  if (!known(state.hostDeviceId) || !known(state.pendingHostDeviceId)) return false;
  if (!state.pendingRemovalDeviceIds.every((deviceId) => ids.has(deviceId) && deviceId !== state.hostDeviceId)) return false;
  if (!state.messages.every((message) => ids.has(message.deviceId) && currentMember(state, message.deviceId)?.displayName === message.displayName)) return false;
  if (!state.drawings.every((drawing) => ids.has(drawing.deviceId) && currentMember(state, drawing.deviceId)?.displayName === drawing.displayName)) return false;
  if (!state.queue.every((item) => ids.has(item.byDeviceId) && known(item.targetDeviceId))) return false;
  if (state.vote && (!ids.has(state.vote.starterDeviceId) || !ids.has(state.vote.targetDeviceId) || !state.vote.votes.every((vote) => ids.has(vote.deviceId)))) return false;
  if (state.rps && (!ids.has(state.rps.p1DeviceId) || !ids.has(state.rps.p2DeviceId))) return false;
  if (state.ttt && (!ids.has(state.ttt.p1DeviceId) || !ids.has(state.ttt.p2DeviceId))) return false;
  if (state.saboteur && !state.saboteur.participantDeviceIds.every((id) => ids.has(id))) return false;
  return [state.vote, state.rps, state.ttt, state.saboteur].filter((game) => game !== null).length <= 1;
}

function isPristineEmptyState(state: SecureRoomStateSnapshotV4): boolean {
  return state.logicalOrder === 0 && state.revision === 0 && state.hostDeviceId === null && state.pendingHostDeviceId === null &&
    state.pendingRemovalDeviceIds.length === 0 && state.membershipAdmissionBindings.length === 0 &&
    state.closedReason === null && state.theme === "away-message" && state.members.length === 0 && state.leaderboards.length === 0 &&
    state.messages.length === 0 && state.drawings.length === 0 && state.queue.length === 0 && state.seenEventIds.length === 0 &&
    state.vote === null && state.rps === null && state.ttt === null && state.saboteur === null;
}

function finalize(
  state: SecureRoomStateSnapshotV4,
  event: SecureApplicationEventV4,
  effects: SecureReducerEffectV4[],
): SecureReducerResultV4 {
  const member = currentMember(state, event.deviceId);
  if (!member) return { ok: false, code: "profile-required" };
  member.lastSequence = event.deviceSequence;
  state.logicalOrder = event.logicalOrder;
  state.revision++;
  state.seenEventIds.push(event.eventId);
  if (state.seenEventIds.length > MAX_SECURE_SEEN_EVENT_IDS) state.seenEventIds.shift();
  if (!isSecureRoomStateSnapshotV4(state)) return { ok: false, code: "invalid-transition" };
  return { ok: true, state, effects };
}

function resolveVote(state: SecureRoomStateSnapshotV4, effects: SecureReducerEffectV4[]) {
  const vote = state.vote!;
  const yes = vote.votes.filter((entry) => entry.choice === "yes").length;
  const no = vote.votes.filter((entry) => entry.choice === "no").length;
  const eligible = state.members.filter((member) => member.deviceId !== vote.targetDeviceId).length;
  const ejected = yes > no && yes > eligible / 2;
  bump(state, "pillowFight", ejected ? vote.starterDeviceId : vote.targetDeviceId);
  effects.push({ type: "vote-result", gameId: vote.gameId, targetDeviceId: vote.targetDeviceId, yes, no, ejected });
  if (ejected) {
    markPendingRemoval(state, vote.targetDeviceId, effects);
    effects.push({ type: "member-removal-request", deviceId: vote.targetDeviceId, reason: "vote" });
  }
  state.vote = null;
  drainNextQueuedGame(state, effects);
}

function allEligibleVoted(state: SecureRoomStateSnapshotV4): boolean {
  if (!state.vote) return false;
  return state.vote.votes.length >= state.members.filter((member) => member.deviceId !== state.vote!.targetDeviceId).length;
}

async function applyRps(
  state: SecureRoomStateSnapshotV4,
  event: SecureApplicationEventV4,
  effects: SecureReducerEffectV4[],
): Promise<boolean> {
  const content = event.content;
  if (content.type !== "rps") return false;
  if (content.action === "challenge") {
    if (activeGame(state) || state.pendingHostDeviceId !== null || state.pendingRemovalDeviceIds.length !== 0 ||
        content.targetDeviceId === event.deviceId || !currentMember(state, content.targetDeviceId)) return false;
    consumeQueuedRequest(state, "rps", event.deviceId, content.targetDeviceId, effects);
    state.rps = { gameId: content.gameId, p1DeviceId: event.deviceId, p2DeviceId: content.targetDeviceId, phase: "pending", koth: false, commitments: [], reveals: [] };
    effects.push({ type: "rps-challenged", gameId: content.gameId, p1DeviceId: event.deviceId, p2DeviceId: content.targetDeviceId });
    return true;
  }
  const game = state.rps;
  if (!game || game.gameId !== content.gameId) return false;
  if (content.action === "cancel" || content.action === "forfeit") {
    const participant = event.deviceId === game.p1DeviceId || event.deviceId === game.p2DeviceId;
    if (content.action === "cancel") {
      const challengerCancelledPending = game.phase === "pending" && event.deviceId === game.p1DeviceId;
      const neutralHostCancelled = !participant && event.deviceId === state.hostDeviceId;
      if (!challengerCancelledPending && !neutralHostCancelled) return false;
    } else if (!participant || game.phase === "pending") return false;
    if (content.action === "forfeit") {
      const winner = event.deviceId === game.p1DeviceId ? game.p2DeviceId : game.p1DeviceId;
      if (game.koth) {
        bump(state, "koth", winner);
        if (winner === game.p1DeviceId) {
          // KOTH cannot directly change transport authority because the relay
          // cannot inspect this encrypted result. Persist the desired successor
          // and require the normal capability-bound host-transfer handshake.
          state.pendingHostDeviceId = winner;
          effects.push({ type: "host-transfer-required", deviceId: winner });
        }
      } else {
        bump(state, "rps", winner);
      }
    }
    effects.push({ type: "game-cancelled", game: "rps", gameId: game.gameId, byDeviceId: event.deviceId, forfeited: content.action === "forfeit" });
    state.rps = null;
    drainNextQueuedGame(state, effects);
    return true;
  }
  if (content.action === "accept") {
    if (game.phase !== "pending" || event.deviceId !== game.p2DeviceId) return false;
    game.phase = "committing";
    effects.push({ type: "rps-started", gameId: game.gameId, p1DeviceId: game.p1DeviceId, p2DeviceId: game.p2DeviceId, koth: game.koth });
    return true;
  }
  if (content.action === "decline") {
    if (game.phase !== "pending" || event.deviceId !== game.p2DeviceId) return false;
    effects.push({ type: "rps-declined", gameId: game.gameId, byDeviceId: event.deviceId });
    state.rps = null;
    drainNextQueuedGame(state, effects);
    return true;
  }
  if (event.deviceId !== game.p1DeviceId && event.deviceId !== game.p2DeviceId) return false;
  if (content.action === "commit") {
    if (game.phase !== "committing" || game.commitments.some((entry) => entry.deviceId === event.deviceId)) return false;
    game.commitments.push({ deviceId: event.deviceId, commitment: content.commitment });
    if (game.commitments.length === 2) game.phase = "revealing";
    return true;
  }
  if (content.action !== "reveal") return false;
  if (game.phase !== "revealing" || game.reveals.some((entry) => entry.deviceId === event.deviceId)) return false;
  const commitment = game.commitments.find((entry) => entry.deviceId === event.deviceId)?.commitment;
  if (!commitment || await computeRpsCommitmentV4(game.gameId, event.deviceId, content.pick, content.nonce) !== commitment) return false;
  game.reveals.push({ deviceId: event.deviceId, pick: content.pick, nonce: content.nonce });
  if (game.reveals.length === 2) {
    const first = game.reveals.find((entry) => entry.deviceId === game.p1DeviceId)!;
    const second = game.reveals.find((entry) => entry.deviceId === game.p2DeviceId)!;
    const winner = rpsWinner(game.p1DeviceId, game.p2DeviceId, first.pick, second.pick);
    effects.push({ type: "rps-result", gameId: game.gameId, p1DeviceId: game.p1DeviceId, p2DeviceId: game.p2DeviceId, pick1: first.pick, pick2: second.pick, winnerDeviceId: winner, koth: game.koth });
    if (game.koth) {
      if (winner) {
        bump(state, "koth", winner);
        if (winner === game.p1DeviceId) {
          // See the forfeit path above: only a separately authorized transfer
          // may update hostDeviceId on both encrypted and relay state.
          state.pendingHostDeviceId = winner;
          effects.push({ type: "host-transfer-required", deviceId: winner });
        }
      }
    } else if (winner) {
      bump(state, "rps", winner);
    }
    state.rps = null;
    drainNextQueuedGame(state, effects);
  }
  return true;
}

function applyTtt(state: SecureRoomStateSnapshotV4, event: SecureApplicationEventV4, effects: SecureReducerEffectV4[]): boolean {
  const content = event.content;
  if (content.type !== "ttt") return false;
  if (content.action === "challenge") {
    if (activeGame(state) || state.pendingHostDeviceId !== null || state.pendingRemovalDeviceIds.length !== 0 ||
        content.targetDeviceId === event.deviceId || !currentMember(state, content.targetDeviceId)) return false;
    consumeQueuedRequest(state, "ttt", event.deviceId, content.targetDeviceId, effects);
    state.ttt = { gameId: content.gameId, p1DeviceId: event.deviceId, p2DeviceId: content.targetDeviceId, phase: "pending", board: ["", "", "", "", "", "", "", "", ""], turn: 0 };
    effects.push({ type: "ttt-challenged", gameId: content.gameId, p1DeviceId: event.deviceId, p2DeviceId: content.targetDeviceId });
    return true;
  }
  const game = state.ttt;
  if (!game || game.gameId !== content.gameId) return false;
  if (content.action === "cancel" || content.action === "forfeit") {
    const participant = event.deviceId === game.p1DeviceId || event.deviceId === game.p2DeviceId;
    if (content.action === "cancel") {
      const challengerCancelledPending = game.phase === "pending" && event.deviceId === game.p1DeviceId;
      const neutralHostCancelled = !participant && event.deviceId === state.hostDeviceId;
      if (!challengerCancelledPending && !neutralHostCancelled) return false;
    } else if (!participant || game.phase === "pending") return false;
    if (content.action === "forfeit") bump(state, "ttt", event.deviceId === game.p1DeviceId ? game.p2DeviceId : game.p1DeviceId);
    effects.push({ type: "game-cancelled", game: "ttt", gameId: game.gameId, byDeviceId: event.deviceId, forfeited: content.action === "forfeit" });
    state.ttt = null;
    drainNextQueuedGame(state, effects);
    return true;
  }
  if (content.action === "accept") {
    if (game.phase !== "pending" || event.deviceId !== game.p2DeviceId) return false;
    game.phase = "playing";
    effects.push({ type: "ttt-started", gameId: game.gameId, p1DeviceId: game.p1DeviceId, p2DeviceId: game.p2DeviceId });
    return true;
  }
  if (content.action === "decline") {
    if (game.phase !== "pending" || event.deviceId !== game.p2DeviceId) return false;
    effects.push({ type: "ttt-declined", gameId: game.gameId, byDeviceId: event.deviceId });
    state.ttt = null;
    drainNextQueuedGame(state, effects);
    return true;
  }
  if (content.action !== "move") return false;
  if (game.phase !== "playing") return false;
  const expected = game.turn % 2 === 0 ? game.p1DeviceId : game.p2DeviceId;
  if (event.deviceId !== expected || game.board[content.cell] !== "") return false;
  const mark = game.turn % 2 === 0 ? "X" : "O";
  game.board[content.cell] = mark;
  game.turn++;
  effects.push({ type: "ttt-updated", gameId: game.gameId, cell: content.cell, mark, turn: game.turn });
  const won = TTT_WINS.some((line) => line.every((cell) => game.board[cell] === mark));
  const draw = !won && game.turn === 9;
  if (won || draw) {
    if (won) bump(state, "ttt", event.deviceId);
    effects.push({ type: "ttt-result", gameId: game.gameId, winnerDeviceId: won ? event.deviceId : null, draw });
    state.ttt = null;
    drainNextQueuedGame(state, effects);
  }
  return true;
}

async function applySaboteur(
  state: SecureRoomStateSnapshotV4,
  event: SecureApplicationEventV4,
  effects: SecureReducerEffectV4[],
): Promise<boolean> {
  const content = event.content;
  if (content.type !== "saboteur") return false;
  if (content.action === "start") {
    if (activeGame(state) || state.pendingHostDeviceId !== null || state.pendingRemovalDeviceIds.length !== 0 ||
        state.members.length < 4) return false;
    consumeQueuedRequest(state, "saboteur", event.deviceId, null, effects);
    const participants = state.members.map((member) => member.deviceId).sort(codeUnitCompare);
    state.saboteur = {
      gameId: content.gameId,
      starterDeviceId: event.deviceId,
      phase: "committing",
      participantDeviceIds: participants,
      commitments: [],
      reveals: [],
      saboteurDeviceId: null,
      accusation: null,
      strikes: 0,
      canStrike: false,
    };
    effects.push({ type: "saboteur-started", gameId: content.gameId, starterDeviceId: event.deviceId });
    return true;
  }
  const game = state.saboteur;
  if (!game || game.gameId !== content.gameId || !game.participantDeviceIds.includes(event.deviceId)) return false;
  if (content.action === "entropy-commit") {
    if (game.phase !== "committing" || game.commitments.some((entry) => entry.deviceId === event.deviceId)) return false;
    game.commitments.push({ deviceId: event.deviceId, commitment: content.commitment });
    if (game.commitments.length === game.participantDeviceIds.length) game.phase = "revealing";
    return true;
  }
  if (content.action === "entropy-reveal") {
    if (game.phase !== "revealing" || game.reveals.some((entry) => entry.deviceId === event.deviceId)) return false;
    const expected = game.commitments.find((entry) => entry.deviceId === event.deviceId)?.commitment;
    if (!expected || await computeSaboteurCommitmentV4(game.gameId, event.deviceId, content.nonce) !== expected) return false;
    game.reveals.push({ deviceId: event.deviceId, nonce: content.nonce });
    if (game.reveals.length === game.participantDeviceIds.length) {
      game.saboteurDeviceId = await selectSaboteurDeviceV4(game.gameId, game.reveals);
      game.phase = "playing";
      game.canStrike = true;
      effects.push({ type: "saboteur-ready", gameId: game.gameId, saboteurDeviceId: game.saboteurDeviceId });
    }
    return true;
  }
  if (content.action === "close") {
    if (event.deviceId !== state.hostDeviceId && event.deviceId !== game.starterDeviceId) return false;
    effects.push({ type: "game-cancelled", game: "saboteur", gameId: game.gameId, byDeviceId: event.deviceId, forfeited: false });
    state.saboteur = null;
    drainNextQueuedGame(state, effects);
    return true;
  }
  if (game.phase !== "playing" || !game.saboteurDeviceId) return false;

  const resolveAccusation = (): boolean => {
    if (!game.accusation) return false;
    const yes = game.accusation.votes.filter((entry) => entry.choice === "yes").length;
    const no = game.accusation.votes.length - yes;
    const passed = yes > no;
    const correct = passed && game.accusation.suspectDeviceId === game.saboteurDeviceId;
    effects.push({
      type: "saboteur-vote-result", gameId: game.gameId,
      suspectDeviceId: game.accusation.suspectDeviceId, yes, no, passed, wasSaboteur: correct,
    });
    if (correct) {
      for (const deviceId of game.participantDeviceIds) if (deviceId !== game.saboteurDeviceId) bump(state, "saboteur", deviceId);
      state.saboteur = null;
      drainNextQueuedGame(state, effects);
    } else {
      game.accusation = null;
      game.canStrike = true;
    }
    return true;
  };

  if (content.action === "accuse") {
    if (game.accusation || event.deviceId === game.saboteurDeviceId || content.suspectDeviceId === event.deviceId || !game.participantDeviceIds.includes(content.suspectDeviceId)) return false;
    game.accusation = { accuserDeviceId: event.deviceId, suspectDeviceId: content.suspectDeviceId, votes: [{ deviceId: event.deviceId, choice: "yes" }] };
    // Freeze strikes while an accusation is being decided. A failed vote
    // explicitly re-enables the next strike in resolveAccusation().
    game.canStrike = false;
    effects.push({ type: "saboteur-accusation", gameId: game.gameId, accuserDeviceId: event.deviceId, suspectDeviceId: content.suspectDeviceId });
    return true;
  }
  if (content.action === "vote") {
    if (!game.accusation) return false;
    const existing = game.accusation.votes.find((entry) => entry.deviceId === event.deviceId);
    if (existing) existing.choice = content.choice;
    else game.accusation.votes.push({ deviceId: event.deviceId, choice: content.choice });
    if (game.accusation.votes.length === game.participantDeviceIds.length) resolveAccusation();
    return true;
  }
  if (content.action === "resolve-vote") {
    // A tally is authoritative only once every participant has signed a vote.
    // The final vote resolves automatically, so this legacy close action must
    // never turn a host-selected partial tally into a game result.
    return event.deviceId === state.hostDeviceId &&
      game.accusation !== null &&
      game.accusation.votes.length === game.participantDeviceIds.length &&
      resolveAccusation();
  }
  if (event.deviceId !== game.saboteurDeviceId || !game.canStrike) return false;
  game.canStrike = false;
  game.strikes++;
  effects.push({ type: "saboteur-strike", gameId: game.gameId, strikes: game.strikes, saboteurDeviceId: game.strikes >= 3 ? game.saboteurDeviceId : null });
  if (game.strikes >= 3) {
    bump(state, "saboteur", game.saboteurDeviceId);
    state.closedReason = "the saboteur's bomb exploded!";
    effects.push({ type: "room-closed", reason: state.closedReason });
    state.saboteur = null;
  }
  return true;
}

/**
 * Verifies and applies one event without reading clocks, generating randomness,
 * mutating the input, or consulting the relay. WebCrypto calls are deterministic
 * signature/hash verification only, so every member derives the same result.
 */
export async function reduceSecureRoomEventV4(
  current: SecureRoomStateSnapshotV4,
  eventValue: unknown,
  membership: readonly SecureMemberCredentialV4[],
): Promise<SecureReducerResultV4> {
  if (!isSecureRoomStateSnapshotV4(current)) return { ok: false, code: "invalid-state" };
  if (!validMembership(membership)) return { ok: false, code: "invalid-membership" };
  if (!isPristineEmptyState(current) && !snapshotMatchesMembership(current, membership, false)) {
    return { ok: false, code: "membership-mismatch" };
  }
  if (!isSecureApplicationEventV4(eventValue)) return { ok: false, code: "invalid-event" };
  // Own the complete nested event before any awaited signature verification.
  // Otherwise a caller holding the input object could mutate signed content
  // between validation and reduction.
  const event = JSON.parse(canonicalJsonV4(eventValue)) as SecureApplicationEventV4;
  if (event.roomInstance !== current.roomInstance) return { ok: false, code: "wrong-room" };
  const credential = membership.find((member) => member.deviceId === event.deviceId);
  if (!credential) return { ok: false, code: "unknown-signer" };
  const isBootstrapSnapshot = isPristineEmptyState(current) && event.content.type === "state-snapshot";
  if (current.seenEventIds.includes(event.eventId)) return { ok: false, code: "duplicate-event" };
  if (!isBootstrapSnapshot && event.logicalOrder !== current.logicalOrder + 1) return { ok: false, code: "out-of-order" };
  const existingMember = currentMember(current, event.deviceId);
  const expectedSequence = (existingMember?.lastSequence ?? 0) + 1;
  if (!isBootstrapSnapshot && event.deviceSequence !== expectedSequence) return { ok: false, code: "bad-device-sequence" };
  if (!await verifySecureApplicationEventV4(event, credential.signaturePublicKey, { expectedRoomInstance: current.roomInstance })) {
    return { ok: false, code: "invalid-signature" };
  }
  if (current.closedReason !== null) return { ok: false, code: "room-closed" };

  if (event.content.type === "state-snapshot") {
    const snapshot = event.content.state;
    if (isBootstrapSnapshot) {
      if (snapshot.roomInstance !== current.roomInstance || snapshot.hostDeviceId !== event.deviceId ||
          // Admission snapshots describe current room state, not transcript
          // history. Re-encrypting pre-admission chat or drawings to the new
          // epoch would defeat the membership forward-secrecy boundary.
          snapshot.messages.length !== 0 || snapshot.drawings.length !== 0 ||
          snapshot.logicalOrder !== event.logicalOrder || snapshot.revision < snapshot.logicalOrder ||
          snapshot.seenEventIds[snapshot.seenEventIds.length - 1] !== event.eventId ||
          snapshot.membershipAdmissionBindings.some((binding) => binding.admissionId === null) ||
          snapshot.members.find((member) => member.deviceId === event.deviceId)?.lastSequence !== event.deviceSequence ||
          // A freshly admitted MLS member has not bound an application profile
          // yet, so a host snapshot can only contain the already-profiled
          // subset of the authenticated MLS roster. The host is still required
          // to be present, sign the snapshot with its current roster key, and
          // identify itself as host (the checks above enforce all three).
          !snapshotMatchesMembership(snapshot, membership, false)) return { ok: false, code: "invalid-transition" };
      return { ok: true, state: cloneState(snapshot), effects: [{ type: "snapshot-restored", revision: snapshot.revision }] };
    }
    if (event.deviceId !== current.hostDeviceId) return { ok: false, code: "invalid-transition" };
    // Existing members must never treat a host-signed admission snapshot as an
    // authorization to rewrite history or game results. The only valid update
    // is the exact current state with this event's monotonic counters appended.
    const expected = cloneState(current);
    const incumbentMessages = expected.messages;
    const incumbentDrawings = expected.drawings;
    const expectedHost = expected.members.find((member) => member.deviceId === event.deviceId);
    if (!expectedHost) return { ok: false, code: "invalid-transition" };
    expectedHost.lastSequence = event.deviceSequence;
    expected.logicalOrder = event.logicalOrder;
    expected.revision = Math.max(expected.revision + 1, event.logicalOrder);
    expected.seenEventIds.push(event.eventId);
    if (expected.seenEventIds.length > MAX_SECURE_SEEN_EVENT_IDS) expected.seenEventIds.shift();
    // Every recipient validates the exact same signed, history-redacted
    // snapshot. Existing members then retain their own local live history;
    // only a freshly admitted member starts from the redacted representation.
    expected.messages = [];
    expected.drawings = [];
    if (canonicalJsonV4(snapshot) !== canonicalJsonV4(expected) ||
        !snapshotMatchesMembership(snapshot, membership, false)) return { ok: false, code: "invalid-transition" };
    const merged = cloneState(snapshot);
    merged.messages = incumbentMessages;
    merged.drawings = incumbentDrawings;
    return { ok: true, state: merged, effects: [{ type: "snapshot-restored", revision: snapshot.revision }] };
  }

  if (!existingMember && event.content.type !== "member-profile") return { ok: false, code: "profile-required" };
  if (existingMember && credential.displayName != null && existingMember.displayName !== credential.displayName && event.content.type !== "member-profile") {
    return { ok: false, code: "membership-mismatch" };
  }
  if (current.pendingRemovalDeviceIds.includes(event.deviceId)) {
    return { ok: false, code: "invalid-transition" };
  }

  const state = cloneState(current);
  const effects: SecureReducerEffectV4[] = [];
  const actor = currentMember(state, event.deviceId);
  const content = event.content;
  let accepted = true;

  switch (content.type) {
    case "member-profile": {
      if ((credential.displayName != null && content.displayName !== credential.displayName) ||
          (actor && actor.displayName !== content.displayName) ||
          state.members.some((member) => member.deviceId !== event.deviceId && member.displayName.toLowerCase() === content.displayName.toLowerCase())) {
        return { ok: false, code: "membership-mismatch" };
      }
      if (actor) actor.displayName = content.displayName;
      else {
        if (state.members.length >= MAX_SECURE_MEMBERS) return { ok: false, code: "state-limit" };
        const firstMember = state.members.length === 0 && state.hostDeviceId === null;
        state.members.push({ deviceId: event.deviceId, displayName: content.displayName, status: "available", awayText: null, lastSequence: 0 });
        state.leaderboards.push({ deviceId: event.deviceId, pillowFight: 0, rps: 0, ttt: 0, saboteur: 0, koth: 0 });
        if (firstMember) {
          state.hostDeviceId = event.deviceId;
          effects.push({ type: "host-changed", deviceId: event.deviceId });
        }
      }
      effects.push({ type: "profile", deviceId: event.deviceId, displayName: content.displayName });
      break;
    }
    case "member-leave":
      if (event.deviceId === state.hostDeviceId) accepted = false;
      else {
        markPendingRemoval(state, event.deviceId, effects);
        effects.push({ type: "member-removal-request", deviceId: event.deviceId, reason: "leave" });
      }
      break;
    case "presence":
      actor!.status = content.status;
      actor!.awayText = content.status === "away" ? content.awayText ?? null : null;
      effects.push({ type: "presence", deviceId: event.deviceId, status: content.status, awayText: actor!.awayText });
      break;
    case "chat": {
      const message = { eventId: event.eventId, deviceId: event.deviceId, displayName: actor!.displayName, text: content.text, style: content.style ?? null };
      // Chat is live-only. Persisting it in the encrypted IndexedDB snapshot
      // would still create durable local history and would disclose prior
      // messages to a newly admitted member through the bootstrap snapshot.
      effects.push({ type: "chat", ...message });
      break;
    }
    case "typing":
      effects.push({ type: "typing", deviceId: event.deviceId, displayName: actor!.displayName });
      break;
    case "drawing": {
      const drawing = { eventId: event.eventId, deviceId: event.deviceId, displayName: actor!.displayName, color: content.color, points: content.points.map(([x, y]) => [x, y] as [number, number]), strokeStart: content.strokeStart === true };
      // Drawings follow the same live-only privacy boundary as chat.
      effects.push({ type: "drawing", ...drawing });
      break;
    }
    case "theme":
      if (event.deviceId !== state.hostDeviceId) accepted = false;
      else {
        state.theme = content.theme;
        effects.push({ type: "theme-changed", theme: content.theme });
      }
      break;
    case "pillow-toss":
      if (event.deviceId !== state.hostDeviceId || activeGame(state) || state.pendingHostDeviceId !== null ||
          state.pendingRemovalDeviceIds.length !== 0 ||
          content.targetDeviceId === event.deviceId || !currentMember(state, content.targetDeviceId)) accepted = false;
      else {
        state.pendingHostDeviceId = content.targetDeviceId;
        effects.push({ type: "pillow-tossed", fromDeviceId: event.deviceId, targetDeviceId: content.targetDeviceId });
        effects.push({ type: "host-offered", deviceId: content.targetDeviceId });
      }
      break;
    case "host-transfer":
      if (content.action === "offer") {
        if (event.deviceId !== state.hostDeviceId || activeGame(state) || state.pendingRemovalDeviceIds.length !== 0 ||
            (state.pendingHostDeviceId !== null && state.pendingHostDeviceId !== content.targetDeviceId) ||
            content.targetDeviceId === event.deviceId || !currentMember(state, content.targetDeviceId)) accepted = false;
        else {
          state.pendingHostDeviceId = content.targetDeviceId;
          effects.push({ type: "host-offered", deviceId: content.targetDeviceId });
        }
      } else if (event.deviceId !== state.pendingHostDeviceId) {
        accepted = false;
      } else if (content.action === "accept") {
        state.hostDeviceId = event.deviceId;
        state.pendingHostDeviceId = null;
        effects.push({ type: "host-changed", deviceId: event.deviceId });
        drainNextQueuedGame(state, effects);
      } else {
        state.pendingHostDeviceId = null;
        effects.push({ type: "host-rejected", deviceId: event.deviceId });
        drainNextQueuedGame(state, effects);
      }
      break;
    case "room-close":
      if (event.deviceId !== state.hostDeviceId) accepted = false;
      else {
        state.closedReason = content.reason;
        effects.push({ type: "room-closed", reason: content.reason });
      }
      break;
    case "queue":
      if (content.action === "enqueue") {
        if (state.queue.length >= MAX_SECURE_GAME_QUEUE || activeGameId(state) === content.requestId ||
            state.queue.some((item) => item.requestId === content.requestId) ||
            (content.targetDeviceId !== undefined && (content.targetDeviceId === event.deviceId ||
              !currentMember(state, content.targetDeviceId) ||
              state.pendingRemovalDeviceIds.includes(content.targetDeviceId) ||
              (content.game === "vote" && content.targetDeviceId === state.hostDeviceId)))) accepted = false;
        else {
          state.queue.push({ requestId: content.requestId, game: content.game, byDeviceId: event.deviceId, targetDeviceId: content.targetDeviceId ?? null });
          effects.push({ type: "queue-changed" });
          drainNextQueuedGame(state, effects);
        }
      } else {
        const index = state.queue.findIndex((item) => item.requestId === content.requestId);
        if (index < 0 || (state.queue[index].byDeviceId !== event.deviceId && state.hostDeviceId !== event.deviceId)) accepted = false;
        else {
          state.queue.splice(index, 1);
          effects.push({ type: "queue-changed" });
        }
      }
      break;
    case "vote":
      if (content.action === "start") {
        if (activeGame(state) || state.pendingHostDeviceId !== null || state.pendingRemovalDeviceIds.length !== 0 ||
            state.members.length < 3 ||
            content.targetDeviceId === event.deviceId ||
            content.targetDeviceId === state.hostDeviceId || !currentMember(state, content.targetDeviceId)) accepted = false;
        else {
          consumeQueuedRequest(state, "vote", event.deviceId, content.targetDeviceId, effects);
          state.vote = { gameId: content.gameId, starterDeviceId: event.deviceId, targetDeviceId: content.targetDeviceId, votes: [{ deviceId: event.deviceId, choice: "yes" }] };
          effects.push({ type: "vote-started", gameId: content.gameId, starterDeviceId: event.deviceId, targetDeviceId: content.targetDeviceId });
        }
      } else if (!state.vote || state.vote.gameId !== content.gameId) {
        accepted = false;
      } else if (content.action === "cancel") {
        if (event.deviceId !== state.hostDeviceId && event.deviceId !== state.vote.starterDeviceId) accepted = false;
        else {
          const gameId = state.vote.gameId;
          state.vote = null;
          effects.push({ type: "game-cancelled", game: "vote", gameId, byDeviceId: event.deviceId, forfeited: false });
          drainNextQueuedGame(state, effects);
        }
      } else if (content.action === "cast") {
        if (event.deviceId === state.vote.targetDeviceId || state.vote.votes.some((entry) => entry.deviceId === event.deviceId)) accepted = false;
        else {
          state.vote.votes.push({ deviceId: event.deviceId, choice: content.choice });
          if (allEligibleVoted(state)) resolveVote(state, effects);
        }
      } else {
        // Complete tallies resolve on the final signed vote. Never allow the
        // host to manufacture a result from a hand-picked partial electorate.
        if (event.deviceId !== state.hostDeviceId || !allEligibleVoted(state)) accepted = false;
        else resolveVote(state, effects);
      }
      break;
    case "rps":
      accepted = await applyRps(state, event, effects);
      break;
    case "ttt":
      accepted = applyTtt(state, event, effects);
      break;
    case "saboteur":
      accepted = await applySaboteur(state, event, effects);
      break;
    case "koth":
      if (content.action !== "challenge" || activeGame(state) || state.pendingHostDeviceId !== null ||
          state.pendingRemovalDeviceIds.length !== 0 ||
          event.deviceId === state.hostDeviceId || !state.hostDeviceId) accepted = false;
      else {
        const hostDeviceId = state.hostDeviceId;
        consumeQueuedRequest(state, "koth", event.deviceId, null, effects);
        state.rps = { gameId: content.gameId, p1DeviceId: event.deviceId, p2DeviceId: hostDeviceId, phase: "committing", koth: true, commitments: [], reveals: [] };
        effects.push({ type: "koth-started", gameId: content.gameId, challengerDeviceId: event.deviceId, hostDeviceId });
        effects.push({ type: "rps-started", gameId: content.gameId, p1DeviceId: event.deviceId, p2DeviceId: hostDeviceId, koth: true });
      }
      break;
  }

  if (!accepted) return { ok: false, code: "invalid-transition" };
  return finalize(state, event, effects);
}
