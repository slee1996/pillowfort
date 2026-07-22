import { verifyAsync } from "@noble/ed25519";
import {
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
} from "./protocolV4";

export const MAX_SECURE_APPLICATION_EVENT_BYTES = 60 * 1024;
export const MAX_SECURE_MEMBERS = 20;
export const MAX_SECURE_GAME_QUEUE = 10;
export const MAX_SECURE_DRAW_POINTS = 128;
export const MAX_SECURE_SNAPSHOT_MESSAGES = 16;
export const MAX_SECURE_SNAPSHOT_DRAWINGS = 16;
export const MAX_SECURE_SEEN_EVENT_IDS = 1024;
export const SECURE_APPLICATION_EVENT_SIGNATURE_BYTES = 64;
export const SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES = 32;
export const SECURE_COMMITMENT_BYTES = 32;
export const SECURE_REVEAL_NONCE_BYTES = 32;

const SIGNING_DOMAIN = "Pillowfort Secure Room Application Event v4\0";
const UTF8 = new TextEncoder();
const STYLE_COLORS = new Set([
  "#FF0000", "#0000FF", "#008000", "#FF8C00",
  "#800080", "#000000", "#FF69B4", "#8B4513",
]);
const THEMES = new Set(["away-message", "campus-blue", "top-8"]);
const GAME_KINDS = new Set(["vote", "rps", "ttt", "saboteur", "koth"]);
const RPS_PICKS = new Set(["rock", "paper", "scissors"]);

export type SecureRoomThemeV4 = "away-message" | "campus-blue" | "top-8";
export type SecureGameKindV4 = "vote" | "rps" | "ttt" | "saboteur" | "koth";
export type SecureRpsPickV4 = "rock" | "paper" | "scissors";
export type SecureVoteChoiceV4 = "yes" | "no";

export interface SecureChatStyleV4 {
  bold?: true;
  italic?: true;
  underline?: true;
  color?: string;
}

export type SecureApplicationContentV4 =
  | { type: "member-profile"; displayName: string }
  | { type: "member-leave" }
  | { type: "presence"; status: "available" | "away"; awayText?: string }
  | { type: "chat"; text: string; style?: SecureChatStyleV4 }
  | { type: "typing" }
  | { type: "drawing"; color: string; points: [number, number][]; strokeStart?: true }
  | { type: "theme"; theme: SecureRoomThemeV4 }
  | { type: "pillow-toss"; targetDeviceId: string }
  | { type: "host-transfer"; action: "offer"; targetDeviceId: string }
  | { type: "host-transfer"; action: "accept"; authorizationId: string }
  | { type: "host-transfer"; action: "reject" }
  | { type: "room-close"; reason: string }
  | { type: "queue"; action: "enqueue"; requestId: string; game: SecureGameKindV4; targetDeviceId?: string }
  | { type: "queue"; action: "cancel"; requestId: string }
  | { type: "vote"; action: "start"; gameId: string; targetDeviceId: string }
  | { type: "vote"; action: "cast"; gameId: string; choice: SecureVoteChoiceV4 }
  | { type: "vote"; action: "close" | "cancel"; gameId: string }
  | { type: "rps"; action: "challenge"; gameId: string; targetDeviceId: string }
  | { type: "rps"; action: "accept" | "decline" | "cancel" | "forfeit"; gameId: string }
  | { type: "rps"; action: "commit"; gameId: string; commitment: string }
  | { type: "rps"; action: "reveal"; gameId: string; pick: SecureRpsPickV4; nonce: string }
  | { type: "ttt"; action: "challenge"; gameId: string; targetDeviceId: string }
  | { type: "ttt"; action: "accept" | "decline" | "cancel" | "forfeit"; gameId: string }
  | { type: "ttt"; action: "move"; gameId: string; cell: number }
  | { type: "saboteur"; action: "start"; gameId: string }
  | { type: "saboteur"; action: "entropy-commit"; gameId: string; commitment: string }
  | { type: "saboteur"; action: "entropy-reveal"; gameId: string; nonce: string }
  | { type: "saboteur"; action: "accuse"; gameId: string; suspectDeviceId: string }
  | { type: "saboteur"; action: "vote"; gameId: string; choice: SecureVoteChoiceV4 }
  | { type: "saboteur"; action: "resolve-vote"; gameId: string }
  | { type: "saboteur"; action: "strike"; gameId: string }
  | { type: "saboteur"; action: "close"; gameId: string }
  | { type: "koth"; action: "challenge"; gameId: string }
  | { type: "state-snapshot"; state: SecureRoomStateSnapshotV4 };

export interface SecureUnsignedApplicationEventV4 {
  v: 4;
  roomInstance: string;
  eventId: string;
  deviceId: string;
  deviceSequence: number;
  logicalOrder: number;
  content: SecureApplicationContentV4;
}

export interface SecureApplicationEventV4 extends SecureUnsignedApplicationEventV4 {
  signature: string;
}

export interface SecureSnapshotMemberV4 {
  deviceId: string;
  displayName: string;
  status: "available" | "away";
  awayText: string | null;
  lastSequence: number;
}

/**
 * Binds every current MLS leaf to its invitation-authenticated admission id.
 * That id commits to the room, device, credential key, and KeyPackage digest;
 * the founder's id is its authenticated setup request id. The ledger covers an
 * unprofiled leaf while its admission proof is pending, so a signed bootstrap
 * can transfer the binding to a future host without trusting relay metadata.
 */
export interface SecureMembershipAdmissionBindingV4 {
  deviceId: string;
  admissionId: string | null;
}

export interface SecureSnapshotChatV4 {
  eventId: string;
  deviceId: string;
  displayName: string;
  text: string;
  style: SecureChatStyleV4 | null;
}

export interface SecureSnapshotDrawingV4 {
  eventId: string;
  deviceId: string;
  displayName: string;
  color: string;
  points: [number, number][];
  strokeStart: boolean;
}

export interface SecureSnapshotQueueItemV4 {
  requestId: string;
  game: SecureGameKindV4;
  byDeviceId: string;
  targetDeviceId: string | null;
}

export interface SecureSnapshotVoteV4 {
  gameId: string;
  starterDeviceId: string;
  targetDeviceId: string;
  votes: { deviceId: string; choice: SecureVoteChoiceV4 }[];
}

export interface SecureSnapshotRpsV4 {
  gameId: string;
  p1DeviceId: string;
  p2DeviceId: string;
  phase: "pending" | "committing" | "revealing";
  koth: boolean;
  commitments: { deviceId: string; commitment: string }[];
  reveals: { deviceId: string; pick: SecureRpsPickV4; nonce: string }[];
}

export interface SecureSnapshotTttV4 {
  gameId: string;
  p1DeviceId: string;
  p2DeviceId: string;
  phase: "pending" | "playing";
  board: ("" | "X" | "O")[];
  turn: number;
}

export interface SecureSnapshotSaboteurV4 {
  gameId: string;
  starterDeviceId: string;
  phase: "committing" | "revealing" | "playing";
  participantDeviceIds: string[];
  commitments: { deviceId: string; commitment: string }[];
  reveals: { deviceId: string; nonce: string }[];
  saboteurDeviceId: string | null;
  accusation: {
    accuserDeviceId: string;
    suspectDeviceId: string;
    votes: { deviceId: string; choice: SecureVoteChoiceV4 }[];
  } | null;
  strikes: number;
  canStrike: boolean;
}

export interface SecureSnapshotLeaderboardV4 {
  deviceId: string;
  pillowFight: number;
  rps: number;
  ttt: number;
  saboteur: number;
  koth: number;
}

/**
 * A bounded, canonical snapshot of all persistent application state. Transient
 * typing indicators and timeout clocks are deliberately excluded: neither is
 * authoritative state in protocol v4.
 */
export interface SecureRoomStateSnapshotV4 {
  v: 4;
  roomInstance: string;
  logicalOrder: number;
  revision: number;
  hostDeviceId: string | null;
  pendingHostDeviceId: string | null;
  /** Members whose authenticated leave/ejection is awaiting an MLS Remove. */
  pendingRemovalDeviceIds: string[];
  /** Exact current MLS-roster establishment bindings, sorted by device id. */
  membershipAdmissionBindings: SecureMembershipAdmissionBindingV4[];
  theme: SecureRoomThemeV4;
  closedReason: string | null;
  members: SecureSnapshotMemberV4[];
  messages: SecureSnapshotChatV4[];
  drawings: SecureSnapshotDrawingV4[];
  queue: SecureSnapshotQueueItemV4[];
  vote: SecureSnapshotVoteV4 | null;
  rps: SecureSnapshotRpsV4 | null;
  ttt: SecureSnapshotTttV4 | null;
  saboteur: SecureSnapshotSaboteurV4 | null;
  leaderboards: SecureSnapshotLeaderboardV4[];
  seenEventIds: string[];
}

export interface SecureApplicationEventValidationOptionsV4 {
  expectedRoomInstance?: string;
}

/** The MLS adapter signs with the Ed25519 credential key without exporting it. */
export type SecureApplicationEventSignerV4 = (signingBytes: Uint8Array) => Promise<Uint8Array | string>;

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isText(value: unknown, maxBytes: number, options: { nonEmpty?: boolean; trimmed?: boolean } = {}): value is string {
  if (typeof value !== "string" || !hasValidUnicode(value) || value.normalize("NFC") !== value) return false;
  if (options.nonEmpty && value.length === 0) return false;
  if (options.trimmed && value.trim() !== value) return false;
  return UTF8.encode(value).byteLength <= maxBytes;
}

function isSafeCounter(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && (allowZero ? (value as number) >= 0 : (value as number) >= 1);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isStrictArray(value: unknown, maxLength: number, exactLength?: number): value is unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (value.length > maxLength || (exactLength !== undefined && value.length !== exactLength)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/u.test(key)))) return false;
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key));
}

function isFixedBase64Url(value: unknown, bytes: number): value is string {
  return canonicalBase64UrlByteLength(value) === bytes;
}

function isDeviceId(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_DEVICE_ID_BYTES);
}

function isEventId(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_MESSAGE_ID_BYTES);
}

function isGameId(value: unknown): value is string {
  return isEventId(value);
}

function isCommitment(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_COMMITMENT_BYTES);
}

function isNonce(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_REVEAL_NONCE_BYTES);
}

export function isSecureDisplayNameV4(value: unknown): value is string {
  if (!isText(value, 96, { nonEmpty: true, trimmed: true }) || [...value].length > 24 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return false;
  }
  const folded = value.toLowerCase();
  return folded !== "__proto__" && folded !== "prototype" && folded !== "constructor";
}

function isAwayText(value: unknown): value is string {
  return isText(value, 480, { nonEmpty: true, trimmed: true }) && [...value].length <= 120 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isReason(value: unknown): value is string {
  return isText(value, 640, { nonEmpty: true, trimmed: true }) && [...value].length <= 160 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isStyle(value: unknown): value is SecureChatStyleV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [], ["bold", "italic", "underline", "color"])) return false;
  if (Reflect.ownKeys(value).length === 0) return false;
  if (value.bold !== undefined && value.bold !== true) return false;
  if (value.italic !== undefined && value.italic !== true) return false;
  if (value.underline !== undefined && value.underline !== true) return false;
  if (value.color !== undefined && (typeof value.color !== "string" || !STYLE_COLORS.has(value.color))) return false;
  return true;
}

function isDrawColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (STYLE_COLORS.has(value)) return true;
  const match = /^hsl\((\d{1,3}), 80%, 65%\)$/u.exec(value);
  return !!match && Number(match[1]) <= 359;
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) && value >= 0 && value <= 1;
}

function isPoints(value: unknown): value is [number, number][] {
  if (!isStrictArray(value, MAX_SECURE_DRAW_POINTS) || value.length < 1) return false;
  return value.every((point) => isStrictArray(point, 2, 2) && isCoordinate(point[0]) && isCoordinate(point[1]));
}

function isChoice(value: unknown): value is SecureVoteChoiceV4 {
  return value === "yes" || value === "no";
}

function isPick(value: unknown): value is SecureRpsPickV4 {
  return typeof value === "string" && RPS_PICKS.has(value);
}

function isGameKind(value: unknown): value is SecureGameKindV4 {
  return typeof value === "string" && GAME_KINDS.has(value);
}

function isContent(value: unknown): value is SecureApplicationContentV4 {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "member-profile":
      return hasExactKeys(value, ["type", "displayName"]) && isSecureDisplayNameV4(value.displayName);
    case "member-leave":
      return hasExactKeys(value, ["type"]);
    case "presence":
      if (!hasExactKeys(value, ["type", "status"], ["awayText"])) return false;
      if (value.status === "available") return value.awayText === undefined;
      return value.status === "away" && (value.awayText === undefined || isAwayText(value.awayText));
    case "chat":
      return hasExactKeys(value, ["type", "text"], ["style"]) &&
        isText(value.text, 8_000, { nonEmpty: true }) && [...(value.text as string)].length <= 2_000 &&
        (value.style === undefined || isStyle(value.style));
    case "typing":
      return hasExactKeys(value, ["type"]);
    case "drawing":
      return hasExactKeys(value, ["type", "color", "points"], ["strokeStart"]) &&
        isDrawColor(value.color) && isPoints(value.points) &&
        (value.strokeStart === undefined || value.strokeStart === true);
    case "theme":
      return hasExactKeys(value, ["type", "theme"]) && typeof value.theme === "string" && THEMES.has(value.theme);
    case "pillow-toss":
      return hasExactKeys(value, ["type", "targetDeviceId"]) && isDeviceId(value.targetDeviceId);
    case "host-transfer":
      if (value.action === "offer") return hasExactKeys(value, ["type", "action", "targetDeviceId"]) && isDeviceId(value.targetDeviceId);
      if (value.action === "accept") {
        return hasExactKeys(value, ["type", "action", "authorizationId"]) && isEventId(value.authorizationId);
      }
      return value.action === "reject" && hasExactKeys(value, ["type", "action"]);
    case "room-close":
      return hasExactKeys(value, ["type", "reason"]) && isReason(value.reason);
    case "queue":
      if (value.action === "cancel") return hasExactKeys(value, ["type", "action", "requestId"]) && isEventId(value.requestId);
      if (value.action !== "enqueue" || !hasExactKeys(value, ["type", "action", "requestId", "game"], ["targetDeviceId"]) ||
          !isEventId(value.requestId) || !isGameKind(value.game)) return false;
      if (value.game === "vote" || value.game === "rps" || value.game === "ttt") return isDeviceId(value.targetDeviceId);
      return value.targetDeviceId === undefined;
    case "vote":
      if (value.action === "start") return hasExactKeys(value, ["type", "action", "gameId", "targetDeviceId"]) && isGameId(value.gameId) && isDeviceId(value.targetDeviceId);
      if (value.action === "cast") return hasExactKeys(value, ["type", "action", "gameId", "choice"]) && isGameId(value.gameId) && isChoice(value.choice);
      return (value.action === "close" || value.action === "cancel") && hasExactKeys(value, ["type", "action", "gameId"]) && isGameId(value.gameId);
    case "rps":
      if (value.action === "challenge") return hasExactKeys(value, ["type", "action", "gameId", "targetDeviceId"]) && isGameId(value.gameId) && isDeviceId(value.targetDeviceId);
      if (value.action === "accept" || value.action === "decline" || value.action === "cancel" || value.action === "forfeit") return hasExactKeys(value, ["type", "action", "gameId"]) && isGameId(value.gameId);
      if (value.action === "commit") return hasExactKeys(value, ["type", "action", "gameId", "commitment"]) && isGameId(value.gameId) && isCommitment(value.commitment);
      return value.action === "reveal" && hasExactKeys(value, ["type", "action", "gameId", "pick", "nonce"]) && isGameId(value.gameId) && isPick(value.pick) && isNonce(value.nonce);
    case "ttt":
      if (value.action === "challenge") return hasExactKeys(value, ["type", "action", "gameId", "targetDeviceId"]) && isGameId(value.gameId) && isDeviceId(value.targetDeviceId);
      if (value.action === "accept" || value.action === "decline" || value.action === "cancel" || value.action === "forfeit") return hasExactKeys(value, ["type", "action", "gameId"]) && isGameId(value.gameId);
      return value.action === "move" && hasExactKeys(value, ["type", "action", "gameId", "cell"]) && isGameId(value.gameId) && Number.isInteger(value.cell) && (value.cell as number) >= 0 && (value.cell as number) <= 8;
    case "saboteur":
      if (value.action === "start") return hasExactKeys(value, ["type", "action", "gameId"]) && isGameId(value.gameId);
      if (value.action === "entropy-commit") return hasExactKeys(value, ["type", "action", "gameId", "commitment"]) && isGameId(value.gameId) && isCommitment(value.commitment);
      if (value.action === "entropy-reveal") return hasExactKeys(value, ["type", "action", "gameId", "nonce"]) && isGameId(value.gameId) && isNonce(value.nonce);
      if (value.action === "accuse") return hasExactKeys(value, ["type", "action", "gameId", "suspectDeviceId"]) && isGameId(value.gameId) && isDeviceId(value.suspectDeviceId);
      if (value.action === "vote") return hasExactKeys(value, ["type", "action", "gameId", "choice"]) && isGameId(value.gameId) && isChoice(value.choice);
      return (value.action === "strike" || value.action === "close" || value.action === "resolve-vote") &&
        hasExactKeys(value, ["type", "action", "gameId"]) && isGameId(value.gameId);
    case "koth":
      return value.action === "challenge" && hasExactKeys(value, ["type", "action", "gameId"]) && isGameId(value.gameId);
    case "state-snapshot":
      return hasExactKeys(value, ["type", "state"]) && isSecureRoomStateSnapshotV4(value.state);
    default:
      return false;
  }
}

function isDeviceChoice(value: unknown): value is { deviceId: string; choice: SecureVoteChoiceV4 } {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "choice"]) && isDeviceId(value.deviceId) && isChoice(value.choice);
}

function isCommitRecord(value: unknown): value is { deviceId: string; commitment: string } {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "commitment"]) && isDeviceId(value.deviceId) && isCommitment(value.commitment);
}

function isRpsReveal(value: unknown): value is { deviceId: string; pick: SecureRpsPickV4; nonce: string } {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "pick", "nonce"]) && isDeviceId(value.deviceId) && isPick(value.pick) && isNonce(value.nonce);
}

function isSabReveal(value: unknown): value is { deviceId: string; nonce: string } {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "nonce"]) && isDeviceId(value.deviceId) && isNonce(value.nonce);
}

function hasUniqueDeviceIds(values: readonly { deviceId: string }[]): boolean {
  return new Set(values.map((value) => value.deviceId)).size === values.length;
}

function isSnapshotMember(value: unknown): value is SecureSnapshotMemberV4 {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "displayName", "status", "awayText", "lastSequence"]) &&
    isDeviceId(value.deviceId) && isSecureDisplayNameV4(value.displayName) &&
    (value.status === "available" || value.status === "away") &&
    ((value.status === "available" && value.awayText === null) || (value.status === "away" && (value.awayText === null || isAwayText(value.awayText)))) &&
    isSafeCounter(value.lastSequence, true);
}

function isMembershipAdmissionBinding(value: unknown): value is SecureMembershipAdmissionBindingV4 {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "admissionId"]) &&
    isDeviceId(value.deviceId) &&
    (value.admissionId === null || isEventId(value.admissionId));
}

function isSnapshotChat(value: unknown): value is SecureSnapshotChatV4 {
  return isPlainRecord(value) && hasExactKeys(value, ["eventId", "deviceId", "displayName", "text", "style"]) &&
    isEventId(value.eventId) && isDeviceId(value.deviceId) && isSecureDisplayNameV4(value.displayName) &&
    isText(value.text, 8_000, { nonEmpty: true }) && [...(value.text as string)].length <= 2_000 &&
    (value.style === null || isStyle(value.style));
}

function isSnapshotDrawing(value: unknown): value is SecureSnapshotDrawingV4 {
  return isPlainRecord(value) && hasExactKeys(value, ["eventId", "deviceId", "displayName", "color", "points", "strokeStart"]) &&
    isEventId(value.eventId) && isDeviceId(value.deviceId) && isSecureDisplayNameV4(value.displayName) &&
    isDrawColor(value.color) && isPoints(value.points) && typeof value.strokeStart === "boolean";
}

function isSnapshotQueue(value: unknown): value is SecureSnapshotQueueItemV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["requestId", "game", "byDeviceId", "targetDeviceId"]) ||
      !isEventId(value.requestId) || !isGameKind(value.game) || !isDeviceId(value.byDeviceId)) return false;
  if (value.game === "vote" || value.game === "rps" || value.game === "ttt") return isDeviceId(value.targetDeviceId);
  return value.targetDeviceId === null;
}

function isSnapshotVote(value: unknown): value is SecureSnapshotVoteV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["gameId", "starterDeviceId", "targetDeviceId", "votes"]) ||
      !isGameId(value.gameId) || !isDeviceId(value.starterDeviceId) || !isDeviceId(value.targetDeviceId) ||
      !isStrictArray(value.votes, MAX_SECURE_MEMBERS) || !value.votes.every(isDeviceChoice)) return false;
  return hasUniqueDeviceIds(value.votes) &&
    !value.votes.some((vote) => vote.deviceId === value.targetDeviceId) &&
    value.votes.some((vote) => vote.deviceId === value.starterDeviceId && vote.choice === "yes");
}

function isSnapshotRps(value: unknown): value is SecureSnapshotRpsV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["gameId", "p1DeviceId", "p2DeviceId", "phase", "koth", "commitments", "reveals"]) ||
      !isGameId(value.gameId) || !isDeviceId(value.p1DeviceId) || !isDeviceId(value.p2DeviceId) || value.p1DeviceId === value.p2DeviceId ||
      (value.phase !== "pending" && value.phase !== "committing" && value.phase !== "revealing") || typeof value.koth !== "boolean" ||
      !isStrictArray(value.commitments, 2) || !value.commitments.every(isCommitRecord) || !hasUniqueDeviceIds(value.commitments) ||
      !isStrictArray(value.reveals, 2) || !value.reveals.every(isRpsReveal) || !hasUniqueDeviceIds(value.reveals)) return false;
  const players = new Set([value.p1DeviceId, value.p2DeviceId]);
  if (!value.commitments.every((entry) => players.has(entry.deviceId)) || !value.reveals.every((entry) => players.has(entry.deviceId))) return false;
  if (value.phase === "pending") return value.koth === false && value.commitments.length === 0 && value.reveals.length === 0;
  if (value.phase === "committing") return value.commitments.length < 2 && value.reveals.length === 0;
  // The reducer resolves and removes the game as soon as the second reveal is
  // applied, so a durable revealing state can contain at most one reveal.
  return value.commitments.length === 2 && value.reveals.length < 2;
}

function isSnapshotTtt(value: unknown): value is SecureSnapshotTttV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["gameId", "p1DeviceId", "p2DeviceId", "phase", "board", "turn"]) ||
      !isGameId(value.gameId) || !isDeviceId(value.p1DeviceId) || !isDeviceId(value.p2DeviceId) || value.p1DeviceId === value.p2DeviceId ||
      (value.phase !== "pending" && value.phase !== "playing") || !isStrictArray(value.board, 9, 9) ||
      !value.board.every((cell) => cell === "" || cell === "X" || cell === "O") || !isSafeCounter(value.turn, true) || (value.turn as number) > 9) return false;
  return value.board.filter((cell) => cell !== "").length === value.turn &&
    (value.phase !== "pending" || value.turn === 0);
}

function isSnapshotSaboteur(value: unknown): value is SecureSnapshotSaboteurV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["gameId", "starterDeviceId", "phase", "participantDeviceIds", "commitments", "reveals", "saboteurDeviceId", "accusation", "strikes", "canStrike"]) ||
      !isGameId(value.gameId) || !isDeviceId(value.starterDeviceId) ||
      (value.phase !== "committing" && value.phase !== "revealing" && value.phase !== "playing") ||
      !isStrictArray(value.participantDeviceIds, MAX_SECURE_MEMBERS) || value.participantDeviceIds.length < 4 ||
      !value.participantDeviceIds.every(isDeviceId) || new Set(value.participantDeviceIds).size !== value.participantDeviceIds.length ||
      !isStrictArray(value.commitments, MAX_SECURE_MEMBERS) || !value.commitments.every(isCommitRecord) || !hasUniqueDeviceIds(value.commitments) ||
      !isStrictArray(value.reveals, MAX_SECURE_MEMBERS) || !value.reveals.every(isSabReveal) || !hasUniqueDeviceIds(value.reveals) ||
      !(value.saboteurDeviceId === null || isDeviceId(value.saboteurDeviceId)) ||
      !Number.isInteger(value.strikes) || (value.strikes as number) < 0 || (value.strikes as number) > 3 || typeof value.canStrike !== "boolean") return false;
  const participants = new Set(value.participantDeviceIds);
  if (!participants.has(value.starterDeviceId) || (value.saboteurDeviceId !== null && !participants.has(value.saboteurDeviceId))) return false;
  if (!value.commitments.every((entry) => participants.has(entry.deviceId)) || !value.reveals.every((entry) => participants.has(entry.deviceId))) return false;
  if (value.phase === "committing" && (value.commitments.length >= value.participantDeviceIds.length ||
      value.reveals.length !== 0 || value.saboteurDeviceId !== null || value.accusation !== null ||
      value.strikes !== 0 || value.canStrike)) return false;
  if (value.phase === "revealing" && (value.commitments.length !== value.participantDeviceIds.length ||
      value.reveals.length >= value.participantDeviceIds.length || value.saboteurDeviceId !== null ||
      value.accusation !== null || value.strikes !== 0 || value.canStrike)) return false;
  if (value.phase === "playing" && (value.commitments.length !== value.participantDeviceIds.length ||
      value.reveals.length !== value.participantDeviceIds.length || value.saboteurDeviceId === null ||
      (value.strikes as number) >= 3)) return false;
  if (value.accusation === null) return true;
  return value.phase === "playing" && value.canStrike === false && isPlainRecord(value.accusation) && hasExactKeys(value.accusation, ["accuserDeviceId", "suspectDeviceId", "votes"]) &&
    isDeviceId(value.accusation.accuserDeviceId) && isDeviceId(value.accusation.suspectDeviceId) &&
    participants.has(value.accusation.accuserDeviceId) && participants.has(value.accusation.suspectDeviceId) &&
    value.accusation.accuserDeviceId !== value.accusation.suspectDeviceId &&
    value.accusation.accuserDeviceId !== value.saboteurDeviceId &&
    isStrictArray(value.accusation.votes, MAX_SECURE_MEMBERS) && value.accusation.votes.every(isDeviceChoice) &&
    value.accusation.votes.length < value.participantDeviceIds.length &&
    hasUniqueDeviceIds(value.accusation.votes) && value.accusation.votes.every((entry) => participants.has(entry.deviceId));
}

function isSnapshotLeaderboard(value: unknown): value is SecureSnapshotLeaderboardV4 {
  return isPlainRecord(value) && hasExactKeys(value, ["deviceId", "pillowFight", "rps", "ttt", "saboteur", "koth"]) &&
    isDeviceId(value.deviceId) && isSafeCounter(value.pillowFight, true) && isSafeCounter(value.rps, true) &&
    isSafeCounter(value.ttt, true) && isSafeCounter(value.saboteur, true) && isSafeCounter(value.koth, true);
}

function isSecureRoomStateSnapshotUncheckedV4(value: unknown): value is SecureRoomStateSnapshotV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "v", "roomInstance", "logicalOrder", "revision", "hostDeviceId", "pendingHostDeviceId", "pendingRemovalDeviceIds", "membershipAdmissionBindings", "theme", "closedReason",
    "members", "messages", "drawings", "queue", "vote", "rps", "ttt", "saboteur", "leaderboards", "seenEventIds",
  ])) return false;
  if (value.v !== SECURE_ROOM_PROTOCOL_VERSION || !isFixedBase64Url(value.roomInstance, SECURE_ROOM_ID_BYTES) ||
      !isSafeCounter(value.logicalOrder, true) || !isSafeCounter(value.revision, true) || (value.revision as number) < (value.logicalOrder as number) ||
      !(value.hostDeviceId === null || isDeviceId(value.hostDeviceId)) ||
      !(value.pendingHostDeviceId === null || isDeviceId(value.pendingHostDeviceId)) ||
      !isStrictArray(value.pendingRemovalDeviceIds, MAX_SECURE_MEMBERS) ||
      !value.pendingRemovalDeviceIds.every(isDeviceId) ||
      new Set(value.pendingRemovalDeviceIds).size !== value.pendingRemovalDeviceIds.length ||
      !isStrictArray(value.membershipAdmissionBindings, MAX_SECURE_MEMBERS) ||
      !value.membershipAdmissionBindings.every(isMembershipAdmissionBinding) ||
      !hasUniqueDeviceIds(value.membershipAdmissionBindings) ||
      typeof value.theme !== "string" || !THEMES.has(value.theme) ||
      !(value.closedReason === null || isReason(value.closedReason)) ||
      !isStrictArray(value.members, MAX_SECURE_MEMBERS) || !value.members.every(isSnapshotMember) || !hasUniqueDeviceIds(value.members) ||
      new Set(value.members.map((member) => member.displayName.toLowerCase())).size !== value.members.length ||
      // Protocol v4 deliberately carries no chat or drawing history in a
      // durable/application bootstrap snapshot. Those events are live-only.
      !isStrictArray(value.messages, 0) ||
      !isStrictArray(value.drawings, 0) ||
      !isStrictArray(value.queue, MAX_SECURE_GAME_QUEUE) || !value.queue.every(isSnapshotQueue) ||
      !(value.vote === null || isSnapshotVote(value.vote)) || !(value.rps === null || isSnapshotRps(value.rps)) ||
      !(value.ttt === null || isSnapshotTtt(value.ttt)) || !(value.saboteur === null || isSnapshotSaboteur(value.saboteur)) ||
      !isStrictArray(value.leaderboards, MAX_SECURE_MEMBERS) || !value.leaderboards.every(isSnapshotLeaderboard) || !hasUniqueDeviceIds(value.leaderboards) ||
      !isStrictArray(value.seenEventIds, MAX_SECURE_SEEN_EVENT_IDS) || !value.seenEventIds.every(isEventId) ||
      new Set(value.seenEventIds).size !== value.seenEventIds.length) return false;
  const state = value as unknown as SecureRoomStateSnapshotV4;
  const memberIds = new Set(state.members.map((member) => member.deviceId));
  const bindingIds = new Set(state.membershipAdmissionBindings.map((binding) => binding.deviceId));
  if (!state.membershipAdmissionBindings.every((binding, index) => index === 0 ||
      state.membershipAdmissionBindings[index - 1].deviceId < binding.deviceId)) return false;
  if (state.members.some((member) => !bindingIds.has(member.deviceId))) return false;
  if (state.hostDeviceId !== null && !memberIds.has(state.hostDeviceId)) return false;
  if (state.pendingHostDeviceId !== null && !memberIds.has(state.pendingHostDeviceId)) return false;
  if (state.pendingRemovalDeviceIds.some((deviceId) => !memberIds.has(deviceId) || deviceId === state.hostDeviceId)) return false;
  const sortedPendingRemovals = [...state.pendingRemovalDeviceIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!state.pendingRemovalDeviceIds.every((deviceId, index) => deviceId === sortedPendingRemovals[index])) return false;
  if (state.pendingRemovalDeviceIds.length !== 0 && state.pendingHostDeviceId !== null) return false;
  const activeGames = [state.vote, state.rps, state.ttt, state.saboteur].filter((game) => game !== null);
  if (activeGames.length > 1 || (state.pendingHostDeviceId !== null && activeGames.length !== 0)) return false;
  if (state.members.some((member) => member.lastSequence > state.logicalOrder)) return false;
  if (!state.leaderboards.every((entry) => memberIds.has(entry.deviceId))) return false;

  const queueIds = new Set<string>();
  const activeGameId = state.vote?.gameId ?? state.rps?.gameId ?? state.ttt?.gameId ?? state.saboteur?.gameId ?? null;
  for (const entry of state.queue) {
    if (!memberIds.has(entry.byDeviceId) || (entry.targetDeviceId !== null && !memberIds.has(entry.targetDeviceId)) ||
        state.pendingRemovalDeviceIds.includes(entry.byDeviceId) ||
        (entry.targetDeviceId !== null && state.pendingRemovalDeviceIds.includes(entry.targetDeviceId)) ||
        entry.targetDeviceId === entry.byDeviceId || queueIds.has(entry.requestId) || entry.requestId === activeGameId ||
        (entry.game === "vote" && entry.targetDeviceId === state.hostDeviceId)) return false;
    queueIds.add(entry.requestId);
  }

  if (state.vote) {
    const eligible = state.members.length - 1;
    if (state.members.length < 3 || state.vote.starterDeviceId === state.vote.targetDeviceId ||
        state.vote.targetDeviceId === state.hostDeviceId || state.vote.votes.length >= eligible) return false;
  }
  if (state.rps?.koth && (state.hostDeviceId === null || state.rps.p2DeviceId !== state.hostDeviceId ||
      state.rps.p1DeviceId === state.hostDeviceId)) return false;
  if (state.ttt) {
    const x = state.ttt.board.filter((cell) => cell === "X").length;
    const o = state.ttt.board.filter((cell) => cell === "O").length;
    const xWon = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
      .some((line) => line.every((cell) => state.ttt!.board[cell] === "X"));
    const oWon = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
      .some((line) => line.every((cell) => state.ttt!.board[cell] === "O"));
    if (x !== Math.ceil(state.ttt.turn / 2) || o !== Math.floor(state.ttt.turn / 2) || xWon || oWon) return false;
  }
  if (state.saboteur) {
    const sorted = [...state.saboteur.participantDeviceIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (!state.saboteur.participantDeviceIds.every((deviceId, index) => deviceId === sorted[index])) return false;
  }
  return true;
}

export function isSecureRoomStateSnapshotV4(value: unknown): value is SecureRoomStateSnapshotV4 {
  try {
    return isSecureRoomStateSnapshotUncheckedV4(value);
  } catch {
    return false;
  }
}

function isUnsignedEventShape(value: unknown): value is SecureUnsignedApplicationEventV4 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["v", "roomInstance", "eventId", "deviceId", "deviceSequence", "logicalOrder", "content"])) return false;
  return value.v === SECURE_ROOM_PROTOCOL_VERSION &&
    isFixedBase64Url(value.roomInstance, SECURE_ROOM_ID_BYTES) && isEventId(value.eventId) && isDeviceId(value.deviceId) &&
    isSafeCounter(value.deviceSequence) && isSafeCounter(value.logicalOrder) && isContent(value.content);
}

export function isSecureUnsignedApplicationEventV4(
  value: unknown,
  options: SecureApplicationEventValidationOptionsV4 = {},
): value is SecureUnsignedApplicationEventV4 {
  try {
    if (!isUnsignedEventShape(value)) return false;
    if (options.expectedRoomInstance !== undefined && value.roomInstance !== options.expectedRoomInstance) return false;
    return UTF8.encode(canonicalJsonV4(value)).byteLength + UTF8.encode(SIGNING_DOMAIN).byteLength <= MAX_SECURE_APPLICATION_EVENT_BYTES;
  } catch {
    return false;
  }
}

export function isSecureApplicationEventV4(
  value: unknown,
  options: SecureApplicationEventValidationOptionsV4 = {},
): value is SecureApplicationEventV4 {
  try {
    if (!isPlainRecord(value) || !hasExactKeys(value, ["v", "roomInstance", "eventId", "deviceId", "deviceSequence", "logicalOrder", "content", "signature"]) ||
        !isFixedBase64Url(value.signature, SECURE_APPLICATION_EVENT_SIGNATURE_BYTES)) return false;
    const unsigned = {
      v: value.v,
      roomInstance: value.roomInstance,
      eventId: value.eventId,
      deviceId: value.deviceId,
      deviceSequence: value.deviceSequence,
      logicalOrder: value.logicalOrder,
      content: value.content,
    };
    return isSecureUnsignedApplicationEventV4(unsigned, options);
  } catch {
    return false;
  }
}

export function parseSecureApplicationEventV4(
  value: unknown,
  options: SecureApplicationEventValidationOptionsV4 = {},
): SecureApplicationEventV4 | null {
  if (!isSecureApplicationEventV4(value, options)) return null;
  // Return an owned deep canonical copy. Callers commonly await signature
  // verification before reducing; retaining attacker-owned nested references
  // across that await would create a mutation/TOCTOU boundary.
  return JSON.parse(canonicalJsonV4(value)) as SecureApplicationEventV4;
}

/** RFC 8785-style deterministic JSON for this protocol's bounded JSON subset. */
export function canonicalJsonV4(value: unknown): string {
  let nodes = 0;
  const encode = (input: unknown, depth: number): string => {
    if (++nodes > 8_192 || depth > 16) throw new TypeError("canonical JSON limit exceeded");
    if (input === null) return "null";
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isFinite(input) || Object.is(input, -0)) throw new TypeError("non-canonical number");
      return JSON.stringify(input);
    }
    if (typeof input === "string") {
      if (!hasValidUnicode(input) || input.normalize("NFC") !== input) throw new TypeError("non-canonical string");
      return JSON.stringify(input);
    }
    if (isStrictArray(input, 4_096)) return `[${input.map((entry) => encode(entry, depth + 1)).join(",")}]`;
    if (!isPlainRecord(input)) throw new TypeError("unsupported canonical JSON value");
    const keys = Object.keys(input).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(input[key], depth + 1)}`).join(",")}}`;
  };
  return encode(value, 0);
}

export function secureApplicationEventSigningBytesV4(value: unknown): Uint8Array | null {
  if (!isSecureUnsignedApplicationEventV4(value)) return null;
  return UTF8.encode(`${SIGNING_DOMAIN}${canonicalJsonV4(value)}`);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string, expectedBytes: number): Uint8Array | null {
  if (!isFixedBase64Url(value, expectedBytes)) return null;
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.byteLength === expectedBytes ? bytes : null;
  } catch {
    return null;
  }
}

export async function signSecureApplicationEventV4(
  unsignedEvent: SecureUnsignedApplicationEventV4,
  signer: SecureApplicationEventSignerV4,
): Promise<SecureApplicationEventV4> {
  if (!isSecureUnsignedApplicationEventV4(unsignedEvent) || typeof signer !== "function") {
    throw new TypeError("invalid secure application event or signer");
  }
  const ownedEvent = JSON.parse(canonicalJsonV4(unsignedEvent)) as SecureUnsignedApplicationEventV4;
  const bytes = secureApplicationEventSigningBytesV4(ownedEvent);
  if (!bytes || typeof signer !== "function") throw new TypeError("invalid secure application event or signer");
  const signerBytes = bytes.slice();
  let produced: Uint8Array | string | null = null;
  try {
    produced = await signer(signerBytes);
    const signature = typeof produced === "string"
      ? produced
      : produced instanceof Uint8Array ? encodeBase64Url(produced) : "";
    if (!isFixedBase64Url(signature, SECURE_APPLICATION_EVENT_SIGNATURE_BYTES)) {
      throw new TypeError("MLS credential signer returned an invalid Ed25519 signature");
    }
    return { ...ownedEvent, signature };
  } finally {
    bytes.fill(0);
    signerBytes.fill(0);
    if (produced instanceof Uint8Array) produced.fill(0);
  }
}

export async function verifySecureApplicationEventV4(
  event: unknown,
  publicKey: string | Uint8Array,
  options: SecureApplicationEventValidationOptionsV4 = {},
): Promise<boolean> {
  const ownedEvent = parseSecureApplicationEventV4(event, options);
  if (!ownedEvent) return false;
  const key = typeof publicKey === "string"
    ? decodeBase64Url(publicKey, SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES)
    : publicKey instanceof Uint8Array && publicKey.byteLength === SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES
      ? publicKey.slice()
      : null;
  const signature = decodeBase64Url(ownedEvent.signature, SECURE_APPLICATION_EVENT_SIGNATURE_BYTES);
  const bytes = secureApplicationEventSigningBytesV4({
    v: ownedEvent.v,
    roomInstance: ownedEvent.roomInstance,
    eventId: ownedEvent.eventId,
    deviceId: ownedEvent.deviceId,
    deviceSequence: ownedEvent.deviceSequence,
    logicalOrder: ownedEvent.logicalOrder,
    content: ownedEvent.content,
  });
  if (!key || !signature || !bytes) {
    key?.fill(0);
    signature?.fill(0);
    bytes?.fill(0);
    return false;
  }
  try {
    return await verifyAsync(signature, bytes, key, { zip215: false });
  } catch {
    return false;
  } finally {
    key.fill(0);
    signature.fill(0);
    bytes.fill(0);
  }
}

export function canonicalBase64UrlV4(bytes: Uint8Array): string {
  return encodeBase64Url(bytes);
}
