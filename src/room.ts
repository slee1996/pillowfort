import type { Env } from "./index";
import { firstDueRoomAlarm, nextRoomAlarmDeadline, normalizeRoomAlarmSchedule, type RoomAlarmKind, type RoomAlarmSchedule } from "./alarms";
import {
  FORT_PASS_RESERVATION_MS,
  constantTimeFortPassClaimHashEqual,
  fortPassAllowsCustomRoomCode,
  fortPassAllowsRoomTheme,
  fortPassClaimHash,
  fortPassIdleMs,
  isFortPassActive,
  isGeneratedFreeRoomId,
  normalizeCustomRoomCode,
  normalizeFortPassClaimHash,
  normalizeFortPassEntitlement,
  normalizeRoomId,
  normalizeRoomTheme,
  type FortPassEntitlement,
  type RoomTheme,
} from "./entitlements";
import { isRpsPick, rpsWinner, tttWinner, voteHasMajority, type RpsPick } from "./game";
import { ROOM_CREATE_LIMIT_PATH, ROOM_FORT_PASS_FULFILL_PATH, ROOM_FORT_PASS_RELEASE_PATH, ROOM_FORT_PASS_RESERVATION_PATH, ROOM_FORT_PASS_RESERVE_PATH, ROOM_FORT_PASS_REVOKE_PATH, ROOM_STATUS_PATH, ROOM_STRIPE_SESSION_LEDGER_PATH, ROOM_WS_OPEN_LIMIT_PATH } from "./routes";
import { readByteLimitedText } from "./requestBody";
import { hasOnlyAllowedSearchParameters, isJsonRequest } from "./httpBoundary";
import { sanitizeDraw, uniqueName, MAX_DRAW_EVENTS_PER_5S, GRACE_MS } from "./shared";
import {
  createRoomAuthChallenge,
  MAX_AUTH_FAILURES_PER_MINUTE,
  MAX_WEBSOCKET_FRAME_BYTES,
  ROOM_AUTH_CHALLENGE_TTL_MS,
  normalizeAuthName,
  toBase64Url,
  verifyRoomAuthProof,
  type RoomAuthAction,
  type RoomAuthPayloadV2,
} from "./roomAuth";
import { verifySecureDeviceResumeProofV4 } from "./deviceAuthV4";
import { MAX_SECURE_WEBSOCKET_FRAME_BYTES } from "./protocolV4";
import { parseRoomInvitationAuthPayloadV4, verifyRoomInvitationAuthV4 } from "./roomInvitationAuthV4";
import {
  roomInvitationKeyPackageDigestV4,
  verifyRoomInvitationMemberBindingV4,
} from "./roomInvitationMemberBindingV4";
import {
  advanceSecureRelayV4,
  createSecureRelayStateV4,
  disconnectSecureRelayDeviceV4,
  generateSecureRelayIdV4,
  getSecureRelayDeviceSignatureKeyV4,
  nextSecureRelayDeadlineV4,
  reduceSecureRelayV4,
  type SecureClientFrameV4,
  type SecureRelayActorV4,
  type SecureRelayEffectV4,
  type SecureRelayStateV4,
} from "./secureRelayV4";
import {
  parseSecureAuthChallengeFrameV4,
  parseSecureAuthenticateFrameV4,
  parseSecurePostAuthClientFrameV4,
  type SecureAuthenticateFrameV4,
  type SecureAuthChallengeFrameV4,
  type SecureServerErrorCodeV4,
  type SecureServerFrameV4,
} from "./secureTransportV4";
import {
  SECURE_RELAY_MANIFEST_KEY_V4,
  parseSecureRelayPersistenceManifestV4,
  prepareSecureRelayPersistenceV4,
  restoreSecureRelayPersistenceV4,
  secureRelayChunkKeyV4,
  type SecureRelayPersistenceManifestV4,
} from "./secureRelayPersistenceV4";

interface WSData {
  name: string;
  hash: string;
  isHost: boolean;
  hostRejected: boolean;
  status: "available" | "away";
  awayText: string | null;
  msgTimestamps: number[];
  drawTimestamps?: number[];
  ip?: string;
  creationSource?: string;
  authChallenge?: string;
  authChallengeExpiresAt?: number;
  authAttempted?: boolean;
  preAuthFrames?: number;
  secureConnectionId?: string;
  secureDeviceId?: string;
  secureAuthenticated?: boolean;
  secureAuthentication?: "invitation" | "device";
  secureChallenge?: string;
  secureChallengeExpiresAt?: number;
  protocol?: "legacy" | "v4";
  secureOperationTimestamps?: number[];
}

interface FortPassReservationV2 {
  v: 2;
  expiresAt: number;
  token: string;
  sessionId: string | null;
  claimHash: string;
}
const FORT_PASS_RESERVATION_KEY = "fortPassReservation";
const CHECKOUT_RATE_LIMIT_LEASE_KEY = "checkoutRateLimitLease";
const CREATE_LIMIT_KEY = "roomCreationTimestamps";
const RATE_ROOMS_PER_MIN = 5;
const WS_OPEN_LIMIT_KEY = "webSocketOpenTimestamps";
const RATE_WS_OPENS_PER_MIN = 60;

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_MSGS_PER_5S = 10;
const VOTE_DURATION_MS = 30_000;
const CHALLENGE_TIMEOUT_MS = 30_000;
const GAME_PLAY_TIMEOUT_MS = 60_000;
const MAX_GAME_QUEUE = 10;
const SABOTEUR_VOTE_MS = 30_000;
const SABOTEUR_MIN_PLAYERS = 4;
const SAB_BOMB_MS = 10_000;
const SAB_BOMB_SECONDS = Math.max(1, Math.ceil(SAB_BOMB_MS / 1000));
const MAX_ENC_B64_LEN = 4096;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
const ALARM_SCHEDULE_KEY = "alarmSchedule";
const SAB_BOMB_KEY = "sabBomb";
const FORT_PASS_ENTITLEMENT_KEY = "fortPassEntitlement";
const FORT_PASS_REDEMPTION_KEY = "fortPassRedemption";
const ROOM_THEME_KEY = "roomTheme";
const LEGACY_AUTH_BLOCKED_KEY = "legacyAuthBlocked";
const AUTH_FAILURE_BUCKETS_KEY = "authFailureBuckets";
const MAX_AUTH_FAILURE_BUCKETS = 256;
// Bound challenge-only sockets independently of the authenticated member cap.
// Without this, an attacker can hold an unbounded number of hibernated sockets
// open for the full challenge TTL and exhaust a single room before proving any
// knowledge of its invitation secret.
const MAX_UNAUTHENTICATED_SOCKETS_PER_ROOM = 64;
const MAX_SECURE_SOCKET_FRAMES_PER_5S = 100;
const MAX_SECURE_OPERATIONS_PER_5S = 30;
// MLS delivery and admission fan out bounded ACK/control traffic across the
// roster. This aggregate cap admits that protocol amplification without
// allowing the sum of all 20 per-socket budgets through unchecked.
const MAX_SECURE_ROOM_FRAMES_PER_5S = 256;
const STRIPE_SESSION_LEDGER_KEY = "stripeSessionLedger";
const STRIPE_SESSION_LEASE_MS = 5 * 60 * 1000;
const STRIPE_SESSION_TOKEN_RE = /^[a-f0-9]{64}$/u;
const STRIPE_CHECKOUT_SESSION_ID_RE = /^cs_(?:test_|live_)?[A-Za-z0-9_]{3,255}$/u;

type FortPassReservationAction =
  | { action: "claim"; token: string; claimHash: string }
  | { action: "supersede"; token: string; claimHash: string; priorSessionId: string }
  | { action: "bind"; token: string; sessionId: string }
  | { action: "release"; token: string };

interface FortPassRevocationAction {
  sessionId: string;
  reason: "refund" | "dispute";
}

interface FortPassRedemptionRecord {
  v: 3;
  roomId: string;
  provider: FortPassEntitlement["provider"];
  providerRefHash: string;
  createdAt: number;
  claimHash: string | null;
  revokedAt: number | null;
  revocationReason: "refund" | "dispute" | null;
}

interface FortPassPreGrantRevocation {
  v: 1;
  providerRefHash: string;
  revokedAt: number;
  reason: "refund" | "dispute";
}

const FORT_PASS_PREGRANT_REVOCATION_KEY = "fortPassPreGrantRevocation";

type StripeSessionLedgerRecord =
  | { v: 1; status: "pending"; roomId: string; token: string; leaseExpiresAt: number }
  | { v: 1; status: "complete"; roomId: string; completedAt: number };

type StripeSessionLedgerAction = {
  action: "claim" | "complete" | "release";
  roomId: string;
  token: string;
};

function isExactPlainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      && actual.every((key) => typeof key === "string" && keys.includes(key));
  } catch {
    return false;
  }
}

function parseStripeSessionLedgerAction(value: unknown): StripeSessionLedgerAction | null {
  if (!isExactPlainRecord(value, ["action", "roomId", "token"])
    || (value.action !== "claim" && value.action !== "complete" && value.action !== "release")
    || typeof value.roomId !== "string" || normalizeCustomRoomCode(value.roomId) !== value.roomId
    || typeof value.token !== "string" || !STRIPE_SESSION_TOKEN_RE.test(value.token)) return null;
  return { action: value.action, roomId: value.roomId, token: value.token };
}

function parseFortPassReservationAction(value: unknown): FortPassReservationAction | null {
  if (isExactPlainRecord(value, ["action", "token", "claimHash"])
    && value.action === "claim"
    && typeof value.token === "string" && STRIPE_SESSION_TOKEN_RE.test(value.token)) {
    const claimHash = normalizeFortPassClaimHash(value.claimHash);
    return claimHash ? { action: "claim", token: value.token, claimHash } : null;
  }
  if (isExactPlainRecord(value, ["action", "token"])
    && value.action === "release"
    && typeof value.token === "string" && STRIPE_SESSION_TOKEN_RE.test(value.token)) {
    return { action: "release", token: value.token };
  }
  if (isExactPlainRecord(value, ["action", "token", "claimHash", "priorSessionId"])
    && value.action === "supersede"
    && typeof value.token === "string" && STRIPE_SESSION_TOKEN_RE.test(value.token)
    && typeof value.priorSessionId === "string"
    && STRIPE_CHECKOUT_SESSION_ID_RE.test(value.priorSessionId)) {
    const claimHash = normalizeFortPassClaimHash(value.claimHash);
    return claimHash
      ? { action: "supersede", token: value.token, claimHash, priorSessionId: value.priorSessionId }
      : null;
  }
  if (isExactPlainRecord(value, ["action", "token", "sessionId"])
    && value.action === "bind"
    && typeof value.token === "string" && STRIPE_SESSION_TOKEN_RE.test(value.token)
    && typeof value.sessionId === "string" && STRIPE_CHECKOUT_SESSION_ID_RE.test(value.sessionId)) {
    return { action: "bind", token: value.token, sessionId: value.sessionId };
  }
  return null;
}

function parseFortPassReservation(value: unknown): FortPassReservationV2 | null {
  if (!isExactPlainRecord(value, ["v", "expiresAt", "token", "sessionId", "claimHash"])
    || value.v !== 2
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
    || typeof value.token !== "string" || !STRIPE_SESSION_TOKEN_RE.test(value.token)
    || !normalizeFortPassClaimHash(value.claimHash)
    || !(value.sessionId === null || (typeof value.sessionId === "string"
      && STRIPE_CHECKOUT_SESSION_ID_RE.test(value.sessionId)))) return null;
  return {
    v: 2,
    expiresAt: value.expiresAt,
    token: value.token,
    sessionId: value.sessionId,
    claimHash: value.claimHash as string,
  };
}

function parseFortPassRevocationAction(value: unknown): FortPassRevocationAction | null {
  if (!isExactPlainRecord(value, ["sessionId", "reason"])
    || typeof value.sessionId !== "string" || !STRIPE_CHECKOUT_SESSION_ID_RE.test(value.sessionId)
    || (value.reason !== "refund" && value.reason !== "dispute")) return null;
  return { sessionId: value.sessionId, reason: value.reason };
}

function parseStripeSessionLedgerRecord(value: unknown): StripeSessionLedgerRecord | null {
  if (isExactPlainRecord(value, ["v", "status", "roomId", "token", "leaseExpiresAt"])
    && value.v === 1 && value.status === "pending"
    && typeof value.roomId === "string" && normalizeCustomRoomCode(value.roomId) === value.roomId
    && typeof value.token === "string" && STRIPE_SESSION_TOKEN_RE.test(value.token)
    && typeof value.leaseExpiresAt === "number" && Number.isSafeInteger(value.leaseExpiresAt)
    && value.leaseExpiresAt >= 0) {
    return { v: 1, status: "pending", roomId: value.roomId, token: value.token, leaseExpiresAt: value.leaseExpiresAt };
  }
  if (isExactPlainRecord(value, ["v", "status", "roomId", "completedAt"])
    && value.v === 1 && value.status === "complete"
    && typeof value.roomId === "string" && normalizeCustomRoomCode(value.roomId) === value.roomId
    && typeof value.completedAt === "number" && Number.isSafeInteger(value.completedAt)
    && value.completedAt >= 0) {
    return { v: 1, status: "complete", roomId: value.roomId, completedAt: value.completedAt };
  }
  return null;
}

async function fortPassProviderRefHash(
  provider: FortPassEntitlement["provider"],
  providerRef: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `pillowfort:fort-pass-redemption:v1:${provider}:${providerRef}`,
    ),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fortPassRedemptionRecord(
  entitlement: FortPassEntitlement,
  claimHash: string,
): Promise<FortPassRedemptionRecord> {
  return {
    v: 3,
    roomId: entitlement.roomId,
    provider: entitlement.provider,
    providerRefHash: await fortPassProviderRefHash(entitlement.provider, entitlement.providerRef),
    createdAt: entitlement.createdAt,
    claimHash,
    revokedAt: null,
    revocationReason: null,
  };
}

function parseFortPassRedemptionRecord(value: unknown): FortPassRedemptionRecord | null {
  const legacy = isExactPlainRecord(value, ["v", "roomId", "provider", "providerRefHash", "createdAt"])
    && value.v === 1;
  const previous = isExactPlainRecord(value, [
    "v", "roomId", "provider", "providerRefHash", "createdAt", "revokedAt", "revocationReason",
  ]) && value.v === 2;
  const current = isExactPlainRecord(value, [
    "v", "roomId", "provider", "providerRefHash", "createdAt", "claimHash", "revokedAt", "revocationReason",
  ]) && value.v === 3;
  if ((!legacy && !previous && !current) || typeof value.roomId !== "string"
    || normalizeCustomRoomCode(value.roomId) !== value.roomId
    || (value.provider !== "stripe" && value.provider !== "manual")
    || typeof value.providerRefHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.providerRefHash)
    || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return null;
  const revokedAt = current || previous ? value.revokedAt : null;
  const revocationReason = current || previous ? value.revocationReason : null;
  const claimHash = current ? normalizeFortPassClaimHash(value.claimHash) : null;
  if (!(revokedAt === null || (typeof revokedAt === "number" && Number.isSafeInteger(revokedAt) && revokedAt >= 0))
    || !(revocationReason === null || revocationReason === "refund" || revocationReason === "dispute")
    || ((revokedAt === null) !== (revocationReason === null))
    || (current && ((revokedAt === null && claimHash === null)
      || (revokedAt !== null && value.claimHash !== null)))) return null;
  return {
    v: 3,
    roomId: value.roomId,
    provider: value.provider,
    providerRefHash: value.providerRefHash,
    createdAt: value.createdAt,
    claimHash,
    revokedAt,
    revocationReason,
  };
}

function parseFortPassPreGrantRevocation(value: unknown): FortPassPreGrantRevocation | null {
  if (!isExactPlainRecord(value, ["v", "providerRefHash", "revokedAt", "reason"])
    || value.v !== 1 || !normalizeFortPassClaimHash(value.providerRefHash)
    || typeof value.revokedAt !== "number" || !Number.isSafeInteger(value.revokedAt) || value.revokedAt < 0
    || (value.reason !== "refund" && value.reason !== "dispute")) return null;
  return {
    v: 1,
    providerRefHash: value.providerRefHash as string,
    revokedAt: value.revokedAt,
    reason: value.reason,
  };
}

async function fortPassSetupClaimMatches(
  storage: DurableObjectStorage,
  roomId: string,
  entitlement: FortPassEntitlement | null,
  sessionIdInput: unknown,
  claimSecretInput: unknown,
): Promise<boolean> {
  if (!entitlement || !isFortPassActive(entitlement)
    || entitlement.roomId !== roomId
    || entitlement.provider !== "stripe"
    || typeof sessionIdInput !== "string"
    || entitlement.providerRef !== sessionIdInput) return false;
  const claimHash = await fortPassClaimHash(claimSecretInput);
  if (!claimHash) return false;
  const [rawRedemption, rawPreGrantRevocation] = await Promise.all([
    storage.get<unknown>(FORT_PASS_REDEMPTION_KEY),
    storage.get<unknown>(FORT_PASS_PREGRANT_REVOCATION_KEY),
  ]);
  const redemption = rawRedemption === undefined ? null : parseFortPassRedemptionRecord(rawRedemption);
  const preGrantRevocation = rawPreGrantRevocation === undefined
    ? null
    : parseFortPassPreGrantRevocation(rawPreGrantRevocation);
  if (!redemption || (rawPreGrantRevocation !== undefined && !preGrantRevocation)
    || redemption.revokedAt !== null || redemption.claimHash === null
    || redemption.roomId !== roomId || redemption.provider !== entitlement.provider
    || redemption.createdAt !== entitlement.createdAt
    || redemption.providerRefHash !== await fortPassProviderRefHash("stripe", sessionIdInput)
    || preGrantRevocation?.providerRefHash === redemption.providerRefHash) return false;
  return constantTimeFortPassClaimHashEqual(redemption.claimHash, claimHash);
}

interface SabBombState {
  saboteur: string;
  deadline: number;
  durationMs: number;
}

type AuthFailureBuckets = Record<string, number[]>;

interface EncryptedChatPayload {
  v: 3;
  kdf: string;
  sid: string;
  seq: number;
  iv: string;
  ct: string;
}

interface RoomLeaderboards {
  pillowFight: Record<string, number>;
  rps: Record<string, number>;
  ttt: Record<string, number>;
  saboteur: Record<string, number>;
  koth: Record<string, number>;
}

type QueueGameKind = "vote" | "rps" | "ttt" | "saboteur" | "koth";

interface GameQueueItem {
  kind: QueueGameKind;
  by: string;
  target?: string;
}

interface RoomGameQueue {
  current: GameQueueItem | null;
  queue: GameQueueItem[];
}

function createLeaderboards(): RoomLeaderboards {
  return {
    pillowFight: {},
    rps: {},
    ttt: {},
    saboteur: {},
    koth: {},
  };
}

function sanitizeEncryptedChat(enc: any): EncryptedChatPayload | null {
  if (!enc || enc.v !== 3) return null;
  if (enc.kdf !== "pbkdf2-sha256-600k-v1") return null;
  if (typeof enc.sid !== "string" || enc.sid.length < 16 || enc.sid.length > 64) return null;
  if (!Number.isSafeInteger(enc.seq) || enc.seq < 1) return null;
  if (typeof enc.iv !== "string" || typeof enc.ct !== "string") return null;
  if (!BASE64_RE.test(enc.iv) || !BASE64_RE.test(enc.ct)) return null;
  if (enc.iv.length < 16 || enc.iv.length > 32) return null;
  if (enc.ct.length < 16 || enc.ct.length > MAX_ENC_B64_LEN) return null;
  return { v: 3, kdf: enc.kdf, sid: enc.sid, seq: enc.seq, iv: enc.iv, ct: enc.ct };
}

function randomIndex(length: number): number {
  if (length <= 1) return 0;
  const bytes = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / length) * length;
  do crypto.getRandomValues(bytes);
  while (bytes[0] >= limit);
  return bytes[0] % length;
}

async function hashClientAddress(address: string, scope: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:source-pseudonym:v1:${scope}:${address}`),
  );
  return toBase64Url(new Uint8Array(digest).slice(0, 16));
}

export class Room implements DurableObject {
  private state: DurableObjectState;
  private authPublicKey: string | null = null;
  private secureRelayState: SecureRelayStateV4 | null = null;
  private secureRelayManifest: SecureRelayPersistenceManifestV4 | null = null;
  private secureRoomAuthPublicKey: string | null = null;
  private secureStateCorrupt = false;
  private legacyAuthBlocked = false;
  private setupInProgress = false;
  private authQueue: Promise<void> = Promise.resolve();
  private secureQueue: Promise<void> = Promise.resolve();
  private paymentQueue: Promise<void> = Promise.resolve();
  private secureRoomFrameTimestamps: number[] = [];
  private secureRoomFrameBudgetInitialized = false;
  private roomId: string = "";
  private tossPillowFrom: string | null = null;
  private disconnected: Map<string, {
    name: string;
    wasHost: boolean;
    status: "available" | "away";
    awayText: string | null;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  // --- game state ---
  private activeVote: { target: string; starter: string; yes: Set<string>; no: Set<string>; timer: ReturnType<typeof setTimeout>; endsAt: number; auto?: boolean } | null = null;
  private rpsGame: { p1: string; p2: string; phase: "pending" | "playing"; timer?: ReturnType<typeof setTimeout>; pick1?: RpsPick; pick2?: RpsPick; koth?: boolean } | null = null;
  private tttGame: { p1: string; p2: string; phase: "pending" | "playing"; timer?: ReturnType<typeof setTimeout>; board: string[]; turn: number } | null = null;
  private saboteur: string | null = null;
  private saboteurActive = false;
  private sabStrikes = 0;
  private sabVote: {
    accuser: string;
    suspect: string;
    yes: Set<string>;
    no: Set<string>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private sabCanStrike = false;
  private activeGame: GameQueueItem | null = null;
  private gameQueue: GameQueueItem[] = [];
  private leaderboards: RoomLeaderboards = createLeaderboards();
  private fortPassEntitlement: FortPassEntitlement | null = null;
  private roomTheme: RoomTheme = "away-message";

  constructor(state: DurableObjectState, private env: Env) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      this.authPublicKey = (await state.storage.get("authPublicKey")) as string || null;
      // Protocol v1 verifiers are password-equivalent bearers and cannot be
      // migrated to an Ed25519 public key. Replace them with a fail-closed
      // tombstone so an old room code cannot be claimed by a new party.
      this.legacyAuthBlocked = (await state.storage.get(LEGACY_AUTH_BLOCKED_KEY)) === true;
      if (await state.storage.get("authVerifier")) {
        await state.storage.delete("authVerifier");
        await state.storage.put(LEGACY_AUTH_BLOCKED_KEY, true);
        this.legacyAuthBlocked = true;
      }
      this.roomId = (await state.storage.get("roomId")) as string || "";
      this.fortPassEntitlement = normalizeFortPassEntitlement(await state.storage.get(FORT_PASS_ENTITLEMENT_KEY));
      this.roomTheme = normalizeRoomTheme(await state.storage.get(ROOM_THEME_KEY)) || "away-message";
      await this.restoreSecureRelayState();
      // Deployment of protocol v4 is a hard downgrade boundary. Any socket
      // hibernated from a legacy deployment is closed before it can deliver a
      // new event under the upgraded code.
      for (const socket of state.getWebSockets()) {
        if (this.att(socket).protocol !== "v4") {
          try { socket.close(1008, "protocol v4 required"); } catch {}
        }
      }
    });
  }

  private async restoreSecureRelayState(): Promise<void> {
    const rawManifest = await this.state.storage.get<unknown>(SECURE_RELAY_MANIFEST_KEY_V4);
    if (rawManifest === undefined) return;
    const manifest = parseSecureRelayPersistenceManifestV4(rawManifest);
    if (!manifest) {
      this.secureStateCorrupt = true;
      return;
    }
    const chunks = await Promise.all(Array.from(
      { length: manifest.chunkCount },
      (_, index) => this.state.storage.get<unknown>(secureRelayChunkKeyV4(manifest.generation, index)),
    ));
    const restored = await restoreSecureRelayPersistenceV4(manifest, chunks);
    if (!restored || (this.roomId && restored.manifest.roomId !== this.roomId)
      || (this.authPublicKey !== null || this.legacyAuthBlocked)) {
      this.secureStateCorrupt = true;
      return;
    }
    const bindingsValid = (await Promise.all(restored.state.members.map((member) =>
      verifyRoomInvitationMemberBindingV4({
        binding: member.memberBinding,
        invitationPublicKey: restored.manifest.roomAuthPublicKey,
        expected: {
          mode: member.joinedOrder === 1 ? "founder" : "admission",
          roomId: restored.manifest.roomId,
          roomInstance: restored.state.roomInstance,
          deviceId: member.deviceId,
          admissionId: member.memberBinding.admissionId,
          signaturePublicKey: member.signaturePublicKey!,
          keyPackageDigest: member.memberBinding.keyPackageDigest,
        },
      })
    ))).every(Boolean);
    if (!bindingsValid) {
      this.secureStateCorrupt = true;
      return;
    }
    this.roomId = restored.manifest.roomId;
    this.secureRelayManifest = restored.manifest;
    this.secureRoomAuthPublicKey = restored.manifest.roomAuthPublicKey;
    this.secureRelayState = restored.state;
    await this.syncSecureRelayAlarm(restored.state);
  }

  private async persistSecureRelayState(
    relayState: SecureRelayStateV4,
    roomAuthPublicKey: string,
    options: { touchIdle?: boolean } = {},
  ): Promise<void> {
    const previous = this.secureRelayManifest;
    if ((!previous && relayState.revision !== 1)
      || (previous && relayState.revision !== previous.stateRevision + 1)) {
      throw new Error("secure relay revision compare-and-swap failed");
    }
    const generation: 0 | 1 = previous?.generation === 0 ? 1 : 0;
    const prepared = await prepareSecureRelayPersistenceV4({
      roomId: this.roomId,
      roomAuthPublicKey,
      state: relayState,
      generation,
    });
    await this.state.storage.transaction(async (transaction) => {
      const currentRaw = await transaction.get<unknown>(SECURE_RELAY_MANIFEST_KEY_V4);
      const current = currentRaw === undefined ? null : parseSecureRelayPersistenceManifestV4(currentRaw);
      const [legacyKey, legacyBlocked, storedRoomId] = await Promise.all([
        transaction.get<unknown>("authPublicKey"),
        transaction.get<unknown>(LEGACY_AUTH_BLOCKED_KEY),
        transaction.get<unknown>("roomId"),
      ]);
      if ((!previous && currentRaw !== undefined)
        || (previous && (!current || current.generation !== previous.generation
          || current.stateRevision !== previous.stateRevision || current.sha256 !== previous.sha256))
        || legacyKey !== undefined || legacyBlocked === true
        || (storedRoomId !== undefined && storedRoomId !== this.roomId)) {
        throw new Error("secure relay persistence compare-and-swap failed");
      }
      for (let index = 0; index < prepared.chunks.length; index++) {
        await transaction.put(secureRelayChunkKeyV4(generation, index), prepared.chunks[index]);
      }
      await transaction.put(SECURE_RELAY_MANIFEST_KEY_V4, prepared.manifest);
      if (previous) {
        for (let index = 0; index < previous.chunkCount; index++) {
          await transaction.delete(secureRelayChunkKeyV4(previous.generation, index));
        }
      }
      const schedule = normalizeRoomAlarmSchedule(await transaction.get<RoomAlarmSchedule>(ALARM_SCHEDULE_KEY));
      const relayDeadline = nextSecureRelayDeadlineV4(relayState);
      if (relayDeadline === null) delete schedule["secure-relay"];
      else schedule["secure-relay"] = relayDeadline;
      if (options.touchIdle) {
        schedule.idle = Date.now() + fortPassIdleMs(this.fortPassEntitlement, IDLE_MS);
      }
      const nextDeadline = nextRoomAlarmDeadline(schedule);
      if (nextDeadline === null) {
        await transaction.delete(ALARM_SCHEDULE_KEY);
        await transaction.deleteAlarm();
      } else {
        await transaction.put(ALARM_SCHEDULE_KEY, schedule);
        await transaction.setAlarm(nextDeadline);
      }
    });
    this.secureRelayManifest = prepared.manifest;
    this.secureRoomAuthPublicKey = roomAuthPublicKey;
    this.secureRelayState = relayState;
    this.secureStateCorrupt = false;
  }

  private async schedulePreAuthSocketSweep(deadline: number): Promise<void> {
    await this.state.storage.transaction(async (transaction) => {
      const schedule = normalizeRoomAlarmSchedule(
        await transaction.get<RoomAlarmSchedule>(ALARM_SCHEDULE_KEY),
      );
      const current = schedule["auth-sockets"];
      if (typeof current === "number" && current <= deadline) return;
      schedule["auth-sockets"] = deadline;
      await transaction.put(ALARM_SCHEDULE_KEY, schedule);
      await transaction.setAlarm(nextRoomAlarmDeadline(schedule)!);
    });
  }

  private withSecureLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.secureQueue.then(operation, operation);
    this.secureQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private withPaymentLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.paymentQueue.then(operation, operation);
    this.paymentQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async verifySecureSocketProof(
    ws: WebSocket,
    verifier: (challenge: string) => Promise<boolean>,
  ): Promise<null | "authentication-expired" | "authentication-failed" | "rate-limited"> {
    const attachment = this.att(ws);
    if (attachment.authAttempted || !attachment.secureChallenge || !attachment.secureChallengeExpiresAt) {
      return "authentication-failed";
    }
    attachment.authAttempted = true;
    const challenge = attachment.secureChallenge;
    const expiresAt = attachment.secureChallengeExpiresAt;
    attachment.secureChallenge = undefined;
    attachment.secureChallengeExpiresAt = undefined;
    attachment.authChallenge = undefined;
    attachment.authChallengeExpiresAt = undefined;
    ws.serializeAttachment(attachment);

    return this.withAuthLock(async () => {
      const source = attachment.ip || "unknown";
      const now = Date.now();
      const buckets = await this.loadAuthFailureBuckets(now);
      const failures = buckets[source] || [];
      if (failures.length >= MAX_AUTH_FAILURES_PER_MINUTE
        || (!buckets[source] && Object.keys(buckets).length >= MAX_AUTH_FAILURE_BUCKETS)) {
        await this.persistAuthFailureBuckets(buckets);
        return "rate-limited";
      }
      if (now > expiresAt) {
        buckets[source] = [...failures, now].slice(-MAX_AUTH_FAILURES_PER_MINUTE);
        await this.persistAuthFailureBuckets(buckets);
        return "authentication-expired";
      }
      let ok = false;
      try { ok = await verifier(challenge); } catch {}
      if (ok) delete buckets[source];
      else buckets[source] = [...failures, now].slice(-MAX_AUTH_FAILURES_PER_MINUTE);
      await this.persistAuthFailureBuckets(buckets);
      return ok ? null : "authentication-failed";
    });
  }

  private consumeSecureAuthenticationChallenge(ws: WebSocket) {
    const attachment = this.att(ws);
    attachment.authAttempted = true;
    attachment.secureChallenge = undefined;
    attachment.secureChallengeExpiresAt = undefined;
    attachment.authChallenge = undefined;
    attachment.authChallengeExpiresAt = undefined;
    ws.serializeAttachment(attachment);
  }

  private pendingSecureAuthenticationCount(): number {
    return this.state.getWebSockets().reduce((count, socket) => {
      const attachment = this.att(socket);
      return count + (attachment.protocol === "v4" && !attachment.secureAuthenticated
        && attachment.authAttempted !== true && !!attachment.secureChallenge ? 1 : 0);
    }, 0);
  }

  private takeSecureRoomFrameSlot(now: number): boolean {
    if (!this.secureRoomFrameBudgetInitialized) {
      // Attachments make the initial window hibernation-safe. Once hydrated,
      // the room ledger retains history even if a flooding socket is closed.
      for (const socket of this.state.getWebSockets()) {
        const attachment = this.att(socket);
        if (!attachment.secureAuthenticated || attachment.protocol !== "v4"
          || !Array.isArray(attachment.msgTimestamps)) continue;
        this.secureRoomFrameTimestamps.push(...attachment.msgTimestamps.filter((timestamp) =>
          typeof timestamp === "number" && Number.isFinite(timestamp)
          && timestamp <= now && now - timestamp < 5_000
        ));
      }
      this.secureRoomFrameBudgetInitialized = true;
    }
    this.secureRoomFrameTimestamps = this.secureRoomFrameTimestamps.filter((timestamp) =>
      timestamp <= now && now - timestamp < 5_000
    );
    if (this.secureRoomFrameTimestamps.length >= MAX_SECURE_ROOM_FRAMES_PER_5S) return false;
    this.secureRoomFrameTimestamps.push(now);
    return true;
  }

  private takeSecureRoomOperationSlot(attachment: WSData, now: number): boolean {
    const stored = Array.isArray(attachment.secureOperationTimestamps)
      ? attachment.secureOperationTimestamps
      : [];
    attachment.secureOperationTimestamps = stored.filter((timestamp) =>
      typeof timestamp === "number" && Number.isFinite(timestamp)
      && timestamp <= now && now - timestamp < 5_000
    );
    if (attachment.secureOperationTimestamps.length >= MAX_SECURE_OPERATIONS_PER_5S) return false;
    attachment.secureOperationTimestamps.push(now);
    return true;
  }

  private rejectSecureAuthentication(
    ws: WebSocket,
    code: SecureServerErrorCodeV4,
    reason = "authentication failed",
  ) {
    this.consumeSecureAuthenticationChallenge(ws);
    this.sendSecureError(ws, code);
    try { ws.close(1008, reason); } catch {}
  }

  private async handleSecureAuthenticate(ws: WebSocket, authenticate: SecureAuthenticateFrameV4) {
    const authenticateOperation = () => this.withSecureLock(async () => {
      const ownsSetupReservation = authenticate.mode === "setup";
      if (ownsSetupReservation && this.setupInProgress) {
        this.rejectSecureAuthentication(ws, "room-exists");
        return;
      }
      if (ownsSetupReservation) this.setupInProgress = true;
      try {
        if (this.secureStateCorrupt) {
          this.rejectSecureAuthentication(ws, "room-state-invalid");
          return;
        }
        const attachment = this.att(ws);
        const connectionId = attachment.secureConnectionId;
        if (!connectionId || attachment.secureAuthenticated || attachment.protocol === "legacy") {
          this.rejectSecureAuthentication(ws, "authentication-failed");
          return;
        }

        const frame = authenticate.frame;
        const roomInstance = frame.kind === "setup" || frame.kind === "join"
          ? frame.hello.roomInstance
          : frame.roomInstance;
        const deviceId = frame.kind === "setup" || frame.kind === "join"
          ? frame.hello.deviceId
          : frame.deviceId;
        if (authenticate.mode === "setup") {
          if (this.secureRelayState || this.secureRelayManifest || this.authPublicKey || this.legacyAuthBlocked) {
            this.rejectSecureAuthentication(ws, "room-exists");
            return;
          }
          const rawReservation = await this.state.storage.get<unknown>(FORT_PASS_RESERVATION_KEY);
          const reservation = rawReservation === undefined ? null : parseFortPassReservation(rawReservation);
          if (rawReservation !== undefined && !reservation) {
            this.rejectSecureAuthentication(ws, "room-state-invalid");
            return;
          }
          if (reservation && reservation.expiresAt <= Date.now() && reservation.sessionId === null) {
            await this.state.storage.delete(FORT_PASS_RESERVATION_KEY);
          } else if (reservation && reservation.expiresAt > Date.now()
            && (!this.fortPassEntitlement || !isFortPassActive(this.fortPassEntitlement))) {
            this.rejectSecureAuthentication(ws, "room-exists");
            return;
          }
        } else if (!this.secureRelayState || !this.secureRoomAuthPublicKey) {
          this.rejectSecureAuthentication(ws, "room-not-found");
          return;
        } else if (roomInstance !== this.secureRelayState.roomInstance) {
          this.rejectSecureAuthentication(ws, "wrong-room");
          return;
        }

        const proofError = await this.verifySecureSocketProof(ws, async (challenge) => {
          if (authenticate.mode === "resume") {
            const signaturePublicKey = this.secureRelayState
              ? getSecureRelayDeviceSignatureKeyV4(this.secureRelayState, deviceId)
              : null;
            return !!signaturePublicKey && verifySecureDeviceResumeProofV4({
              roomId: this.roomId,
              roomInstance,
              deviceId,
              connectionId,
              requestId: frame.requestId,
              challenge,
            }, authenticate.resumeProof, signaturePublicKey);
          }
          return verifyRoomInvitationAuthV4({
            context: {
              mode: authenticate.mode,
              roomId: this.roomId,
              roomInstance,
              deviceId,
              connectionId,
              requestId: frame.requestId,
              challenge,
            },
            auth: authenticate.auth,
            storedPublicKey: this.secureRoomAuthPublicKey,
          });
        });
        if (proofError) {
          this.rejectSecureAuthentication(ws, proofError);
          return;
        }

        if ((authenticate.mode === "setup" || authenticate.mode === "join")
          && (frame.kind === "setup" || frame.kind === "join")) {
          const invitationPublicKey = authenticate.mode === "setup"
            ? parseRoomInvitationAuthPayloadV4(authenticate.auth, "setup")?.publicKey
            : this.secureRoomAuthPublicKey;
          const keyPackageDigest = await roomInvitationKeyPackageDigestV4(frame.hello.keyPackage);
          const memberBindingValid = !!invitationPublicKey && await verifyRoomInvitationMemberBindingV4({
            binding: frame.memberBinding,
            invitationPublicKey,
            expected: {
              mode: authenticate.mode === "setup" ? "founder" : "admission",
              roomId: this.roomId,
              roomInstance,
              deviceId,
              admissionId: frame.requestId,
              signaturePublicKey: frame.signaturePublicKey,
              keyPackageDigest,
            },
          });
          if (!memberBindingValid) {
            this.rejectSecureAuthentication(ws, "authentication-failed");
            return;
          }
        } else if (authenticate.mode === "setup" || authenticate.mode === "join") {
          this.rejectSecureAuthentication(ws, "authentication-failed");
          return;
        }

        let roomAuthPublicKey = this.secureRoomAuthPublicKey;
        if (authenticate.mode === "setup") {
          const parsedAuth = parseRoomInvitationAuthPayloadV4(authenticate.auth, "setup");
          roomAuthPublicKey = parsedAuth?.publicKey || null;
          if (!roomAuthPublicKey) {
            this.rejectSecureAuthentication(ws, "authentication-failed");
            return;
          }
          const generatedFreeRoom = isGeneratedFreeRoomId(this.roomId);
          if (!generatedFreeRoom && (!fortPassAllowsCustomRoomCode(this.fortPassEntitlement, this.roomId)
            || !await fortPassSetupClaimMatches(
              this.state.storage,
              this.roomId,
              this.fortPassEntitlement,
              authenticate.fortPassSessionId,
              authenticate.fortPassClaimSecret,
            ))) {
            this.rejectSecureAuthentication(ws, "authentication-failed");
            return;
          }
          if (this.env.ROOM) {
            const creationSource = attachment.creationSource || attachment.ip || "unknown";
            attachment.creationSource = undefined;
            ws.serializeAttachment(attachment);
            const limiterId = this.env.ROOM.idFromName(
              `__create_limit__:${creationSource}`,
            );
            const limitUrl = new URL(ROOM_CREATE_LIMIT_PATH, "https://pillowfort.internal");
            const limited = await this.env.ROOM.get(limiterId).fetch(new Request(limitUrl, { method: "POST" }));
            if (limited.status !== 204) {
              this.rejectSecureAuthentication(ws, "rate-limited");
              return;
            }
          }
        }

        const actor: SecureRelayActorV4 = {
          deviceId,
          connectionId,
          authentication: authenticate.mode === "resume" ? "device" : "invitation",
        };
        const replacedSocket = authenticate.mode === "resume"
          ? this.secureSocketForDevice(deviceId)
          : null;
        const now = Date.now();
        const transition = authenticate.mode === "setup"
          ? await createSecureRelayStateV4(actor, frame, now)
          : await reduceSecureRelayV4(this.secureRelayState!, actor, frame, {
              now,
              nextGrantTokenId: generateSecureRelayIdV4(),
            });
        if (!transition.ok) {
          this.rejectSecureAuthentication(ws, transition.code);
          return;
        }
        try {
          await this.persistSecureRelayState(transition.state, roomAuthPublicKey!, { touchIdle: true });
        } catch {
          this.rejectSecureAuthentication(ws, "persistence-failed");
          return;
        }

        const roomRetired = transition.state.lifecycle === "retired"
          || transition.effects.some((effect) => effect.type === "room-retired");
        const freshAdmissionRequired = transition.effects.some((effect) =>
          effect.type === "fresh-admission-required" && effect.deviceId === deviceId);
        if (roomRetired || freshAdmissionRequired) {
          // Expiry cleanup is an accepted, durable relay transition but not a
          // successful authentication. Emit cleanup only after its commit and
          // never attach the overdue socket to the retired identity.
          this.dispatchSecureEffects(transition.effects);
          this.rejectSecureAuthentication(
            ws,
            roomRetired ? "room-retired" : "fresh-admission-required",
            roomRetired ? "room retired" : "fresh admission required",
          );
          if (roomRetired) {
            for (const socket of this.state.getWebSockets()) {
              if (socket !== ws && this.att(socket).protocol === "v4") {
                try { socket.close(1000, "room retired"); } catch {}
              }
            }
          }
          return;
        }

        const current = this.att(ws);
        current.name = "";
        current.isHost = false;
        current.protocol = "v4";
        current.secureAuthenticated = true;
        current.secureAuthentication = actor.authentication;
        current.secureDeviceId = deviceId;
        current.secureConnectionId = connectionId;
        current.preAuthFrames = 0;
        current.creationSource = undefined;
        ws.serializeAttachment(current);
        if (replacedSocket && replacedSocket !== ws) {
          try { replacedSocket.close(4001, "connection replaced"); } catch {}
        }
        const member = transition.state.members.find((candidate) => candidate.deviceId === deviceId);
        if (authenticate.mode === "join") {
          const founderBinding = transition.state.members.find((candidate) => candidate.joinedOrder === 1)
            ?.memberBinding;
          if (!founderBinding) {
            this.rejectSecureAuthentication(ws, "room-state-invalid");
            return;
          }
          this.sendSecure(ws, {
            kind: "secure-server", v: 4, suite: 1, type: "authenticated",
            mode: "join",
            roomInstance: transition.state.roomInstance,
            deviceId,
            status: "pending",
            founderBinding,
          });
        } else {
          this.sendSecure(ws, {
            kind: "secure-server", v: 4, suite: 1, type: "authenticated",
            mode: authenticate.mode,
            roomInstance: transition.state.roomInstance,
            deviceId,
            status: member?.status === "active" ? "active" : "pending",
          });
        }
        this.dispatchSecureEffects(transition.effects);
      } catch {
        this.sendSecureError(ws, "internal-error");
      } finally {
        if (ownsSetupReservation) this.setupInProgress = false;
      }
    });
    if (authenticate.mode === "setup") {
      await this.withPaymentLock(authenticateOperation);
    } else {
      await authenticateOperation();
    }
  }

  private async handleSecureFrame(ws: WebSocket, frame: SecureClientFrameV4) {
    await this.withSecureLock(async () => {
      const attachment = this.att(ws);
      const state = this.secureRelayState;
      if (!state || !attachment.secureAuthenticated || attachment.protocol !== "v4"
        || !attachment.secureDeviceId || !attachment.secureConnectionId
        || !attachment.secureAuthentication) {
        this.sendSecureError(ws, "authentication-required");
        return;
      }
      const actor: SecureRelayActorV4 = {
        deviceId: attachment.secureDeviceId,
        connectionId: attachment.secureConnectionId,
        authentication: attachment.secureAuthentication,
      };
      const transition = await reduceSecureRelayV4(state, actor, frame, {
        now: Date.now(),
        nextGrantTokenId: generateSecureRelayIdV4(),
      });
      if (!transition.ok) {
        this.sendSecureError(ws, transition.code);
        return;
      }
      try {
        await this.persistSecureRelayState(transition.state, this.secureRoomAuthPublicKey!, { touchIdle: true });
      } catch {
        this.sendSecureError(ws, "persistence-failed");
        return;
      }
      this.dispatchSecureEffects(transition.effects);
      if (transition.state.lifecycle === "retired") {
        for (const socket of this.state.getWebSockets()) {
          if (this.att(socket).protocol === "v4") try { socket.close(1000, "room retired"); } catch {}
        }
      }
    });
  }

  private async onSecureDisconnect(ws: WebSocket) {
    await this.withSecureLock(async () => {
      const attachment = this.att(ws);
      const state = this.secureRelayState;
      if (!state || state.lifecycle !== "open" || !attachment.secureAuthenticated
        || !attachment.secureDeviceId || !attachment.secureConnectionId
        || !attachment.secureAuthentication) return;
      const actor: SecureRelayActorV4 = {
        deviceId: attachment.secureDeviceId,
        connectionId: attachment.secureConnectionId,
        authentication: attachment.secureAuthentication,
      };
      const transition = disconnectSecureRelayDeviceV4(state, actor, {
        now: Date.now(),
        nextGrantTokenId: generateSecureRelayIdV4(),
      });
      if (!transition.ok) return;
      // A close callback cannot be retried by the client. Surface storage
      // failure to the platform instead of silently leaving the durable member
      // marked connected forever and blocking its authenticated resume.
      await this.persistSecureRelayState(transition.state, this.secureRoomAuthPublicKey!);
      attachment.secureAuthenticated = false;
      ws.serializeAttachment(attachment);
      this.dispatchSecureEffects(transition.effects);
    });
  }

  private log(msg: string) {
    // Never place room identifiers, display names, game choices, roles, or
    // targets in provider logs. Protocol v4 hides those values entirely, and
    // legacy-room observability must not retain them either.
    void msg;
  }

  private metric(event: "room_setup_failed" | "room_join_failed", reason: string) {
    void event;
    void reason;
  }

  private async handleStripeSessionLedger(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await readByteLimitedText(request, 512);
    if (!body.ok || !body.text) return new Response("bad ledger action", { status: 400 });
    let value: unknown;
    try { value = JSON.parse(body.text); } catch { return new Response("bad ledger action", { status: 400 }); }
    const action = parseStripeSessionLedgerAction(value);
    if (!action) return new Response("bad ledger action", { status: 400 });

    const now = Date.now();
    type LedgerOutcome =
      | { type: "claimed"; leaseExpiresAt: number }
      | { type: "complete" }
      | { type: "released" }
      | { type: "conflict"; retryAfter: number | null }
      | { type: "corrupt" };
    const outcome = await this.state.storage.transaction<LedgerOutcome>(async (transaction) => {
      const raw = await transaction.get<unknown>(STRIPE_SESSION_LEDGER_KEY);
      const record = raw === undefined ? null : parseStripeSessionLedgerRecord(raw);
      if (raw !== undefined && !record) {
        return { type: "corrupt" };
      }
      if (record && record.roomId !== action.roomId) {
        return { type: "conflict", retryAfter: null };
      }

      if (action.action === "claim") {
        if (record?.status === "complete") {
          return { type: "complete" };
        }
        if (record?.status === "pending" && record.leaseExpiresAt > now
          && record.token !== action.token) {
          return {
            type: "conflict",
            retryAfter: Math.max(1, Math.ceil((record.leaseExpiresAt - now) / 1_000)),
          };
        }
        const leaseExpiresAt = record?.status === "pending" && record.token === action.token
          && record.leaseExpiresAt > now
          ? record.leaseExpiresAt
          : now + STRIPE_SESSION_LEASE_MS;
        await transaction.put(STRIPE_SESSION_LEDGER_KEY, {
          v: 1,
          status: "pending",
          roomId: action.roomId,
          token: action.token,
          leaseExpiresAt,
        } satisfies StripeSessionLedgerRecord);
        return { type: "claimed", leaseExpiresAt };
      }

      if (action.action === "complete") {
        if (record?.status === "complete") {
          return { type: "complete" };
        }
        if (!record || record.status !== "pending" || record.token !== action.token
          || record.leaseExpiresAt <= now) {
          return { type: "conflict", retryAfter: null };
        }
        await transaction.put(STRIPE_SESSION_LEDGER_KEY, {
          v: 1,
          status: "complete",
          roomId: action.roomId,
          completedAt: now,
        } satisfies StripeSessionLedgerRecord);
        return { type: "complete" };
      }

      if (!record) {
        return { type: "released" };
      }
      if (record.status !== "pending" || record.token !== action.token) {
        return { type: "conflict", retryAfter: null };
      }
      await transaction.delete(STRIPE_SESSION_LEDGER_KEY);
      return { type: "released" };
    });

    const headers = { "cache-control": "no-store" };
    if (outcome.type === "corrupt") return new Response("ledger state unavailable", { status: 503, headers });
    if (outcome.type === "conflict") {
      return new Response("ledger conflict", {
        status: 409,
        headers: {
          ...headers,
          ...(outcome.retryAfter === null ? {} : { "retry-after": String(outcome.retryAfter) }),
        },
      });
    }
    if (action.action === "claim") {
      if (outcome.type !== "claimed" && outcome.type !== "complete") {
        return new Response("ledger state unavailable", { status: 503, headers });
      }
      return new Response(JSON.stringify(outcome.type === "complete"
        ? { status: "complete" }
        : { status: "claimed", leaseExpiresAt: outcome.leaseExpiresAt }), {
        status: outcome.type === "complete" ? 200 : 201,
        headers: { ...headers, "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204, headers });
  }

  private async handleFortPassReservation(request: Request): Promise<Response> {
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers });
    }
    if (!isJsonRequest(request)) {
      return new Response("unsupported media type", { status: 415, headers });
    }
    const body = await readByteLimitedText(request, 512);
    if (!body.ok || !body.text) {
      return new Response("bad reservation action", { status: 400, headers });
    }
    let value: unknown;
    try {
      value = JSON.parse(body.text);
    } catch {
      return new Response("bad reservation action", { status: 400, headers });
    }
    const action = parseFortPassReservationAction(value);
    if (!action) return new Response("bad reservation action", { status: 400, headers });

    if ((action.action === "claim" || action.action === "supersede")
      && (this.setupInProgress || this.authPublicKey || this.secureRelayManifest
        || this.secureStateCorrupt || this.legacyAuthBlocked
        || (!!this.fortPassEntitlement && isFortPassActive(this.fortPassEntitlement))
        || this.state.getWebSockets().some((socket) => !!this.att(socket).name
          || this.att(socket).secureAuthenticated))) {
      return new Response("room unavailable", { status: 409, headers });
    }

    const now = Date.now();
    const expiresAt = now + FORT_PASS_RESERVATION_MS;
    const bindProviderRefHash = action.action === "bind"
      ? await fortPassProviderRefHash("stripe", action.sessionId)
      : null;
    type ReservationOutcome =
      | { type: "claimed"; expiresAt: number }
      | { type: "supersession-required"; sessionId: string }
      | { type: "bound" | "released" | "conflict" | "corrupt" };
    const outcome = await this.state.storage.transaction<ReservationOutcome>(async (transaction) => {
      const [raw, rawPreGrantRevocation] = await Promise.all([
        transaction.get<unknown>(FORT_PASS_RESERVATION_KEY),
        transaction.get<unknown>(FORT_PASS_PREGRANT_REVOCATION_KEY),
      ]);
      const reservation = raw === undefined ? null : parseFortPassReservation(raw);
      const preGrantRevocation = rawPreGrantRevocation === undefined
        ? null
        : parseFortPassPreGrantRevocation(rawPreGrantRevocation);
      if ((raw !== undefined && !reservation)
        || (rawPreGrantRevocation !== undefined && !preGrantRevocation)) return { type: "corrupt" };

      if (action.action === "claim") {
        if (!reservation || (reservation.expiresAt <= now && reservation.sessionId === null)) {
          const claimed: FortPassReservationV2 = {
            v: 2,
            expiresAt,
            token: action.token,
            sessionId: null,
            claimHash: action.claimHash,
          };
          await transaction.put(FORT_PASS_RESERVATION_KEY, claimed);
          return { type: "claimed", expiresAt };
        }
        if (reservation.expiresAt > now) return { type: "conflict" };
        return { type: "supersession-required", sessionId: reservation.sessionId! };
      }

      if (action.action === "supersede") {
        if (!reservation || reservation.expiresAt > now || reservation.sessionId === null
          || reservation.sessionId !== action.priorSessionId) return { type: "conflict" };
        const claimed: FortPassReservationV2 = {
          v: 2,
          expiresAt,
          token: action.token,
          sessionId: null,
          claimHash: action.claimHash,
        };
        await transaction.put(FORT_PASS_RESERVATION_KEY, claimed);
        return { type: "claimed", expiresAt };
      }

      if (action.action === "bind") {
        if (preGrantRevocation && bindProviderRefHash === preGrantRevocation.providerRefHash) {
          return { type: "conflict" };
        }
        if (!reservation || reservation.expiresAt <= now || reservation.token !== action.token) {
          return { type: "conflict" };
        }
        if (reservation.sessionId !== null && reservation.sessionId !== action.sessionId) {
          return { type: "conflict" };
        }
        if (reservation.sessionId === null) {
          await transaction.put(FORT_PASS_RESERVATION_KEY, {
            ...reservation,
            sessionId: action.sessionId,
          } satisfies FortPassReservationV2);
        }
        return { type: "bound" };
      }

      if (!reservation || reservation.token !== action.token || reservation.sessionId !== null) {
        return { type: "conflict" };
      }
      await transaction.delete(FORT_PASS_RESERVATION_KEY);
      return { type: "released" };
    });

    if (outcome.type === "corrupt") {
      return new Response("reservation state unavailable", { status: 503, headers });
    }
    if (outcome.type === "conflict") {
      return new Response("reservation conflict", { status: 409, headers });
    }
    if (outcome.type === "supersession-required") {
      return new Response(JSON.stringify({
        status: "supersession-required",
        sessionId: outcome.sessionId,
      }), {
        status: 200,
        headers: { ...headers, "content-type": "application/json" },
      });
    }
    if (outcome.type === "claimed") {
      return new Response(JSON.stringify({ status: "claimed", expiresAt: outcome.expiresAt }), {
        status: 201,
        headers: { ...headers, "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204, headers });
  }

  private async handleFortPassRevocation(request: Request): Promise<Response> {
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers });
    }
    if (!isJsonRequest(request)) {
      return new Response("unsupported media type", { status: 415, headers });
    }
    const body = await readByteLimitedText(request, 512);
    if (!body.ok || !body.text) {
      return new Response("bad revocation", { status: 400, headers });
    }
    let value: unknown;
    try {
      value = JSON.parse(body.text);
    } catch {
      return new Response("bad revocation", { status: 400, headers });
    }
    const action = parseFortPassRevocationAction(value);
    if (!action) return new Response("bad revocation", { status: 400, headers });

    const now = Date.now();
    const providerRefHash = await fortPassProviderRefHash("stripe", action.sessionId);
    const roomWasActive = !!this.authPublicKey || !!this.secureRelayManifest || !!this.secureRelayState
      || this.state.getWebSockets().some((socket) => !!this.att(socket).name
        || this.att(socket).secureAuthenticated);
    type RevocationOutcome =
      | {
          type: "revoked";
          entitlement: FortPassEntitlement | null;
          replay: boolean;
          reason: "refund" | "dispute";
        }
      | { type: "stale" }
      | { type: "corrupt" };
    const outcome = await this.state.storage.transaction<RevocationOutcome>(async (transaction) => {
      const [rawEntitlement, rawRedemption, rawReservation, rawPreGrantRevocation] = await Promise.all([
        transaction.get<unknown>(FORT_PASS_ENTITLEMENT_KEY),
        transaction.get<unknown>(FORT_PASS_REDEMPTION_KEY),
        transaction.get<unknown>(FORT_PASS_RESERVATION_KEY),
        transaction.get<unknown>(FORT_PASS_PREGRANT_REVOCATION_KEY),
      ]);
      const entitlement = rawEntitlement === undefined
        ? null
        : normalizeFortPassEntitlement(rawEntitlement, now);
      const redemption = rawRedemption === undefined
        ? null
        : parseFortPassRedemptionRecord(rawRedemption);
      const reservation = rawReservation === undefined
        ? null
        : parseFortPassReservation(rawReservation);
      const preGrantRevocation = rawPreGrantRevocation === undefined
        ? null
        : parseFortPassPreGrantRevocation(rawPreGrantRevocation);
      if ((rawEntitlement !== undefined && !entitlement)
        || (rawRedemption !== undefined && !redemption)
        || (rawReservation !== undefined && !reservation)
        || (rawPreGrantRevocation !== undefined && !preGrantRevocation)) return { type: "corrupt" };
      const exactReservation = reservation?.sessionId === action.sessionId;
      if (!entitlement || !redemption
        || entitlement.provider !== "stripe"
        || entitlement.providerRef !== action.sessionId
        || redemption.provider !== "stripe"
        || redemption.providerRefHash !== providerRefHash
        || redemption.roomId !== entitlement.roomId
        || redemption.createdAt !== entitlement.createdAt) {
        if (preGrantRevocation?.providerRefHash === providerRefHash) {
          if (exactReservation) await transaction.delete(FORT_PASS_RESERVATION_KEY);
          return {
            type: "revoked", entitlement: null, replay: true,
            reason: preGrantRevocation.reason,
          };
        }
        if (!exactReservation) return { type: "stale" };
        await transaction.delete(FORT_PASS_RESERVATION_KEY);
        await transaction.put(FORT_PASS_PREGRANT_REVOCATION_KEY, {
          v: 1, providerRefHash, revokedAt: now, reason: action.reason,
        } satisfies FortPassPreGrantRevocation);
        return {
          type: "revoked", entitlement: null, replay: false, reason: action.reason,
        };
      }
      if (entitlement.status === "active" && redemption.revokedAt !== null) {
        return { type: "corrupt" };
      }
      if (entitlement.status !== "active") {
        if (entitlement.status !== "refunded") return { type: "stale" };
        const reason = redemption.revocationReason || action.reason;
        if (redemption.revokedAt === null) {
          await transaction.put(FORT_PASS_REDEMPTION_KEY, {
            ...redemption,
            claimHash: null,
            revokedAt: now,
            revocationReason: reason,
          } satisfies FortPassRedemptionRecord);
        }
        await transaction.put(FORT_PASS_PREGRANT_REVOCATION_KEY, {
          v: 1, providerRefHash, revokedAt: redemption.revokedAt || now, reason,
        } satisfies FortPassPreGrantRevocation);
        if (exactReservation) await transaction.delete(FORT_PASS_RESERVATION_KEY);
        return { type: "revoked", entitlement, replay: true, reason };
      }

      const refundedEntitlement: FortPassEntitlement = { ...entitlement, status: "refunded" };
      await transaction.put(FORT_PASS_ENTITLEMENT_KEY, refundedEntitlement);
      await transaction.put(FORT_PASS_REDEMPTION_KEY, {
        ...redemption,
        claimHash: null,
        revokedAt: now,
        revocationReason: action.reason,
      } satisfies FortPassRedemptionRecord);
      await transaction.put(FORT_PASS_PREGRANT_REVOCATION_KEY, {
        v: 1, providerRefHash, revokedAt: now, reason: action.reason,
      } satisfies FortPassPreGrantRevocation);
      if (exactReservation) await transaction.delete(FORT_PASS_RESERVATION_KEY);
      await transaction.put(ROOM_THEME_KEY, "away-message");

      const schedule = normalizeRoomAlarmSchedule(
        await transaction.get<RoomAlarmSchedule>(ALARM_SCHEDULE_KEY),
      );
      if (roomWasActive || Object.prototype.hasOwnProperty.call(schedule, "idle")) {
        schedule.idle = now + IDLE_MS;
      }
      const nextDeadline = nextRoomAlarmDeadline(schedule);
      if (nextDeadline === null) {
        await transaction.delete(ALARM_SCHEDULE_KEY);
        await transaction.deleteAlarm();
      } else {
        await transaction.put(ALARM_SCHEDULE_KEY, schedule);
        await transaction.setAlarm(nextDeadline);
      }
      return {
        type: "revoked",
        entitlement: refundedEntitlement,
        replay: false,
        reason: action.reason,
      };
    });

    if (outcome.type === "corrupt") {
      return new Response("room payment state unavailable", { status: 503, headers });
    }
    if (outcome.type === "stale") {
      return new Response(JSON.stringify({ revoked: false, stale: true }), {
        status: 200,
        headers: { ...headers, "content-type": "application/json" },
      });
    }
    if (outcome.entitlement) this.fortPassEntitlement = outcome.entitlement;
    if (!outcome.replay && outcome.entitlement) {
      this.roomTheme = "away-message";
      this.broadcast("room-theme", { theme: "away-message" });
      this.broadcast("fort-pass-updated", { fortPass: null });
    }
    return new Response(JSON.stringify({
      revoked: true,
      replay: outcome.replay,
      reason: outcome.reason,
    }), {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === ROOM_STRIPE_SESSION_LEDGER_PATH) {
      return this.handleStripeSessionLedger(request);
    }

    if (url.pathname === ROOM_FORT_PASS_RESERVATION_PATH) {
      return this.withPaymentLock(() => this.handleFortPassReservation(request));
    }

    if (url.pathname === ROOM_FORT_PASS_REVOKE_PATH) {
      return this.withPaymentLock(() => this.handleFortPassRevocation(request));
    }

    if (url.pathname === ROOM_STATUS_PATH) {
      const rawReservation = await this.state.storage.get<unknown>(FORT_PASS_RESERVATION_KEY);
      const reservation = rawReservation === undefined ? null : parseFortPassReservation(rawReservation);
      if (rawReservation !== undefined && !reservation) {
        return new Response("room state unavailable", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
      const reserved = !!reservation && reservation.expiresAt > Date.now();
      if (reservation && !reserved && reservation.sessionId === null) {
        await this.state.storage.delete(FORT_PASS_RESERVATION_KEY);
      }
      return new Response(JSON.stringify({
        exists: this.setupInProgress || !!this.authPublicKey || !!this.secureRelayManifest || this.secureStateCorrupt || this.legacyAuthBlocked ||
          (!!this.fortPassEntitlement && isFortPassActive(this.fortPassEntitlement)) ||
          reserved ||
          this.state.getWebSockets().some(w => !!this.att(w).name),
      }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === ROOM_FORT_PASS_RESERVE_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const reservation = await this.state.storage.get<{ expiresAt: number }>(CHECKOUT_RATE_LIMIT_LEASE_KEY);
      if (this.setupInProgress || this.authPublicKey || this.secureRelayManifest || this.secureStateCorrupt || this.legacyAuthBlocked || (!!this.fortPassEntitlement && isFortPassActive(this.fortPassEntitlement)) || (reservation && reservation.expiresAt > Date.now())) {
        return new Response("room unavailable", { status: 409 });
      }
      await this.state.storage.put(CHECKOUT_RATE_LIMIT_LEASE_KEY, { expiresAt: Date.now() + FORT_PASS_RESERVATION_MS });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === ROOM_FORT_PASS_RELEASE_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!this.authPublicKey && !this.secureRelayManifest && !this.secureStateCorrupt && !this.legacyAuthBlocked && (!this.fortPassEntitlement || !isFortPassActive(this.fortPassEntitlement))) await this.state.storage.delete(CHECKOUT_RATE_LIMIT_LEASE_KEY);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === ROOM_CREATE_LIMIT_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const now = Date.now();
      const timestamps = ((await this.state.storage.get<number[]>(CREATE_LIMIT_KEY)) || []).filter(ts => now - ts < 60_000);
      if (timestamps.length >= RATE_ROOMS_PER_MIN) return new Response("rate limited", { status: 429 });
      timestamps.push(now);
      await this.state.storage.put(CREATE_LIMIT_KEY, timestamps);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === ROOM_WS_OPEN_LIMIT_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const now = Date.now();
      const result = await this.state.storage.transaction<"allowed" | "limited" | "corrupt">(async (transaction) => {
        const stored = await transaction.get<unknown>(WS_OPEN_LIMIT_KEY);
        if (stored !== undefined && (!Array.isArray(stored)
          || stored.length > RATE_WS_OPENS_PER_MIN
          || stored.some((value) => typeof value !== "number"
            || !Number.isSafeInteger(value) || value < 0))) return "corrupt";
        // Count future timestamps after a wall-clock rollback rather than
        // dropping them and accidentally reopening the limiter.
        const persisted = stored === undefined ? [] : stored as number[];
        const timestamps = persisted.filter((value) => now - value < 60_000);
        if (timestamps.length >= RATE_WS_OPENS_PER_MIN) return "limited";
        timestamps.push(now);
        await transaction.put(WS_OPEN_LIMIT_KEY, timestamps);
        return "allowed";
      });
      if (result === "corrupt") return new Response("limiter state unavailable", { status: 503 });
      return result === "allowed"
        ? new Response(null, { status: 204 })
        : new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    }

    if (url.pathname === ROOM_FORT_PASS_FULFILL_PATH) {
      return this.withPaymentLock(async () => {
      const headers = { "cache-control": "no-store" };
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers });
      if (!isJsonRequest(request)) return new Response("unsupported media type", { status: 415, headers });
      const body = await readByteLimitedText(request, 4 * 1024);
      if (!body.ok || !body.text) return new Response("bad entitlement", { status: 400, headers });
      let value: unknown;
      try {
        value = JSON.parse(body.text);
      } catch {
        return new Response("bad entitlement", { status: 400, headers });
      }
      if (!isExactPlainRecord(value, ["entitlement", "claimHash"])) {
        return new Response("bad entitlement", { status: 400, headers });
      }
      const entitlement = normalizeFortPassEntitlement(value.entitlement);
      const claimHash = normalizeFortPassClaimHash(value.claimHash);
      if (!entitlement || !claimHash || (this.roomId && entitlement.roomId !== this.roomId)) {
        return new Response("bad entitlement", { status: 400, headers });
      }
      const incomingRedemption = await fortPassRedemptionRecord(entitlement, claimHash);
      const roomAlreadyActive = this.setupInProgress || this.authPublicKey || this.secureRelayManifest
        || this.secureStateCorrupt
        || this.legacyAuthBlocked
        || this.state.getWebSockets().some(w => !!this.att(w).name || this.att(w).secureAuthenticated);
      type GrantOutcome = "granted" | "replay" | "reservation-conflict" | "stale" | "revoked"
        | "active" | "corrupt";
      const grantOutcome = await this.state.storage.transaction<GrantOutcome>(async (transaction) => {
        const [rawReservation, rawRedemption, rawEntitlement, rawPreGrantRevocation] = await Promise.all([
          transaction.get<unknown>(FORT_PASS_RESERVATION_KEY),
          transaction.get<unknown>(FORT_PASS_REDEMPTION_KEY),
          transaction.get<unknown>(FORT_PASS_ENTITLEMENT_KEY),
          transaction.get<unknown>(FORT_PASS_PREGRANT_REVOCATION_KEY),
        ]);
        const reservation = rawReservation === undefined ? null : parseFortPassReservation(rawReservation);
        const redemption = rawRedemption === undefined ? null : parseFortPassRedemptionRecord(rawRedemption);
        const storedEntitlement = rawEntitlement === undefined
          ? null
          : normalizeFortPassEntitlement(rawEntitlement);
        const preGrantRevocation = rawPreGrantRevocation === undefined
          ? null
          : parseFortPassPreGrantRevocation(rawPreGrantRevocation);
        if ((rawReservation !== undefined && !reservation)
          || (rawRedemption !== undefined && !redemption)
          || (rawEntitlement !== undefined && !storedEntitlement)
          || (rawPreGrantRevocation !== undefined && !preGrantRevocation)) return "corrupt";
        if (preGrantRevocation?.providerRefHash === incomingRedemption.providerRefHash) return "revoked";
        const sameRedemption = redemption?.provider === entitlement.provider
          && redemption.providerRefHash === incomingRedemption.providerRefHash
          && redemption.roomId === entitlement.roomId
          && redemption.createdAt === entitlement.createdAt;
        if (sameRedemption) {
          if (redemption!.revokedAt !== null) return "revoked";
          if (!constantTimeFortPassClaimHashEqual(redemption!.claimHash, claimHash)) return "corrupt";
          // Room teardown intentionally removes the live entitlement while
          // retaining the redemption ledger. An exact retry may acknowledge
          // that prior grant so the payment coordinator can finish, but must
          // never recreate the entitlement. If a live copy exists, require it
          // to describe the same immutable grant.
          if (storedEntitlement && (storedEntitlement.provider !== entitlement.provider
            || storedEntitlement.providerRef !== entitlement.providerRef
            || storedEntitlement.roomId !== entitlement.roomId
            || storedEntitlement.createdAt !== entitlement.createdAt
            || !isFortPassActive(storedEntitlement))) return "corrupt";
          return "replay";
        }
        // A late retry from an older Checkout Session must never replace a newer
        // redemption for the same reusable room code after teardown.
        if (redemption && entitlement.createdAt <= redemption.createdAt) return "stale";
        if (roomAlreadyActive) return "active";
        if (entitlement.provider === "stripe" && (!reservation
          || reservation.sessionId !== entitlement.providerRef
          || !constantTimeFortPassClaimHashEqual(reservation.claimHash, claimHash))) {
          return "reservation-conflict";
        }
        await transaction.put("roomId", entitlement.roomId);
        await transaction.put(FORT_PASS_ENTITLEMENT_KEY, entitlement);
        await transaction.put(FORT_PASS_REDEMPTION_KEY, incomingRedemption);
        await transaction.delete(FORT_PASS_RESERVATION_KEY);
        return "granted";
      });
      if (grantOutcome === "corrupt") {
        return new Response("room payment state unavailable", {
          status: 503,
          headers,
        });
      }
      if (grantOutcome === "reservation-conflict") {
        return new Response("reservation conflict", {
          status: 409,
          headers,
        });
      }
      if (grantOutcome === "active") {
        return new Response("room already active", { status: 409, headers });
      }
      if (grantOutcome === "stale" || grantOutcome === "revoked") {
        return new Response(grantOutcome === "stale" ? "stale entitlement" : "entitlement revoked", {
          status: 409,
          headers,
        });
      }
      if (grantOutcome === "replay") {
        return new Response(JSON.stringify({ ok: true, replay: true }), {
          headers: { ...headers, "content-type": "application/json" },
        });
      }
      this.roomId = entitlement.roomId;
      this.fortPassEntitlement = entitlement;
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          ...headers,
        },
      });
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    if (this.secureStateCorrupt) {
      return new Response("room state unavailable", { status: 503 });
    }

    const roomParameters = url.searchParams.getAll("room");
    const roomId = roomParameters[0] || "";
    if (!hasOnlyAllowedSearchParameters(url, ["room", "protocol"]) ||
        roomParameters.length !== 1 || !roomId || normalizeRoomId(roomId) !== roomId) {
      return new Response("invalid room", { status: 400 });
    }
    // The edge normally selects this Durable Object from the same canonical
    // room identifier. Keep that routing assumption explicit at the object
    // boundary so an internal/misconfigured caller cannot authenticate a
    // request under a different room context than the persisted one.
    if (this.roomId && roomId !== this.roomId) {
      return new Response("wrong room", { status: 409 });
    }
    const protocolParameters = url.searchParams.getAll("protocol");
    if (protocolParameters.length !== 1 || protocolParameters[0] !== "4") {
      return new Response("protocol v4 required", {
        status: 426,
        headers: { "cache-control": "no-store" },
      });
    }
    if (this.authPublicKey || this.legacyAuthBlocked) {
      return new Response("protocol mismatch", { status: 409 });
    }
    const unauthenticatedSockets = this.pendingSecureAuthenticationCount();
    if (unauthenticatedSockets >= MAX_UNAUTHENTICATED_SOCKETS_PER_ROOM) {
      return new Response("too many pending websocket authentications", {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": "30" },
      });
    }
    if (roomId && !this.roomId) {
      this.roomId = roomId;
      await this.state.storage.put("roomId", roomId);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const hash = Array.from(crypto.getRandomValues(new Uint8Array(2)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    // Durable Objects are reached through Cloudflare; X-Forwarded-For is
    // client-spoofable and must not select the authentication rate-limit key.
    const rawIp = request.headers.get("cf-connecting-ip") || "unknown";
    const [ip, creationSource] = await Promise.all([
      // Authentication throttling is room-scoped to prevent stored source
      // pseudonyms from becoming cross-room tracking identifiers.
      hashClientAddress(rawIp, `room:${roomId}`),
      // Creation throttling must remain global or a source could evade it by
      // choosing a fresh room code for every attempt.
      hashClientAddress(rawIp, "creation"),
    ]);
    const authChallenge = createRoomAuthChallenge();
    const connectionId = generateSecureRelayIdV4();
    const challengeExpiresAt = Date.now() + ROOM_AUTH_CHALLENGE_TTL_MS;
    server.serializeAttachment({
      name: "",
      hash,
      isHost: false,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
      drawTimestamps: [],
      ip,
      creationSource,
      authChallenge,
      authChallengeExpiresAt: challengeExpiresAt,
      authAttempted: false,
      preAuthFrames: 0,
      protocol: "v4",
      secureConnectionId: connectionId,
      secureChallenge: authChallenge,
      secureChallengeExpiresAt: challengeExpiresAt,
      secureAuthenticated: false,
    } as WSData);
    try {
      await this.schedulePreAuthSocketSweep(challengeExpiresAt);
    } catch {
      this.consumeSecureAuthenticationChallenge(server);
      try { server.close(1011, "authentication timer unavailable"); } catch {}
      return new Response("room state unavailable", { status: 503 });
    }
    const secureChallenge = parseSecureAuthChallengeFrameV4({
      kind: "secure-auth-challenge",
      v: 4,
      suite: 1,
      connectionId,
      challenge: authChallenge,
      roomInstance: this.secureRelayState?.roomInstance || null,
    });
    if (!secureChallenge) throw new Error("failed to construct secure authentication challenge");
    this.sendSecure(server, secureChallenge);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const beforeParse = this.att(ws);
    const frameLimit = beforeParse.protocol === "v4"
      ? MAX_SECURE_WEBSOCKET_FRAME_BYTES
      : MAX_WEBSOCKET_FRAME_BYTES;
    if (typeof message !== "string" || message.length > frameLimit ||
        new TextEncoder().encode(message).byteLength > frameLimit) {
      if (!beforeParse.name && !beforeParse.secureAuthenticated) {
        this.consumeSecureAuthenticationChallenge(ws);
      }
      try { ws.close(1009, "frame too large"); } catch {}
      return;
    }
    if (!beforeParse.name && !beforeParse.secureAuthenticated) {
      beforeParse.preAuthFrames = (beforeParse.preAuthFrames || 0) + 1;
      ws.serializeAttachment(beforeParse);
      if (beforeParse.preAuthFrames > 3) {
        this.consumeSecureAuthenticationChallenge(ws);
        try { ws.close(1008, "too many unauthenticated frames"); } catch {}
        return;
      }
    }
    if (beforeParse.secureAuthenticated) {
      const now = Date.now();
      const storedMessageTimestamps = Array.isArray(beforeParse.msgTimestamps)
        ? beforeParse.msgTimestamps
        : [];
      beforeParse.msgTimestamps = storedMessageTimestamps.filter((timestamp) =>
        typeof timestamp === "number" && Number.isFinite(timestamp)
        && timestamp <= now && now - timestamp < 5_000
      );
      // Mandatory delivery ACKs and host decisions count toward this generous
      // raw cap and the room aggregate, but not the separate initiator budget.
      // This prevents legitimate protocol fanout from ejecting passive peers.
      if (beforeParse.msgTimestamps.length >= MAX_SECURE_SOCKET_FRAMES_PER_5S ||
          !this.takeSecureRoomFrameSlot(now)) {
        this.sendSecureError(ws, "rate-limited");
        try { ws.close(1008, "rate limit exceeded"); } catch {}
        return;
      }
      beforeParse.msgTimestamps.push(now);
      ws.serializeAttachment(beforeParse);
    }
    try {
      const msg = JSON.parse(message as string);
      const a = this.att(ws);
      const secureAuthenticate = parseSecureAuthenticateFrameV4(msg);
      if (secureAuthenticate) {
        if (a.protocol !== "v4" || a.name || a.secureAuthenticated || this.authPublicKey || this.legacyAuthBlocked) {
          this.rejectSecureAuthentication(ws, "downgrade", "protocol mismatch");
          return;
        }
        await this.handleSecureAuthenticate(ws, secureAuthenticate);
        return;
      }
      if (msg?.kind === "secure-authenticate") {
        this.rejectSecureAuthentication(ws, "invalid-frame", "invalid authentication frame");
        return;
      }
      if (a.secureAuthenticated) {
        const secureFrame = parseSecurePostAuthClientFrameV4(msg);
        if (!secureFrame) {
          this.sendSecureError(ws, "invalid-frame");
          return;
        }
        // All mutation-bearing relay frames require an exact prior order
        // grant, so charging the initiating request once bounds client work
        // without double-charging its granted frame or mandatory receipts.
        if (secureFrame.kind === "order-request" &&
            !this.takeSecureRoomOperationSlot(a, Date.now())) {
          ws.serializeAttachment(a);
          this.sendSecureError(ws, "rate-limited");
          try { ws.close(1008, "rate limit exceeded"); } catch {}
          return;
        }
        if (secureFrame.kind === "order-request") ws.serializeAttachment(a);
        await this.handleSecureFrame(ws, secureFrame);
        return;
      }
      if (this.secureRelayState) {
        this.rejectSecureAuthentication(ws, "downgrade", "protocol mismatch");
        return;
      }
      if (a.protocol === "v4") {
        this.rejectSecureAuthentication(ws, "invalid-frame", "invalid authentication frame");
        return;
      }
      if (!a.name && msg.type !== "set-up" && msg.type !== "join" && msg.type !== "rejoin") {
        this.send(ws, "error", { message: "authentication required" });
        try { ws.close(1008, "authentication required"); } catch {}
        return;
      }
      switch (msg.type) {
        case "set-up":       await this.withPaymentLock(() => this.onSetUp(ws, msg)); break;
        case "join":         await this.onJoin(ws, msg); break;
        case "rejoin":       await this.onRejoin(ws, msg); break;
        case "chat":         await this.onChat(ws, msg); break;
        case "knock-down":   await this.onKnockDown(ws); break;
        case "leave":        await this.onLeave(ws); break;
        case "typing":       this.onTyping(ws); break;
        case "set-status":   await this.onSetStatus(ws, msg); break;
        case "set-theme":    await this.onSetTheme(ws, msg); break;
        case "accept-host":  await this.onAcceptHost(ws); break;
        case "reject-host":  await this.onRejectHost(ws); break;
        case "toss-pillow": this.onTossPillow(ws, msg); break;
        case "draw":        this.onDraw(ws, msg); break;
        // --- pvp games ---
        case "start-vote":    this.onStartVote(ws, msg); break;
        case "cast-vote":     this.onCastVote(ws, msg); break;
        case "rps-challenge": this.onRpsChallenge(ws, msg); break;
        case "rps-accept":    this.onRpsAccept(ws); break;
        case "rps-decline":   this.onRpsDecline(ws); break;
        case "rps-pick":      this.onRpsPick(ws, msg); break;
        case "ttt-challenge": this.onTttChallenge(ws, msg); break;
        case "ttt-accept":    this.onTttAccept(ws); break;
        case "ttt-decline":   this.onTttDecline(ws); break;
        case "ttt-move":      this.onTttMove(ws, msg); break;
        case "sab-start":     this.onSabStart(ws); break;
        case "sab-accuse":    this.onSabAccuse(ws, msg); break;
        case "sab-strike":    await this.onSabStrike(ws); break;
        case "sab-vote":      this.onSabVote(ws, msg); break;
        case "koth-challenge": this.onKothChallenge(ws); break;
      }
    } catch {
      const a = this.att(ws);
      if (a.protocol === "v4") {
        if (a.secureAuthenticated) this.sendSecureError(ws, "invalid-frame");
        else this.rejectSecureAuthentication(ws, "invalid-frame", "invalid authentication frame");
      }
      else if (new TextEncoder().encode(message).byteLength > MAX_WEBSOCKET_FRAME_BYTES) {
        try { ws.close(1009, "frame too large"); } catch {}
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (this.att(ws).secureAuthenticated) await this.onSecureDisconnect(ws);
    else await this.onGracefulDisconnect(ws);
  }
  async webSocketError(ws: WebSocket) {
    if (this.att(ws).secureAuthenticated) await this.onSecureDisconnect(ws);
    else await this.onGracefulDisconnect(ws);
  }

  async alarm() {
    // Alarm callbacks and websocket transitions can both await crypto/storage.
    // Serialize the complete read-decide-write cycle so a queued stale idle or
    // relay alarm cannot act on a schedule that a newer transition refreshed.
    await this.withSecureLock(async () => {
      const now = Date.now();
      const schedule = await this.loadAlarmSchedule();
      const due = firstDueRoomAlarm(schedule, now);

      if (due === "sab-bomb") {
        await this.state.storage.get<SabBombState>(SAB_BOMB_KEY);
        this.log("legacy game alarm fired");
        await this.destroyRoom("the saboteur's bomb exploded!");
        return;
      }

      if (due === "auth-sockets") {
        delete schedule["auth-sockets"];
        let nextExpiry: number | null = null;
        for (const socket of this.state.getWebSockets()) {
          const attachment = this.att(socket);
          if (attachment.name || attachment.secureAuthenticated) continue;
          const expiresAt = attachment.protocol === "v4"
            ? attachment.secureChallengeExpiresAt
            : attachment.authChallengeExpiresAt;
          if (typeof expiresAt !== "number" || expiresAt <= now) {
            this.consumeSecureAuthenticationChallenge(socket);
            try { socket.close(1008, "authentication timeout"); } catch {}
          } else {
            nextExpiry = nextExpiry === null ? expiresAt : Math.min(nextExpiry, expiresAt);
          }
        }
        if (nextExpiry !== null) schedule["auth-sockets"] = nextExpiry;
        await this.saveAlarmSchedule(schedule);
        return;
      }

      if (due === "secure-relay") {
        const state = this.secureRelayState;
        if (!state || !this.secureRoomAuthPublicKey) {
          delete schedule["secure-relay"];
          await this.saveAlarmSchedule(schedule);
          return;
        }
        const transition = advanceSecureRelayV4(state, {
          now,
          nextGrantTokenId: generateSecureRelayIdV4(),
        });
        if (!transition.ok) {
          await this.syncSecureRelayAlarm(state);
          return;
        }
        await this.persistSecureRelayState(transition.state, this.secureRoomAuthPublicKey);
        this.dispatchSecureEffects(transition.effects);
        if (transition.state.lifecycle === "retired") {
          for (const socket of this.state.getWebSockets()) {
            if (this.att(socket).protocol === "v4") try { socket.close(1000, "room retired"); } catch {}
          }
        }
        return;
      }

      if (due === "idle") {
        this.log("idle timeout — destroying");
        await this.destroyRoom("the fort went quiet for too long");
        return;
      }

      await this.saveAlarmSchedule(schedule);
    });
  }

  // --- helpers ---

  private att(ws: WebSocket): WSData {
    return (ws.deserializeAttachment() || {
      name: "",
      hash: "0000",
      isHost: false,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
    }) as WSData;
  }

  private send(ws: WebSocket, type: string, payload: Record<string, unknown> = {}) {
    try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
  }

  private sendSecure(ws: WebSocket, frame: SecureAuthChallengeFrameV4 | SecureServerFrameV4) {
    try { ws.send(JSON.stringify(frame)); } catch {}
  }

  private sendSecureError(ws: WebSocket, code: SecureServerErrorCodeV4) {
    this.sendSecure(ws, { kind: "secure-server", v: 4, suite: 1, type: "error", code });
  }

  private secureSocketForDevice(deviceId: string): WebSocket | null {
    const member = this.secureRelayState?.members.find((candidate) => candidate.deviceId === deviceId);
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.att(socket);
      if (attachment.secureAuthenticated && attachment.protocol === "v4"
        && attachment.secureDeviceId === deviceId
        && attachment.secureConnectionId === member?.connectionId) return socket;
    }
    return null;
  }

  private closeSecureSocketsForDevice(deviceId: string, reason: string) {
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.att(socket);
      if (!attachment.secureAuthenticated || attachment.protocol !== "v4"
        || attachment.secureDeviceId !== deviceId) continue;
      // Prevent the close callback from attempting a second relay transition
      // for an identity that the committed state has already retired.
      attachment.secureAuthenticated = false;
      socket.serializeAttachment(attachment);
      try { socket.close(1008, reason); } catch {}
    }
  }

  private sendSecureToDevice(deviceId: string, frame: SecureServerFrameV4) {
    const socket = this.secureSocketForDevice(deviceId);
    if (socket) this.sendSecure(socket, frame);
  }

  private broadcastSecure(frame: SecureServerFrameV4) {
    for (const member of this.secureRelayState?.members || []) {
      this.sendSecureToDevice(member.deviceId, frame);
    }
  }

  /**
   * Terminal room state has already been durably committed with every
   * connection id cleared. Route the content-free retirement notice to the
   * authenticated sockets currently attached to this object, while still
   * requiring that their device identity belongs to the retired room.
   */
  private broadcastSecureTerminal(frame: Extract<SecureServerFrameV4, { type: "room-retired" }>) {
    const memberIds = new Set((this.secureRelayState?.members || []).map((member) => member.deviceId));
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.att(socket);
      if (!attachment.secureAuthenticated || attachment.protocol !== "v4" ||
          !attachment.secureDeviceId || !memberIds.has(attachment.secureDeviceId)) continue;
      this.sendSecure(socket, frame);
    }
  }

  private dispatchSecureEffects(effects: readonly SecureRelayEffectV4[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case "deliver-key-package":
          this.sendSecureToDevice(effect.toDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "deliver-key-package",
            fromDeviceId: effect.fromDeviceId, admissionId: effect.admissionId,
            hello: effect.hello, memberBinding: effect.memberBinding,
          });
          break;
        case "route-relay":
          for (const deviceId of effect.toDeviceIds) {
            this.sendSecureToDevice(deviceId, {
              kind: "secure-server", v: 4, suite: 1, type: "relay",
              fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
            });
          }
          break;
        case "application-preview":
          this.sendSecureToDevice(effect.toHostDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "application-preview",
            fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
          });
          break;
        case "commit-preview":
          this.sendSecureToDevice(effect.toHostDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "commit-preview",
            fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
          });
          break;
        case "admission-proof-preview":
          this.sendSecureToDevice(effect.toHostDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "admission-proof-preview",
            fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
          });
          break;
        case "order-granted":
          this.sendSecureToDevice(effect.toDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "order-granted", grant: effect.grant,
          });
          break;
        case "order-expired":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "order-expired", tokenId: effect.tokenId,
          });
          break;
        case "order-cancelled":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "order-cancelled",
            requestId: effect.requestId, reason: effect.reason,
          });
          break;
        case "frame-accepted":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "frame-accepted", messageId: effect.messageId,
          });
          break;
        case "application-accepted":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "application-result",
            messageId: effect.messageId, logicalOrder: effect.logicalOrder, result: "accepted", reason: null,
          });
          break;
        case "application-rejected":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "application-result",
            messageId: effect.messageId, logicalOrder: effect.logicalOrder,
            result: "rejected", reason: effect.reason,
          });
          break;
        case "commit-rejected":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "commit-rejected",
            messageId: effect.messageId, reason: effect.reason,
          });
          break;
        case "replay-backlog": { // Split the persisted batch into bounded canonical server frames.
          for (const entry of effect.entries) {
            if (entry.kind === "relay") {
              this.sendSecureToDevice(effect.toDeviceId, {
                kind: "secure-server", v: 4, suite: 1, type: "relay",
                fromDeviceId: entry.fromDeviceId, frame: entry.frame, logicalOrder: entry.logicalOrder,
              });
            } else if (entry.kind === "application-result") {
              this.sendSecureToDevice(effect.toDeviceId, {
                kind: "secure-server", v: 4, suite: 1, type: "application-result",
                messageId: entry.messageId, logicalOrder: entry.logicalOrder,
                result: entry.result, reason: entry.reason,
              });
            } else if (entry.kind === "commit-result") {
              this.sendSecureToDevice(effect.toDeviceId, entry.result === "accepted"
                ? {
                    kind: "secure-server", v: 4, suite: 1, type: "frame-accepted",
                    messageId: entry.messageId,
                  }
                : {
                    kind: "secure-server", v: 4, suite: 1, type: "commit-rejected",
                    messageId: entry.messageId, reason: entry.reason!,
                  });
            } else {
              this.sendSecureToDevice(effect.toDeviceId, {
                kind: "secure-server", v: 4, suite: 1, type: "host-transfer-authorized",
                fromHostDeviceId: entry.fromHostDeviceId,
                authorizationId: entry.authorizationId,
                offerMessageId: entry.offerMessageId,
                expiresAt: entry.expiresAt,
              });
            }
          }
          break;
        }
        case "backlog-end":
          this.sendSecureToDevice(effect.toDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "backlog-end",
            lastMessageId: effect.lastMessageId,
          });
          break;
        case "room-state-snapshot":
          this.sendSecureToDevice(effect.toDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "room-state-snapshot",
            hostDeviceId: effect.hostDeviceId,
            members: effect.members,
            pendingHostTransfer: effect.pendingHostTransfer,
          });
          break;
        case "host-transfer-authorized":
          this.sendSecureToDevice(effect.toDeviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "host-transfer-authorized",
            fromHostDeviceId: effect.fromHostDeviceId,
            authorizationId: effect.authorizationId,
            offerMessageId: effect.offerMessageId,
            expiresAt: effect.expiresAt,
          });
          break;
        case "host-transfer-expired":
          for (const deviceId of effect.deviceIds) {
            this.sendSecureToDevice(deviceId, {
              kind: "secure-server", v: 4, suite: 1, type: "host-transfer-expired",
              authorizationId: effect.authorizationId,
            });
          }
          break;
        case "fresh-admission-required":
          this.sendSecureToDevice(effect.deviceId, {
            kind: "secure-server", v: 4, suite: 1, type: "fresh-admission-required", deviceId: effect.deviceId,
          });
          break;
        case "zombie-removal-required": {
          for (const deviceId of effect.toDeviceIds) {
            this.sendSecureToDevice(deviceId, {
              kind: "secure-server", v: 4, suite: 1, type: "zombie-removal-required",
              deviceId: effect.deviceId, admissionCommitMessageId: effect.admissionCommitMessageId,
            });
          }
          break;
        }
        case "member-lifecycle":
          this.broadcastSecure({
            kind: "secure-server", v: 4, suite: 1, type: "member-lifecycle",
            deviceId: effect.deviceId, status: effect.status,
          });
          if (effect.status === "retired") {
            this.closeSecureSocketsForDevice(effect.deviceId, "membership ended");
          }
          break;
        case "host-changed":
          this.broadcastSecure({
            kind: "secure-server", v: 4, suite: 1, type: "host-changed", deviceId: effect.deviceId,
          });
          break;
        case "room-retired":
          this.broadcastSecureTerminal({
            kind: "secure-server", v: 4, suite: 1, type: "room-retired",
          });
          break;
        default: {
          const unsupportedEffect: never = effect;
          throw new Error(`unsupported secure relay effect: ${String(unsupportedEffect)}`);
        }
      }
    }
  }

  private broadcast(type: string, payload: Record<string, unknown> = {}, exclude?: WebSocket) {
    const msg = JSON.stringify({ type, ...payload });
    for (const w of this.state.getWebSockets()) {
      if (w !== exclude && !!this.att(w).name) try { w.send(msg); } catch {}
    }
  }

  private emitLeaderboards(exclude?: WebSocket) {
    this.broadcast("leaderboards", { leaderboards: this.leaderboards }, exclude);
  }

  private gameQueueSnapshot(): RoomGameQueue {
    return {
      current: this.activeGame ? { ...this.activeGame } : null,
      queue: this.gameQueue.map((q) => ({ ...q })),
    };
  }

  private activeGameSnapshot(name: string) {
    if (this.rpsGame && (this.rpsGame.p1 === name || this.rpsGame.p2 === name)) {
      return { kind: "rps", p1: this.rpsGame.p1, p2: this.rpsGame.p2, phase: this.rpsGame.phase, koth: this.rpsGame.koth, myPick: this.rpsGame.p1 === name ? this.rpsGame.pick1 : this.rpsGame.pick2 };
    }
    if (this.tttGame && (this.tttGame.p1 === name || this.tttGame.p2 === name)) {
      return { kind: "ttt", p1: this.tttGame.p1, p2: this.tttGame.p2, phase: this.tttGame.phase, board: [...this.tttGame.board], turn: this.tttGame.turn };
    }
    return undefined;
  }

  private fortPassSnapshot(): { themePack?: string } | undefined {
    if (!this.fortPassEntitlement || !isFortPassActive(this.fortPassEntitlement)) return undefined;
    return this.fortPassEntitlement.perks.themePack
      ? { themePack: this.fortPassEntitlement.perks.themePack }
      : undefined;
  }

  private emitGameQueue(exclude?: WebSocket) {
    this.broadcast("game-queue", { gameQueue: this.gameQueueSnapshot() }, exclude);
  }

  private sameGameRequest(a: GameQueueItem, b: GameQueueItem): boolean {
    return a.kind === b.kind && a.by === b.by && (a.target || "") === (b.target || "");
  }

  private queueGame(req: GameQueueItem, ws?: WebSocket): boolean {
    if (this.activeGame && this.sameGameRequest(this.activeGame, req)) return false;
    if (this.gameQueue.some((q) => this.sameGameRequest(q, req))) return false;
    if (this.gameQueue.length >= MAX_GAME_QUEUE) {
      if (ws) this.send(ws, "error", { message: "game queue is full" });
      return false;
    }
    this.gameQueue.push(req);
    this.emitGameQueue();
    if (ws) this.send(ws, "game-queued", { ...req, position: this.gameQueue.length });
    return true;
  }

  private setActiveGame(current: GameQueueItem | null) {
    this.activeGame = current;
    this.emitGameQueue();
  }

  private clearActiveGame(drain = true) {
    if (!this.activeGame) return;
    this.activeGame = null;
    this.emitGameQueue();
    if (drain) this.drainGameQueue();
  }

  private pruneGameQueue() {
    const nowMembers = new Set(this.getMembers());
    const next = this.gameQueue.filter((q) => nowMembers.has(q.by) && (!q.target || nowMembers.has(q.target)));
    if (next.length !== this.gameQueue.length) {
      this.gameQueue = next;
      this.emitGameQueue();
    }
  }

  private cancelActiveGamesForMember(name: string) {
    let cancelled = false;
    if (this.activeVote?.target === name || this.activeVote?.starter === name) {
      clearTimeout(this.activeVote.timer);
      this.broadcast("vote-result", {
        target: this.activeVote.target,
        yes: this.activeVote.yes.size,
        no: this.activeVote.no.size,
        ejected: false,
      });
      this.activeVote = null;
      cancelled = true;
    } else if (this.activeVote) {
      this.activeVote.yes.delete(name);
      this.activeVote.no.delete(name);
      const eligible = this.getMembers().filter((member) => member !== this.activeVote!.target).length;
      const total = this.activeVote.yes.size + this.activeVote.no.size;
      if (total >= eligible) this.resolveVote();
    }
    if (this.rpsGame && (this.rpsGame.p1 === name || this.rpsGame.p2 === name)) {
      if (this.rpsGame.timer) clearTimeout(this.rpsGame.timer);
      this.broadcast("rps-declined", { from: name });
      this.rpsGame = null;
      this.kothGame = null;
      cancelled = true;
    }
    if (this.tttGame && (this.tttGame.p1 === name || this.tttGame.p2 === name)) {
      if (this.tttGame.timer) clearTimeout(this.tttGame.timer);
      this.broadcast("ttt-declined", { from: name });
      this.tttGame = null;
      cancelled = true;
    }
    if (this.saboteurActive && this.saboteur === name) {
      this.saboteurActive = false;
      this.sabCanStrike = false;
      this.saboteur = null;
      if (this.sabVote) {
        clearTimeout(this.sabVote.timer);
        this.sabVote = null;
      }
      this.broadcast("sab-vote-result", {
        accuser: "the fort",
        accused: name,
        yes: 0,
        no: 0,
        passed: true,
        wasSaboteur: true,
        saboteur: name,
      });
      cancelled = true;
    } else if (this.sabVote && (this.sabVote.accuser === name || this.sabVote.suspect === name)) {
      clearTimeout(this.sabVote.timer);
      this.broadcast("sab-vote-result", { accuser: this.sabVote.accuser, accused: this.sabVote.suspect, yes: this.sabVote.yes.size, no: this.sabVote.no.size, passed: false, wasSaboteur: false, saboteur: null, cancelled: true });
      this.sabVote = null;
    } else if (this.sabVote) {
      this.sabVote.yes.delete(name);
      this.sabVote.no.delete(name);
      if (this.sabVote.yes.size + this.sabVote.no.size >= this.getMembers().length) this.resolveSabVote();
    }
    if (cancelled) this.clearActiveGame();
  }

  private drainGameQueue() {
    if (this.activeGame) return;
    while (this.gameQueue.length > 0) {
      const req = this.gameQueue.shift()!;
      const nowMembers = this.getMembers();
      if (!nowMembers.includes(req.by)) continue;
      if (req.target && !nowMembers.includes(req.target)) continue;
      let started = false;
      switch (req.kind) {
        case "vote":
          started = !!(req.target && this.startVote(req.by, req.target));
          break;
        case "rps":
          started = !!(req.target && this.startRps(req.by, req.target));
          break;
        case "ttt":
          started = !!(req.target && this.startTtt(req.by, req.target));
          break;
        case "saboteur":
          started = this.startSaboteur(req.by);
          break;
        case "koth":
          started = this.startKoth(req.by);
          break;
      }
      if (started) return;
    }
    this.emitGameQueue();
  }

  private bumpLeaderboard(game: keyof RoomLeaderboards, name: string, amount = 1) {
    if (!name) return;
    this.leaderboards[game][name] = (this.leaderboards[game][name] || 0) + amount;
  }

  private getHost(): WebSocket | null {
    for (const w of this.state.getWebSockets()) {
      if (this.att(w).isHost) return w;
    }
    return null;
  }

  private getMembers(): string[] {
    const names: string[] = [];
    for (const w of this.state.getWebSockets()) {
      const a = this.att(w);
      if (a.name) {
        if (a.isHost) names.unshift(a.name);
        else names.push(a.name);
      }
    }
    return names;
  }

  private presenceOf(a: WSData): { status: "available" | "away"; awayText?: string } {
    const p: { status: "available" | "away"; awayText?: string } = { status: a.status || "available" };
    if (a.status === "away" && a.awayText) p.awayText = a.awayText;
    return p;
  }

  private getPresenceMap(): Record<string, { status: "available" | "away"; awayText?: string }> {
    const out: Record<string, { status: "available" | "away"; awayText?: string }> = {};
    for (const w of this.state.getWebSockets()) {
      const a = this.att(w);
      if (a.name) out[a.name] = this.presenceOf(a);
    }
    return out;
  }

  private async loadAlarmSchedule(): Promise<RoomAlarmSchedule> {
    return normalizeRoomAlarmSchedule(await this.state.storage.get<RoomAlarmSchedule>(ALARM_SCHEDULE_KEY));
  }

  private async saveAlarmSchedule(schedule: RoomAlarmSchedule) {
    const clean = normalizeRoomAlarmSchedule(schedule);
    const nextDeadline = nextRoomAlarmDeadline(clean);
    if (nextDeadline === null) {
      await this.state.storage.delete(ALARM_SCHEDULE_KEY);
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.state.storage.put(ALARM_SCHEDULE_KEY, clean);
    await this.state.storage.setAlarm(nextDeadline);
  }

  private async setAlarmDeadline(kind: RoomAlarmKind, deadline: number) {
    const schedule = await this.loadAlarmSchedule();
    schedule[kind] = deadline;
    await this.saveAlarmSchedule(schedule);
  }

  private async syncSecureRelayAlarm(state: SecureRelayStateV4) {
    const schedule = await this.loadAlarmSchedule();
    const deadline = nextSecureRelayDeadlineV4(state);
    if (deadline === null) delete schedule["secure-relay"];
    else schedule["secure-relay"] = deadline;
    await this.saveAlarmSchedule(schedule);
  }

  private async resetIdle() {
    await this.setAlarmDeadline("idle", Date.now() + fortPassIdleMs(this.fortPassEntitlement, IDLE_MS));
  }

  private async scheduleSabBomb(saboteur: string) {
    const deadline = Date.now() + SAB_BOMB_MS;
    await this.state.storage.put(SAB_BOMB_KEY, { saboteur, deadline, durationMs: SAB_BOMB_MS } satisfies SabBombState);
    await this.setAlarmDeadline("sab-bomb", deadline);
    this.broadcast("sab-bomb-start", { saboteur, seconds: SAB_BOMB_SECONDS, durationMs: SAB_BOMB_MS });
  }

  private async destroyRoom(reason: string) {
    const [rawRedemption, rawPreGrantRevocation] = await Promise.all([
      this.state.storage.get<unknown>(FORT_PASS_REDEMPTION_KEY),
      this.state.storage.get<unknown>(FORT_PASS_PREGRANT_REVOCATION_KEY),
    ]);
    const redemption = rawRedemption === undefined
      ? null
      : parseFortPassRedemptionRecord(rawRedemption);
    const preGrantRevocation = rawPreGrantRevocation === undefined
      ? null
      : parseFortPassPreGrantRevocation(rawPreGrantRevocation);
    if ((rawRedemption !== undefined && !redemption)
      || (rawPreGrantRevocation !== undefined && !preGrantRevocation)) {
      throw new Error("room payment state is corrupt");
    }
    this.log("destroying room");
    if (this.sabVote) {
      clearTimeout(this.sabVote.timer);
      this.sabVote = null;
    }
    if (this.rpsGame?.timer) clearTimeout(this.rpsGame.timer);
    if (this.tttGame?.timer) clearTimeout(this.tttGame.timer);
    // clear all grace timers
    for (const [, disc] of this.disconnected) clearTimeout(disc.timer);
    this.disconnected.clear();
    if (this.secureRelayState) {
      this.broadcastSecureTerminal({
        kind: "secure-server", v: 4, suite: 1, type: "room-retired",
      });
    } else {
      this.broadcast("knocked-down", { reason });
    }
    for (const w of this.state.getWebSockets()) {
      try { w.close(1000, reason); } catch {}
    }
    await this.state.storage.transaction(async (transaction) => {
      await transaction.deleteAlarm();
      const stored = await transaction.list();
      const disposableKeys = [...stored.keys()].filter((key) => key !== FORT_PASS_REDEMPTION_KEY
        && key !== FORT_PASS_PREGRANT_REVOCATION_KEY);
      if (disposableKeys.length) await transaction.delete(disposableKeys);
      if (redemption) await transaction.put(FORT_PASS_REDEMPTION_KEY, redemption);
      if (preGrantRevocation) {
        await transaction.put(FORT_PASS_PREGRANT_REVOCATION_KEY, preGrantRevocation);
      }
    });
    this.authPublicKey = null;
    this.secureRelayState = null;
    this.secureRelayManifest = null;
    this.secureRoomAuthPublicKey = null;
    this.secureRoomFrameTimestamps = [];
    this.secureRoomFrameBudgetInitialized = false;
    this.secureStateCorrupt = false;
    this.legacyAuthBlocked = false;
    this.roomId = "";
    this.fortPassEntitlement = null;
    this.roomTheme = "away-message";
    this.tossPillowFrom = null;
  }

  // --- handlers ---

  private withAuthLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.authQueue.then(operation, operation);
    this.authQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async loadAuthFailureBuckets(now: number): Promise<AuthFailureBuckets> {
    const stored = await this.state.storage.get<AuthFailureBuckets>(AUTH_FAILURE_BUCKETS_KEY);
    const buckets: AuthFailureBuckets = {};
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return buckets;
    for (const [key, timestamps] of Object.entries(stored)) {
      if (Object.keys(buckets).length >= MAX_AUTH_FAILURE_BUCKETS) break;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || !Array.isArray(timestamps)) continue;
      const recent = timestamps.slice(-MAX_AUTH_FAILURES_PER_MINUTE)
        .filter(timestamp => Number.isFinite(timestamp) && timestamp <= now + 60_000 && now - timestamp < 60_000)
        .slice(-MAX_AUTH_FAILURES_PER_MINUTE);
      if (recent.length) buckets[key] = recent;
    }
    return buckets;
  }

  private async persistAuthFailureBuckets(buckets: AuthFailureBuckets) {
    if (Object.keys(buckets).length) await this.state.storage.put(AUTH_FAILURE_BUCKETS_KEY, buckets);
    else await this.state.storage.delete(AUTH_FAILURE_BUCKETS_KEY);
  }

  private rejectAuthentication(ws: WebSocket, message = "authentication failed") {
    this.send(ws, "error", { message });
    try { ws.close(1008, "authentication failed"); } catch {}
  }

  private async authenticate(ws: WebSocket, action: RoomAuthAction, name: string, auth: unknown): Promise<boolean> {
    const a = this.att(ws);
    if (a.authAttempted || !a.authChallenge || !a.authChallengeExpiresAt) return false;
    a.authAttempted = true;
    const challenge = a.authChallenge;
    const expiresAt = a.authChallengeExpiresAt;
    a.authChallenge = undefined;
    a.authChallengeExpiresAt = undefined;
    ws.serializeAttachment(a);

    return this.withAuthLock(async () => {
      const source = a.ip || "unknown";
      const now = Date.now();
      const buckets = await this.loadAuthFailureBuckets(now);
      const failures = buckets[source] || [];
      if (failures.length >= MAX_AUTH_FAILURES_PER_MINUTE) {
        await this.persistAuthFailureBuckets(buckets);
        return false;
      }
      if (!buckets[source] && Object.keys(buckets).length >= MAX_AUTH_FAILURE_BUCKETS) {
        await this.persistAuthFailureBuckets(buckets);
        return false;
      }

      const ok = now <= expiresAt && await verifyRoomAuthProof({
        auth: auth as RoomAuthPayloadV2,
        action,
        roomId: this.roomId,
        name,
        expectedChallenge: challenge,
        storedPublicKey: this.authPublicKey,
      });
      if (ok) delete buckets[source];
      else buckets[source] = [...failures, now].slice(-MAX_AUTH_FAILURES_PER_MINUTE);
      await this.persistAuthFailureBuckets(buckets);
      return ok;
    });
  }

  private async onSetUp(ws: WebSocket, msg: {
    name?: string;
    auth?: unknown;
    fortPassSessionId?: unknown;
    fortPassClaimSecret?: unknown;
  }) {
    if (this.setupInProgress) {
      this.metric("room_setup_failed", "exists");
      return this.send(ws, "error", { message: "fort already exists" });
    }
    this.setupInProgress = true;
    try {
    const requestedName = typeof msg.name === "string" ? msg.name : "";
    // An existing room must reject setup before verifying an attacker-chosen
    // setup key. A valid setup proof is not room admission and must never clear
    // failed join attempts for the same source.
    if (this.authPublicKey || this.secureRelayManifest || this.secureStateCorrupt || this.legacyAuthBlocked || this.getHost()) {
      this.metric("room_setup_failed", "exists");
      return this.send(ws, "error", { message: "fort already exists" });
    }
    const rawReservation = await this.state.storage.get<unknown>(FORT_PASS_RESERVATION_KEY);
    const reservation = rawReservation === undefined ? null : parseFortPassReservation(rawReservation);
    if (rawReservation !== undefined && !reservation) {
      this.metric("room_setup_failed", "state_invalid");
      return this.send(ws, "error", { message: "room state unavailable" });
    }
    if (reservation && reservation.expiresAt <= Date.now() && reservation.sessionId === null) {
      await this.state.storage.delete(FORT_PASS_RESERVATION_KEY);
    } else if (reservation && reservation.expiresAt > Date.now()
      && (!this.fortPassEntitlement || !isFortPassActive(this.fortPassEntitlement))) {
      this.metric("room_setup_failed", "exists");
      return this.send(ws, "error", { message: "fort already exists" });
    }
    if (!await this.authenticate(ws, "set-up", requestedName, msg.auth)) {
      this.metric("room_setup_failed", "bad_auth");
      return this.rejectAuthentication(ws);
    }
    const normalizedName = normalizeAuthName(requestedName);
    if (!normalizedName) {
      this.metric("room_setup_failed", "bad_auth");
      return this.rejectAuthentication(ws, "name and password required");
    }
    if (!isGeneratedFreeRoomId(this.roomId) && (
      !fortPassAllowsCustomRoomCode(this.fortPassEntitlement, this.roomId)
      || !await fortPassSetupClaimMatches(
        this.state.storage,
        this.roomId,
        this.fortPassEntitlement,
        msg.fortPassSessionId,
        msg.fortPassClaimSecret,
      )
    )) {
      this.metric("room_setup_failed", "paid_redemption");
      return this.send(ws, "error", { message: "paid room redemption required" });
    }
    if (this.env.ROOM) {
      const source = this.att(ws);
      const creationSource = source.creationSource || source.ip || "unknown";
      source.creationSource = undefined;
      ws.serializeAttachment(source);
      const limiterId = this.env.ROOM.idFromName(
        `__create_limit__:${creationSource}`,
      );
      const limitUrl = new URL(ROOM_CREATE_LIMIT_PATH, "https://pillowfort.internal");
      const limited = await this.env.ROOM.get(limiterId).fetch(new Request(limitUrl, { method: "POST" }));
      if (limited.status !== 204) {
        this.metric("room_setup_failed", "rate_limited");
        return this.send(ws, "error", { message: "slow down — too many forts" });
      }
    }

    const name = normalizedName;
    const authPublicKey = (msg.auth as RoomAuthPayloadV2).publicKey!;
    const [persistedSecureManifest, persistedLegacyKey, persistedLegacyBlocked] = await Promise.all([
      this.state.storage.get<unknown>(SECURE_RELAY_MANIFEST_KEY_V4),
      this.state.storage.get<unknown>("authPublicKey"),
      this.state.storage.get<unknown>(LEGACY_AUTH_BLOCKED_KEY),
    ]);
    if (persistedSecureManifest !== undefined || persistedLegacyKey !== undefined
      || persistedLegacyBlocked === true || this.secureRelayState || this.secureRelayManifest) {
      this.metric("room_setup_failed", "exists");
      return this.send(ws, "error", { message: "fort already exists" });
    }
    await this.state.storage.put("authPublicKey", authPublicKey);
    this.authPublicKey = authPublicKey;

    const prev = this.att(ws);
    const data: WSData = {
      name,
      hash: prev.hash,
      isHost: true,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
      protocol: "legacy",
    };
    ws.serializeAttachment(data);

    this.log("legacy room created");
    this.send(ws, "room-created", {
      room: this.roomId,
      leaderboards: this.leaderboards,
      gameQueue: this.gameQueueSnapshot(),
      theme: this.roomTheme,
      fortPass: this.fortPassSnapshot(),
    });
    await this.resetIdle();
    } finally {
      this.setupInProgress = false;
    }
  }

  private async onJoin(ws: WebSocket, msg: { name?: string; auth?: unknown }, alreadyAuthenticated = false) {
    const requestedName = typeof msg.name === "string" ? msg.name : "";
    if (!alreadyAuthenticated && !await this.authenticate(ws, "join", requestedName, msg.auth)) {
      this.metric("room_join_failed", "wrong_password");
      return this.rejectAuthentication(ws);
    }
    const normalizedName = normalizeAuthName(requestedName);
    if (!normalizedName) {
      this.metric("room_join_failed", "bad_auth");
      return this.rejectAuthentication(ws, "name and password required");
    }
    if (!this.getHost()) {
      this.metric("room_join_failed", "not_found");
      return this.send(ws, "error", { message: "fort not found" });
    }

    const registered = this.state.getWebSockets().filter(w => this.att(w).name);
    if (registered.length > MAX_GUESTS) {
      this.metric("room_join_failed", "full");
      return this.send(ws, "error", { message: "fort is full (20 max)" });
    }

    const name = uniqueName(normalizedName, new Set(this.getMembers()));
    const prev = this.att(ws);
    ws.serializeAttachment({
      name,
      hash: prev.hash,
      isHost: false,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
      protocol: "legacy",
    } as WSData);

    this.log("legacy member joined");
    this.send(ws, "joined", {
      room: this.roomId,
      members: this.getMembers(),
      name,
      presence: this.getPresenceMap(),
      leaderboards: this.leaderboards,
      gameQueue: this.gameQueueSnapshot(),
      theme: this.roomTheme,
      fortPass: this.fortPassSnapshot(),
    });
    this.broadcast("member-joined", { name, presence: this.presenceOf(this.att(ws)) }, ws);
    await this.resetIdle();
  }

  private async onChat(ws: WebSocket, msg: { enc?: unknown }) {
    const a = this.att(ws);
    if (!a.name) return;

    const now = Date.now();
    a.msgTimestamps = a.msgTimestamps.filter(t => now - t < 5000);
    if (a.msgTimestamps.length >= RATE_MSGS_PER_5S)
      return this.send(ws, "error", { message: "slow down" });

    a.msgTimestamps.push(now);
    ws.serializeAttachment(a);

    const enc = sanitizeEncryptedChat(msg.enc);
    if (enc) {
      // Text and presentation metadata are authenticated together inside the
      // encrypted envelope. Never forward unauthenticated outer fields.
      this.broadcast("message", { from: a.name, enc });
      await this.resetIdle();
      return;
    }

    return this.send(ws, "error", { message: "encrypted chat required" });
  }

  private async onKnockDown(ws: WebSocket) {
    if (!this.att(ws).isHost) return;
    const a = this.att(ws);
    this.log("legacy room closed by host");
    await this.destroyRoom("host knocked it down");
  }

  private async onLeave(ws: WebSocket) {
    // intentional leave — immediate removal, no grace period
    await this.onDisconnect(ws);
  }

  private onTyping(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;
    this.broadcast("typing", { name: a.name }, ws);
  }

  private async onSetStatus(ws: WebSocket, msg: { status?: string; awayText?: string }) {
    const a = this.att(ws);
    if (!a.name) return;
    if (msg.status !== "available" && msg.status !== "away") return;

    a.status = msg.status;
    if (a.status === "away") {
      const text = typeof msg.awayText === "string" ? msg.awayText.trim().slice(0, 120) : "";
      a.awayText = text || null;
    } else {
      a.awayText = null;
    }
    ws.serializeAttachment(a);

    this.broadcast("member-status", { name: a.name, status: a.status, awayText: a.awayText });
    await this.resetIdle();
  }

  private async onSetTheme(ws: WebSocket, msg: { theme?: unknown }) {
    const a = this.att(ws);
    if (!a.name || !a.isHost) return;
    const theme = normalizeRoomTheme(msg.theme);
    if (!theme) return this.send(ws, "error", { message: "invalid theme" });
    if (!fortPassAllowsRoomTheme(this.fortPassEntitlement, theme)) {
      return this.send(ws, "error", { message: "Fort Pass required" });
    }
    this.roomTheme = theme;
    await this.state.storage.put(ROOM_THEME_KEY, theme);
    this.broadcast("room-theme", { theme });
    await this.resetIdle();
  }

  private async offerHost(oldHostName: string) {
    const candidates = this.state.getWebSockets().filter(w => {
      const d = this.att(w);
      return d.name && !d.isHost && !d.hostRejected;
    });

    if (candidates.length === 0) {
      await this.destroyRoom("nobody caught the pillow");
      return;
    }

    const pick = candidates[randomIndex(candidates.length)];
    const pickData = this.att(pick);
    this.log("legacy host transfer offered");
    this.send(pick, "host-offer", { oldHost: oldHostName });
    this.broadcast("host-offered", { name: pickData.name }, pick);
  }

  private onTossPillow(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !a.isHost || !msg.target) return;

    // find target
    let targetWs: WebSocket | null = null;
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.name === msg.target && !d.isHost) { targetWs = w; break; }
    }
    if (!targetWs) return;

    // demote host to guest
    this.tossPillowFrom = a.name;
    a.isHost = false;
    ws.serializeAttachment(a);

    // send offer to specific target
    this.send(targetWs, "host-offer", { oldHost: a.name });
    this.broadcast("host-offered", { name: msg.target }, targetWs);
  }

  private onDraw(ws: WebSocket, msg: { color?: string; pts?: number[][]; s?: number }) {
    const a = this.att(ws);
    if (!a.name) return;
    const now = Date.now();
    a.drawTimestamps = (a.drawTimestamps || []).filter(t => now - t < 5_000);
    if (a.drawTimestamps.length >= MAX_DRAW_EVENTS_PER_5S) return this.send(ws, "error", { message: "slow down" });
    const draw = sanitizeDraw(msg);
    if (!draw) return;
    a.drawTimestamps.push(now);
    ws.serializeAttachment(a);
    this.broadcast("draw", { from: a.name, ...draw }, ws);
  }

  private startVote(
    starter: string,
    target: string,
    opts?: { auto?: boolean; starterLabel?: string }
  ): boolean {
    if (this.activeVote) return false;
    if (!opts?.auto && starter === target) return false;
    const m = this.getMembers();
    if (!m.includes(target)) return false;
    if (!opts?.auto && !m.includes(starter)) return false;
    if (m.length < 3) return false;

    const endsAt = Date.now() + VOTE_DURATION_MS;
    this.activeVote = {
      target,
      starter,
      yes: opts?.auto ? new Set() : new Set([starter]),
      no: new Set(),
      auto: !!opts?.auto,
      endsAt,
      timer: setTimeout(() => this.resolveVote(), VOTE_DURATION_MS),
    };
    this.setActiveGame({ kind: "vote", by: starter, target });
    this.broadcast("vote-started", {
      target,
      starter: opts?.starterLabel || starter,
      duration: VOTE_DURATION_MS,
      endsAt,
      ...(opts?.auto ? { auto: true } : {}),
    });
    return true;
  }

  private startRps(p1: string, p2: string): boolean {
    if (this.rpsGame) return false;
    const m = this.getMembers();
    if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
    const tw = this.findWs(p2);
    if (!tw) return false;
    this.rpsGame = {
      p1,
      p2,
      phase: "pending",
      timer: setTimeout(() => {
        if (!this.rpsGame || this.rpsGame.p1 !== p1 || this.rpsGame.p2 !== p2 || this.rpsGame.phase !== "pending") return;
        this.broadcast("rps-declined", { from: p2 });
        this.rpsGame = null;
        this.kothGame = null;
        this.clearActiveGame();
      }, CHALLENGE_TIMEOUT_MS),
    };
    this.setActiveGame({ kind: "rps", by: p1, target: p2 });
    this.send(tw, "rps-challenged", { from: p1 });
    this.broadcast("rps-pending", { p1, p2 });
    return true;
  }

  private startTtt(p1: string, p2: string): boolean {
    if (this.tttGame) return false;
    const m = this.getMembers();
    if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
    const tw = this.findWs(p2);
    if (!tw) return false;
    this.tttGame = {
      p1,
      p2,
      phase: "pending",
      timer: setTimeout(() => {
        if (!this.tttGame || this.tttGame.p1 !== p1 || this.tttGame.p2 !== p2 || this.tttGame.phase !== "pending") return;
        this.broadcast("ttt-declined", { from: p2 });
        this.tttGame = null;
        this.clearActiveGame();
      }, CHALLENGE_TIMEOUT_MS),
      board: Array(9).fill(""),
      turn: 0,
    };
    this.setActiveGame({ kind: "ttt", by: p1, target: p2 });
    this.send(tw, "ttt-challenged", { from: p1 });
    this.broadcast("ttt-pending", { p1, p2 });
    return true;
  }

  private startSaboteur(starter: string): boolean {
    if (this.saboteurActive) return false;
    const members = this.getMembers();
    if (!members.includes(starter)) return false;
    if (members.length < SABOTEUR_MIN_PLAYERS) return false;

    this.saboteurActive = true;
    this.sabStrikes = 0;
    this.sabCanStrike = true;
    this.saboteur = members[randomIndex(members.length)];
    this.setActiveGame({ kind: "saboteur", by: starter });
    this.log("legacy saboteur game started");

    this.broadcast("sab-started", { starter });
    const sabWs = this.findWs(this.saboteur);
    if (sabWs) this.send(sabWs, "sab-role", { role: "saboteur", canStrike: true });
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.name && d.name !== this.saboteur) this.send(w, "sab-role", { role: "defender" });
    }
    return true;
  }

  private startKoth(challenger: string): boolean {
    const cw = this.findWs(challenger);
    if (!cw) return false;
    const cd = this.att(cw);
    if (cd.isHost) return false;
    if (this.rpsGame) return false;
    const hostWs = this.getHost();
    if (!hostWs) return false;
    const hostName = this.att(hostWs).name;
    if (!hostName) return false;

    this.kothGame = { challenger, host: hostName };
    this.rpsGame = {
      p1: challenger, p2: hostName, phase: "playing", koth: true,
      timer: setTimeout(() => {
        if (!this.rpsGame?.koth) return;
        this.broadcast("rps-declined", { from: "game timeout" });
        this.rpsGame = null;
        this.kothGame = null;
        this.clearActiveGame();
      }, GAME_PLAY_TIMEOUT_MS),
    };
    this.setActiveGame({ kind: "koth", by: challenger, target: hostName });
    this.broadcast("koth-started", { challenger, host: hostName });
    this.broadcast("rps-started", { p1: challenger, p2: hostName, koth: true });
    this.log("legacy king-of-the-hill game started");
    return true;
  }

  // ============ PILLOW FIGHT (vote to eject) ============

  private onStartVote(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target) return;
    if (msg.target === a.name) return this.send(ws, "error", { message: "you can't vote yourself out" });
    if (!this.getMembers().includes(msg.target)) return;
    if (this.getMembers().length < 3) return this.send(ws, "error", { message: "need at least 3 people to start a vote" });
    if (this.activeGame) {
      this.queueGame({ kind: "vote", by: a.name, target: msg.target }, ws);
      return;
    }
    if (this.activeVote) return this.send(ws, "error", { message: "a vote is already in progress" });

    if (this.startVote(a.name, msg.target)) {
      this.log("legacy vote started");
    } else {
      this.send(ws, "error", { message: "could not start vote right now" });
    }
  }

  private onCastVote(ws: WebSocket, msg: { vote?: string }) {
    const a = this.att(ws);
    if (!a.name || !this.activeVote) return;
    if (msg.vote !== "yes" && msg.vote !== "no") return;
    if (a.name === this.activeVote.target) return; // target can't vote
    if (this.activeVote.yes.has(a.name) || this.activeVote.no.has(a.name)) return; // already voted

    if (msg.vote === "yes") this.activeVote.yes.add(a.name);
    else this.activeVote.no.add(a.name);

    this.broadcast("vote-cast", { voter: a.name, vote: msg.vote });

    // check if everyone (except target) has voted
    const eligible = this.getMembers().filter(n => n !== this.activeVote!.target).length;
    const total = this.activeVote.yes.size + this.activeVote.no.size;
    if (total >= eligible) this.resolveVote();
  }

  private resolveVote() {
    if (!this.activeVote) return;
    clearTimeout(this.activeVote.timer);
    const { target, yes, no, starter, auto } = this.activeVote;
    const eligible = this.getMembers().filter((name) => name !== target).length;
    const ejected = voteHasMajority(yes.size, no.size, eligible);
    this.broadcast("vote-result", { target, yes: yes.size, no: no.size, ejected });
    this.log("legacy vote resolved");
    if (!auto) {
      if (ejected) this.bumpLeaderboard("pillowFight", starter);
      else this.bumpLeaderboard("pillowFight", target);
      this.emitLeaderboards();
    }

    if (ejected) {
      const currentHost = this.getHost();
      const ejectedHost = !!currentHost && this.att(currentHost).name === target;
      // kick the target
      for (const w of this.state.getWebSockets()) {
        if (this.att(w).name === target) {
          this.send(w, "ejected", { reason: "You were voted out of the fort!" });
          const d = this.att(w);
          d.name = "";
          d.isHost = false;
          w.serializeAttachment(d);
          try { w.close(1000, "ejected"); } catch {}
          break;
        }
      }
      this.broadcast("member-left", { name: target });
      this.pruneGameQueue();
      if (ejectedHost) void this.offerHost(target);
    }
    this.activeVote = null;
    this.clearActiveGame();
  }

  // ============ ROCK PAPER SCISSORS ============

  private findWs(name: string): WebSocket | null {
    for (const w of this.state.getWebSockets()) {
      if (this.att(w).name === name) return w;
    }
    return null;
  }

  private onRpsChallenge(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target || a.name === msg.target) return;
    if (this.activeGame) {
      this.queueGame({ kind: "rps", by: a.name, target: msg.target }, ws);
      return;
    }
    if (this.rpsGame) return this.send(ws, "error", { message: "a duel is already in progress" });
    if (!this.findWs(msg.target)) return;
    if (this.startRps(a.name, msg.target)) {
      this.log("legacy rock-paper-scissors game started");
    } else {
      this.send(ws, "error", { message: "could not start RPS right now" });
    }
  }

  private onRpsAccept(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.rpsGame || a.name !== this.rpsGame.p2) return;
    if (this.rpsGame.phase !== "pending") return;
    if (this.rpsGame.timer) clearTimeout(this.rpsGame.timer);
    this.rpsGame.timer = undefined;
    this.rpsGame.phase = "playing";
    this.rpsGame.timer = setTimeout(() => {
      if (!this.rpsGame || this.rpsGame.phase !== "playing") return;
      this.broadcast("rps-declined", { from: "game timeout" });
      this.rpsGame = null;
      this.kothGame = null;
      this.clearActiveGame();
    }, GAME_PLAY_TIMEOUT_MS);
    this.broadcast("rps-started", { p1: this.rpsGame.p1, p2: this.rpsGame.p2 });
  }

  private onRpsDecline(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.rpsGame || a.name !== this.rpsGame.p2) return;
    if (this.rpsGame.timer) clearTimeout(this.rpsGame.timer);
    this.broadcast("rps-declined", { from: a.name });
    this.rpsGame = null;
    if (this.kothGame) this.kothGame = null;
    this.clearActiveGame();
  }

  private onRpsPick(ws: WebSocket, msg: { pick?: string }) {
    const a = this.att(ws);
    if (!this.rpsGame || !msg.pick) return;
    if (this.rpsGame.phase !== "playing") return;
    if (!isRpsPick(msg.pick)) return;

    if (a.name === this.rpsGame.p1) {
      if (this.rpsGame.pick1) return;
      this.rpsGame.pick1 = msg.pick;
    } else if (a.name === this.rpsGame.p2) {
      if (this.rpsGame.pick2) return;
      this.rpsGame.pick2 = msg.pick;
    }
    else return;

    this.send(ws, "rps-picked", {}); // confirm to sender

    if (this.rpsGame.pick1 && this.rpsGame.pick2) {
      const { p1, p2, pick1, pick2 } = this.rpsGame;
      if (this.rpsGame.timer) clearTimeout(this.rpsGame.timer);
      const winner = rpsWinner(p1, p2, pick1, pick2);
      const isKoth = !!this.kothGame;
      this.broadcast("rps-result", { p1, p2, pick1, pick2, winner, koth: isKoth || undefined });
      this.log("legacy rock-paper-scissors game resolved");
      if (winner) {
        if (!isKoth) {
          this.bumpLeaderboard("rps", winner);
          this.emitLeaderboards();
        }
      }
      this.rpsGame = null;
      if (isKoth && winner) this.resolveKoth(winner);
      else if (isKoth) {
        this.kothGame = null; // draw = no change
        this.clearActiveGame();
      } else {
        this.clearActiveGame();
      }
    }
  }

  // ============ TIC-TAC-TOE ============

  private onTttChallenge(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target || a.name === msg.target) return;
    if (this.activeGame) {
      this.queueGame({ kind: "ttt", by: a.name, target: msg.target }, ws);
      return;
    }
    if (this.tttGame) return this.send(ws, "error", { message: "a game is already in progress" });
    if (!this.findWs(msg.target)) return;
    if (!this.startTtt(a.name, msg.target)) {
      this.send(ws, "error", { message: "could not start Tic-Tac-Toe right now" });
    }
  }

  private onTttAccept(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.tttGame || a.name !== this.tttGame.p2) return;
    if (this.tttGame.phase !== "pending") return;
    if (this.tttGame.timer) clearTimeout(this.tttGame.timer);
    this.tttGame.timer = undefined;
    this.tttGame.phase = "playing";
    this.tttGame.timer = setTimeout(() => {
      if (!this.tttGame || this.tttGame.phase !== "playing") return;
      this.broadcast("ttt-declined", { from: "game timeout" });
      this.tttGame = null;
      this.clearActiveGame();
    }, GAME_PLAY_TIMEOUT_MS);
    this.broadcast("ttt-started", { p1: this.tttGame.p1, p2: this.tttGame.p2, board: this.tttGame.board, turn: this.tttGame.turn });
  }

  private onTttDecline(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.tttGame || a.name !== this.tttGame.p2) return;
    if (this.tttGame.timer) clearTimeout(this.tttGame.timer);
    this.broadcast("ttt-declined", { from: a.name });
    this.tttGame = null;
    this.clearActiveGame();
  }

  private onTttMove(ws: WebSocket, msg: { cell?: number }) {
    const a = this.att(ws);
    if (!this.tttGame || msg.cell == null) return;
    const g = this.tttGame;
    if (g.phase !== "playing") return;
    const currentPlayer = g.turn % 2 === 0 ? g.p1 : g.p2;
    if (a.name !== currentPlayer) return;
    if (!Number.isInteger(msg.cell) || msg.cell < 0 || msg.cell > 8 || g.board[msg.cell]) return;

    g.board[msg.cell] = g.turn % 2 === 0 ? "X" : "O";
    g.turn++;
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      if (this.tttGame !== g) return;
      this.broadcast("ttt-declined", { from: "game timeout" });
      this.tttGame = null;
      this.clearActiveGame();
    }, GAME_PLAY_TIMEOUT_MS);

    // check win
    const mark = g.board[msg.cell];
    let winner: string | null = null;
    if (tttWinner(g.board, mark)) winner = a.name;
    const draw = !winner && g.board.every(c => c);

    this.broadcast("ttt-update", { board: g.board, turn: g.turn, lastMove: msg.cell, winner, draw });
    if (winner) {
      this.bumpLeaderboard("ttt", winner);
      this.emitLeaderboards();
    }
    if (winner || draw) {
      if (g.timer) clearTimeout(g.timer);
      this.log("legacy tic-tac-toe game resolved");
      this.tttGame = null;
      this.clearActiveGame();
    }
  }

  // ============ SECRET SABOTEUR ============

  private onSabStart(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;
    if (this.saboteurActive) return this.send(ws, "error", { message: "saboteur mode is already active" });
    const members = this.getMembers();
    if (members.length < SABOTEUR_MIN_PLAYERS)
      return this.send(ws, "error", { message: `need at least ${SABOTEUR_MIN_PLAYERS} people` });
    if (this.activeGame) {
      this.queueGame({ kind: "saboteur", by: a.name }, ws);
      return;
    }
    if (!this.startSaboteur(a.name)) {
      this.send(ws, "error", { message: "could not start Saboteur right now" });
    }
  }

  private onSabAccuse(ws: WebSocket, msg: { suspect?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.suspect || !this.saboteurActive) return;
    if (this.sabVote) return this.send(ws, "error", { message: "an accusation vote is already in progress" });
    if (a.name === this.saboteur) return this.send(ws, "error", { message: "saboteur can't accuse" });
    if (!this.getMembers().includes(msg.suspect)) return;
    if (msg.suspect === a.name) return this.send(ws, "error", { message: "you can't accuse yourself" });

    this.sabVote = {
      accuser: a.name,
      suspect: msg.suspect,
      yes: new Set([a.name]),
      no: new Set(),
      timer: setTimeout(() => this.resolveSabVote(), SABOTEUR_VOTE_MS),
    };
    this.broadcast("sab-vote-start", {
      accuser: a.name,
      suspect: msg.suspect,
      duration: SABOTEUR_VOTE_MS,
      endsAt: Date.now() + SABOTEUR_VOTE_MS,
    });
    this.log("legacy saboteur accusation started");
  }

  private onSabVote(ws: WebSocket, msg: { vote?: string }) {
    const a = this.att(ws);
    if (!a.name || !this.sabVote || !this.saboteurActive) return;
    if (msg.vote !== "yes" && msg.vote !== "no") return;

    this.sabVote.yes.delete(a.name);
    this.sabVote.no.delete(a.name);
    if (msg.vote === "yes") this.sabVote.yes.add(a.name);
    else this.sabVote.no.add(a.name);

    const total = this.sabVote.yes.size + this.sabVote.no.size;
    if (total >= this.getMembers().length) this.resolveSabVote();
  }

  private resolveSabVote() {
    if (!this.sabVote || !this.saboteurActive) return;
    clearTimeout(this.sabVote.timer);
    const { accuser, suspect, yes, no } = this.sabVote;
    const passed = yes.size > no.size;
    const correct = passed && suspect === this.saboteur;
    this.broadcast("sab-vote-result", {
      accuser,
      accused: suspect,
      yes: yes.size,
      no: no.size,
      passed,
      wasSaboteur: correct,
      saboteur: correct ? this.saboteur : null
    });
    this.log("legacy saboteur vote resolved");

    if (correct) {
      // saboteur caught!
      const sabName = this.saboteur!;
      for (const defender of this.getMembers()) {
        if (defender !== sabName) this.bumpLeaderboard("saboteur", defender);
      }
      this.emitLeaderboards();
      this.saboteurActive = false;
      this.sabCanStrike = false;
      this.saboteur = null;
      this.sabVote = null;

      // auto-start pillow fight vote against the caught saboteur
      this.clearActiveGame(false);
      if (!this.activeVote && this.getMembers().length >= 3 && this.getMembers().includes(sabName)) {
        this.startVote(sabName, sabName, { auto: true, starterLabel: "the fort" });
        this.log("legacy automatic vote started");
      } else {
        this.drainGameQueue();
      }
    } else {
      this.sabVote = null;
      if (!this.sabCanStrike && this.saboteur) {
        this.sabCanStrike = true;
        const sabWs = this.findWs(this.saboteur);
        if (sabWs) this.send(sabWs, "sab-strike-ready", { reason: "wrong-accusation" });
      }
    }
  }

  private async onSabStrike(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || !this.saboteurActive || a.name !== this.saboteur) return;
    if (!this.sabCanStrike) return this.send(ws, "error", { message: "you can strike after a wrong accusation vote" });

    this.sabCanStrike = false;
    this.sabStrikes++;
    this.broadcast("sab-strike", {
      strikes: this.sabStrikes,
      ...(this.sabStrikes >= 3 ? { saboteur: a.name } : {}),
    });
    this.log("legacy saboteur strike accepted");

    if (this.sabStrikes >= 3) {
      // The saboteur plants a bomb. Let chat continue during countdown.
      this.bumpLeaderboard("saboteur", a.name);
      this.emitLeaderboards();
      this.saboteurActive = false;
      this.sabCanStrike = false;
      this.saboteur = null;
      if (this.sabVote) { clearTimeout(this.sabVote.timer); this.sabVote = null; }
      await this.resetIdle();
      await this.scheduleSabBomb(a.name);
    }
  }

  // ============ KING OF THE HILL ============

  private kothGame: { challenger: string; host: string } | null = null;

  private onKothChallenge(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost) return this.send(ws, "error", { message: "only non-hosts can challenge" });
    const hostWs = this.getHost();
    if (!hostWs) return;
    if (this.activeGame) {
      this.queueGame({ kind: "koth", by: a.name, target: this.att(hostWs).name }, ws);
      return;
    }
    if (this.rpsGame) return this.send(ws, "error", { message: "a duel is already in progress" });
    if (!this.startKoth(a.name)) {
      this.send(ws, "error", { message: "could not start KOTH right now" });
    }
  }

  // Called from RPS result to swap host if challenger wins
  private resolveKoth(winner: string | null) {
    if (!this.kothGame) return;
    const { challenger, host } = this.kothGame;
    this.kothGame = null;

    if (winner === challenger) {
      // swap host
      const hostWs = this.findWs(host);
      const challWs = this.findWs(challenger);
      if (hostWs) { const d = this.att(hostWs); d.isHost = false; hostWs.serializeAttachment(d); }
      if (challWs) { const d = this.att(challWs); d.isHost = true; challWs.serializeAttachment(d); }
      this.bumpLeaderboard("koth", challenger);
      this.emitLeaderboards();
      this.broadcast("new-host", { name: challenger });
      this.broadcast("koth-result", { winner: challenger, loser: host });
      this.log("legacy king-of-the-hill game resolved");
    } else {
      this.bumpLeaderboard("koth", host);
      this.emitLeaderboards();
      this.broadcast("koth-result", { winner: host, loser: challenger });
      this.log("legacy king-of-the-hill game resolved");
    }
    this.clearActiveGame();
  }

  private async onAcceptHost(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost || this.getHost()) return;

    a.isHost = true;
    a.hostRejected = false;
    ws.serializeAttachment(a);
    this.tossPillowFrom = null;

    // clear hostRejected for everyone
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.hostRejected) {
        d.hostRejected = false;
        w.serializeAttachment(d);
      }
    }

    this.broadcast("new-host", { name: a.name });
    this.log("legacy host transfer accepted");
    await this.resetIdle();
  }

  private async onRejectHost(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost) return;

    a.hostRejected = true;
    ws.serializeAttachment(a);

    this.broadcast("host-ducked", { name: a.name });
    this.log("legacy host transfer rejected");

    // if this was a toss-pillow and target rejected, restore original host
    if (this.tossPillowFrom) {
      const origName = this.tossPillowFrom;
      this.tossPillowFrom = null;
      for (const w of this.state.getWebSockets()) {
        const d = this.att(w);
        if (d.name === origName && !d.isHost) {
          d.isHost = true;
          d.hostRejected = false;
          w.serializeAttachment(d);
          // clear rejections
          for (const rw of this.state.getWebSockets()) {
            const rd = this.att(rw);
            if (rd.hostRejected) { rd.hostRejected = false; rw.serializeAttachment(rd); }
          }
          this.broadcast("new-host", { name: origName });
          return;
        }
      }
    }

    // offer to next candidate
    await this.offerHost(a.name);
  }

  private async onDisconnect(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;
    const leavingName = a.name;
    const wasHost = a.isHost;
    a.name = "";
    a.isHost = false;
    ws.serializeAttachment(a);

    if (wasHost) {
      this.log("legacy host disconnected");
      try { ws.close(1000, "left"); } catch {}

      // find guests still connected
      const guests = this.state.getWebSockets().filter(w => {
        const d = this.att(w);
        return d.name && !d.isHost;
      });

      if (guests.length === 0) {
        await this.destroyRoom("host left and the fort is empty");
        return;
      }

      this.broadcast("member-left", { name: leavingName });
      this.cancelActiveGamesForMember(leavingName);
      this.pruneGameQueue();
      await this.offerHost(leavingName);
    } else {
      this.log("legacy member left");
      this.broadcast("member-left", { name: leavingName }, ws);
      this.cancelActiveGamesForMember(leavingName);
      this.pruneGameQueue();
      try { ws.close(1000, "left"); } catch {}
    }
  }

  private async onGracefulDisconnect(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;

    const name = a.name;
    const wasHost = a.isHost;
    this.log("legacy member disconnected (grace period starting)");

    // broadcast away status
    this.broadcast("member-away", { name }, ws);

    // start grace timer
    const timer = setTimeout(async () => {
      this.disconnected.delete(name);
      this.broadcast("member-left", { name });
      this.cancelActiveGamesForMember(name);
      this.pruneGameQueue();
      if (wasHost) {
        const guests = this.state.getWebSockets().filter(w => {
          const d = this.att(w);
          return d.name && !d.isHost;
        });
        if (guests.length === 0 && !this.getHost()) {
          await this.destroyRoom("host left and the fort is empty");
        } else if (!this.getHost()) {
          await this.offerHost(name);
        }
      }
    }, GRACE_MS);

    this.disconnected.set(name, { name, wasHost, status: a.status, awayText: a.awayText, timer });

    // clear from websocket attachment so they don't count as active
    a.name = "";
    a.isHost = false;
    ws.serializeAttachment(a);
    try { ws.close(1000, "grace"); } catch {}
  }

  private async onRejoin(ws: WebSocket, msg: { name?: string; auth?: unknown; room?: string }) {
    const requestedName = typeof msg.name === "string" ? msg.name : "";
    if (!await this.authenticate(ws, "rejoin", requestedName, msg.auth))
      return this.rejectAuthentication(ws);
    const normalizedName = normalizeAuthName(requestedName);
    if (!normalizedName)
      return this.rejectAuthentication(ws, "name and password required");
    if (!this.getHost() && this.disconnected.size === 0 && this.state.getWebSockets().filter(w => this.att(w).name).length === 0)
      return this.send(ws, "error", { message: "fort not found" });

    const disc = this.disconnected.get(normalizedName);
    if (disc) {
      clearTimeout(disc.timer);
      this.disconnected.delete(normalizedName);

      const name = disc.name;
      const prev = this.att(ws);
      const isHost = disc.wasHost && !this.getHost();
      ws.serializeAttachment({
        name,
        hash: prev.hash,
        isHost,
        hostRejected: false,
        status: disc.status || "available",
        awayText: disc.awayText || null,
        msgTimestamps: [],
        protocol: "legacy",
      } as WSData);

      this.log("legacy member rejoined");
      this.send(ws, "rejoined", {
        room: this.roomId,
        members: this.getMembers(),
        name,
        isHost,
        presence: this.getPresenceMap(),
        leaderboards: this.leaderboards,
        gameQueue: this.gameQueueSnapshot(),
        gameState: this.activeGameSnapshot(name),
        theme: this.roomTheme,
        fortPass: this.fortPassSnapshot(),
      });
      this.broadcast("member-back", { name }, ws);
      await this.resetIdle();
    } else {
      // grace expired, fall back to normal join
      await this.onJoin(ws, msg as any, true);
    }
  }
}
