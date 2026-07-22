import { isRpsPick, rpsWinner, tttWinner, voteHasMajority, type RpsPick } from "./src/game";
import { analyticsLogLine, readAnalyticsEvent } from "./src/analytics";
import { constantTimeFortPassClaimHashEqual, customRoomCodeAvailability, FORT_PASS_RESERVATION_MS, fortPassAllowsCustomRoomCode, fortPassAllowsRoomTheme, fortPassClaimHash, fortPassIdleMs, fortPassRedemptionMatches, isFortPassActive, isGeneratedFreeRoomId, normalizeCustomRoomCode, normalizeFortPassCheckoutRequest, normalizeFortPassEntitlement, normalizeRoomId, normalizeRoomTheme, type FortPassEntitlement, type RoomTheme } from "./src/entitlements";
import { checkoutPublicOrigin, hasOnlyAllowedSearchParameters, isJsonRequest, isStrictSameOriginRequest } from "./src/httpBoundary";
import { readByteLimitedText } from "./src/requestBody";
import { blockedProbeResponse, isDiscordActivityRequest, logBlockedProbe, logRateLimitedOpsEvent, probeReasonForPath, withSecurityHeaders, type SecurityHeaderMode } from "./src/security";
import { createFortPassStripeCheckoutSession, createStripeFulfillmentClaimToken, normalizeStripeHostedCheckoutUrl, normalizeStripeRedemptionRequest, resolveFortPassCheckoutSession, resolveFortPassEntitlementFromStripeEvent, resolveFortPassRevocationFromStripeEvent, stripeFulfillmentSessionKey, stripeRevocationEventKey, verifyStripeWebhookSignature, type StripeFortPassRevocationReason } from "./src/stripe";
import { sanitizeDraw, uniqueName, MAX_DRAW_EVENTS_PER_5S, GRACE_MS as DEFAULT_GRACE_MS } from "./src/shared";
import {
  createRoomAuthChallenge,
  MAX_AUTH_FAILURES_PER_MINUTE,
  MAX_WEBSOCKET_FRAME_BYTES,
  normalizeAuthName,
  ROOM_AUTH_CHALLENGE_TTL_MS,
  verifyRoomAuthProof,
} from "./src/roomAuth";
import { verifySecureDeviceResumeProofV4 } from "./src/deviceAuthV4";
import { MAX_SECURE_WEBSOCKET_FRAME_BYTES } from "./src/protocolV4";
import { parseRoomInvitationAuthPayloadV4, verifyRoomInvitationAuthV4 } from "./src/roomInvitationAuthV4";
import {
  roomInvitationKeyPackageDigestV4,
  verifyRoomInvitationMemberBindingV4,
} from "./src/roomInvitationMemberBindingV4";
import { relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
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
} from "./src/secureRelayV4";
import {
  parseSecureAuthChallengeFrameV4,
  parseSecureAuthenticateFrameV4,
  parseSecurePostAuthClientFrameV4,
  type SecureAuthenticateFrameV4,
  type SecureAuthChallengeFrameV4,
  type SecureServerErrorCodeV4,
  type SecureServerFrameV4,
} from "./src/secureTransportV4";

/** Strictly parse trusted deployment knobs without letting malformed values disable bounds. */
export function strictBoundedEnvironmentInteger(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(fallback) || !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) || minimum > fallback || fallback > maximum) {
    throw new RangeError("invalid bounded environment integer policy");
  }
  if (input === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(input)) return fallback;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

const PORT = strictBoundedEnvironmentInteger(process.env.PORT, 3000, 1, 65_535);

// --- types ---

interface WSData {
  roomId: string | null;
  isHost: boolean;
  hostRejected: boolean;
  name: string;
  status: "available" | "away";
  awayText: string | null;
  hash: string;
  ip: string;
  msgTimestamps: number[];
  drawTimestamps: number[];
  authChallenge: string;
  authChallengeCreatedAt: number;
  authAttempted: boolean;
  authenticated: boolean;
  preAuthFrames: number;
  secureConnectionId?: string;
  secureDeviceId?: string;
  secureAuthenticated?: boolean;
  secureAuthentication?: "invitation" | "device";
  protocol?: "legacy" | "v4";
  secureOperationTimestamps?: number[];
  authTimer?: ReturnType<typeof setTimeout>;
  /** Local-only registry reference; never serialized or persisted. */
  pendingAuthenticationRegistry?: Set<any>;
}

interface SecureLocalRoom {
  id: string;
  state: SecureRelayStateV4;
  roomAuthPublicKey: string;
  connections: Map<string, any>;
  transitionQueue: Promise<void>;
  relayTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  fortPassEntitlement: FortPassEntitlement | null;
  frameTimestamps: number[];
}

interface Room {
  id: string;
  authPublicKey: string;
  host: { ws: any; name: string } | null;
  guests: Map<any, string>;
  idleTimer: ReturnType<typeof setTimeout>;
  pendingOldHost: string | null;
  tossPillowFrom: string | null;
  disconnected: Map<string, {
    name: string;
    wasHost: boolean;
    status: "available" | "away";
    awayText: string | null;
    timer: ReturnType<typeof setTimeout>;
    ip: string;
  }>;
  // game state
  activeVote: { target: string; starter: string; yes: Set<string>; no: Set<string>; timer: ReturnType<typeof setTimeout>; endsAt: number; auto?: boolean } | null;
  rpsGame: { p1: string; p2: string; phase: "pending" | "playing"; timer?: ReturnType<typeof setTimeout>; pick1?: RpsPick; pick2?: RpsPick; koth?: boolean } | null;
  tttGame: { p1: string; p2: string; phase: "pending" | "playing"; timer?: ReturnType<typeof setTimeout>; board: string[]; turn: number } | null;
  saboteur: string | null;
  saboteurActive: boolean;
  sabStrikes: number;
  sabVote: {
    accuser: string;
    suspect: string;
    yes: Set<string>;
    no: Set<string>;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  sabCanStrike: boolean;
  sabBombTimer: ReturnType<typeof setTimeout> | null;
  kothGame: { challenger: string; host: string } | null;
  activeGame: GameQueueItem | null;
  gameQueue: GameQueueItem[];
  leaderboards: RoomLeaderboards;
  fortPassEntitlement: FortPassEntitlement | null;
  theme: RoomTheme;
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

// --- state (memory only, never persisted) ---

const rooms = new Map<string, Room>();
const secureRooms = new Map<string, SecureLocalRoom>();
const pendingRoomSetups = new Set<string>();
const roomCreationByIP = new Map<string, number[]>();
const failedAuthByRoomAndIP = new Map<string, number[]>();
const pendingFortPassEntitlements = new Map<string, FortPassEntitlement>();
interface LocalFortPassSetupClaim {
  sessionId: string;
  claimHash: string;
}
// The browser keeps the 256-bit raw claim secret in sessionStorage. The local
// runtime retains only its provider-bound SHA-256 digest until paid setup
// consumes it, so a copied Checkout return URL never carries setup authority.
const pendingFortPassSetupClaims = new Map<string, LocalFortPassSetupClaim>();
interface LocalFortPassReservation {
  expiresAt: number;
  token: string;
  sessionId: string | null;
  claimHash: string;
}
const pendingFortPassReservations = new Map<string, LocalFortPassReservation>();
const fortPassCheckoutAttempts = new Map<string, number[]>();
const analyticsAttempts = new Map<string, number[]>();
const fortPassCodeCheckAttempts = new Map<string, number[]>();
type LocalStripeFulfillmentLedgerEntry =
  | { status: "pending"; roomId: string; token: string; leaseExpiresAt: number }
  | { status: "complete"; roomId: string };
const localStripeFulfillmentLedger = new Map<string, LocalStripeFulfillmentLedgerEntry>();
const STRIPE_FULFILLMENT_LEASE_MS = 5 * 60 * 1000;
const FORT_PASS_CHECKOUT_WINDOW_MS = 30 * 60 * 1000;
const FORT_PASS_CHECKOUT_ATTEMPTS_PER_WINDOW = 3;
const MAX_FORT_PASS_CHECKOUT_SOURCES = 2_048;
const MAX_LOCAL_PUBLIC_SURFACE_SOURCES = 2_048;
const MAX_LOCAL_PUBLIC_SURFACE_REQUESTS_PER_MINUTE = 60;
const MAX_PENDING_FORT_PASS_RESERVATIONS = 8_192;
const MAX_LOCAL_STRIPE_FULFILLMENTS = 32_768;
const MAX_AUTH_FAILURE_BUCKETS = 256;
const MAX_ROOM_CREATION_SOURCES = 2_048;
const MAX_PENDING_ROOM_SETUPS = 256;
const MAX_LOCAL_UNAUTHENTICATED_SOCKETS = 512;
const MAX_LOCAL_UNAUTHENTICATED_SOCKETS_PER_ROOM = 32;
const MAX_SECURE_SOCKET_FRAMES_PER_5S = 100;
const MAX_SECURE_OPERATIONS_PER_5S = 30;
// One accepted group operation produces bounded ACK/control traffic from
// every recipient. Keep aggregate abuse bounded while leaving enough room for
// admission and delivery amplification in a full secure room.
const MAX_SECURE_ROOM_FRAMES_PER_5S = 256;
const MAX_LOCAL_WS_OPEN_SOURCES = 2_048;
const MAX_LOCAL_WS_OPENS_PER_MINUTE = 60;

interface LocalWebSocketPerimeterState {
  opensByIp: Map<string, number[]>;
  maxOpensPerMinute: number;
}

function takeLocalWebSocketOpenSlot(state: LocalWebSocketPerimeterState, ip: string): boolean {
  const now = Date.now();
  for (const [source, timestamps] of state.opensByIp) {
    const recent = timestamps.filter((timestamp) => now - timestamp < 60_000);
    if (recent.length) state.opensByIp.set(source, recent);
    else state.opensByIp.delete(source);
  }
  const recent = state.opensByIp.get(ip) || [];
  if (recent.length >= state.maxOpensPerMinute
    || (!state.opensByIp.has(ip) && state.opensByIp.size >= MAX_LOCAL_WS_OPEN_SOURCES)) return false;
  recent.push(now);
  state.opensByIp.set(ip, recent);
  return true;
}

function hasActiveFortPassReservation(roomId: string): boolean {
  const reservation = pendingFortPassReservations.get(roomId);
  return !!reservation && reservation.expiresAt > Date.now();
}

function hasActivePendingFortPass(roomId: string): boolean {
  const entitlement = pendingFortPassEntitlements.get(roomId);
  if (!entitlement) return false;
  if (isFortPassActive(entitlement)) return true;
  pendingFortPassEntitlements.delete(roomId);
  pendingFortPassSetupClaims.delete(roomId);
  return false;
}

async function localFortPassSetupClaimMatches(
  roomId: string,
  entitlement: FortPassEntitlement | null,
  sessionIdInput: unknown,
  claimSecretInput: unknown,
): Promise<boolean> {
  if (!fortPassRedemptionMatches(entitlement, sessionIdInput)) return false;
  const claim = pendingFortPassSetupClaims.get(roomId);
  if (!claim || claim.sessionId !== sessionIdInput) return false;
  const presentedHash = await fortPassClaimHash(claimSecretInput);
  return !!presentedHash
    && constantTimeFortPassClaimHashEqual(presentedHash, claim.claimHash);
}

// --- constants ---

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_ROOMS_PER_MIN = strictBoundedEnvironmentInteger(
  process.env.PILLOWFORT_RATE_ROOMS,
  5,
  1,
  1_000,
);
const RATE_MSGS_PER_5S = 10;
const GRACE_MS = strictBoundedEnvironmentInteger(
  process.env.PILLOWFORT_GRACE_MS,
  DEFAULT_GRACE_MS,
  1,
  10 * 60 * 1_000,
);
const VOTE_DURATION_MS = 30_000;
const CHALLENGE_TIMEOUT_MS = strictBoundedEnvironmentInteger(
  process.env.CHALLENGE_TIMEOUT_MS,
  30_000,
  1,
  30_000,
);
const GAME_PLAY_TIMEOUT_MS = strictBoundedEnvironmentInteger(
  process.env.GAME_PLAY_TIMEOUT_MS,
  process.env.NODE_ENV === "test" ? 1_000 : 60_000,
  1,
  10 * 60 * 1_000,
);
const MAX_GAME_QUEUE = 10;
const SABOTEUR_VOTE_MS = 30_000;
const SABOTEUR_MIN_PLAYERS = 4;
const SAB_BOMB_MS = strictBoundedEnvironmentInteger(
  process.env.SAB_BOMB_MS,
  process.env.NODE_ENV === "test" ? 1_200 : 10_000,
  1,
  60_000,
);
const SAB_BOMB_SECONDS = Math.max(1, Math.ceil(SAB_BOMB_MS / 1000));
const MAX_ENC_B64_LEN = 4096;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

interface EncryptedChatPayload {
  v: 3;
  kdf: "pbkdf2-sha256-600k-v1";
  sid: string;
  seq: number;
  iv: string;
  ct: string;
}

// --- helpers ---

const UINT32_RANGE = 0x1_0000_0000;

function secureUint32(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

// Rejection sampling avoids the modulo bias produced when 2^32 is not evenly
// divisible by the candidate count. The injectable source keeps the boundary
// deterministic under focused tests; production callers always use WebCrypto.
export function unbiasedRandomIndex(length: number, nextUint32: () => number = secureUint32): number {
  if (!Number.isSafeInteger(length) || length < 1 || length > UINT32_RANGE) {
    throw new RangeError("random index length is out of range");
  }
  if (length === 1) return 0;
  const acceptanceLimit = Math.floor(UINT32_RANGE / length) * length;
  while (true) {
    const value = nextUint32();
    if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_RANGE) {
      throw new RangeError("random source did not return a uint32");
    }
    if (value < acceptanceLimit) return value % length;
  }
}

export function secureRandomHex(byteLength: number): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 1024) {
    throw new RangeError("random byte length is out of range");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function generateLegacyRoomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const id = `f-${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
    if (!rooms.has(id) && !secureRooms.has(id) && !pendingRoomSetups.has(id)) return id;
  }
}

function localRoomExists(roomId: string): boolean {
  return rooms.has(roomId) || secureRooms.has(roomId) || pendingRoomSetups.has(roomId);
}

function canonicalRoomId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalized = normalizeRoomId(input);
  return normalized && input === normalized ? normalized : null;
}

function send(ws: any, type: string, payload: Record<string, any> = {}) {
  try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
}

function broadcast(room: Room, type: string, payload: Record<string, any> = {}, exclude?: any) {
  const msg = JSON.stringify({ type, ...payload });
  if (room.host && room.host.ws !== exclude) try { room.host.ws.send(msg); } catch {}
  for (const [ws] of room.guests) {
    if (ws !== exclude) try { ws.send(msg); } catch {}
  }
}

function sendSecure(ws: any, frame: SecureAuthChallengeFrameV4 | SecureServerFrameV4) {
  try { ws.send(JSON.stringify(frame)); } catch {}
}

function sendSecureError(ws: any, code: SecureServerErrorCodeV4) {
  sendSecure(ws, { kind: "secure-server", v: 4, suite: 1, type: "error", code });
}

export function takeLocalSecureRoomFrameSlot(
  room: SecureLocalRoom | null,
  _ws: any,
  data: WSData,
  now: number,
): boolean {
  data.msgTimestamps = data.msgTimestamps.filter((timestamp) =>
    typeof timestamp === "number" && Number.isFinite(timestamp)
    && timestamp <= now && now - timestamp < 5_000
  );
  // This raw cap includes mandatory ACK/decision traffic. Client-initiated
  // operations have a separate, tighter budget below so a busy room cannot
  // make passive recipients disconnect merely for acknowledging deliveries.
  if (data.msgTimestamps.length >= MAX_SECURE_SOCKET_FRAMES_PER_5S) return false;
  if (room) {
    room.frameTimestamps = room.frameTimestamps.filter((timestamp) =>
      timestamp <= now && now - timestamp < 5_000
    );
    if (room.frameTimestamps.length >= MAX_SECURE_ROOM_FRAMES_PER_5S) return false;
    room.frameTimestamps.push(now);
  }
  data.msgTimestamps.push(now);
  return true;
}

export function takeLocalSecureRoomOperationSlot(data: WSData, now: number): boolean {
  const stored = Array.isArray(data.secureOperationTimestamps)
    ? data.secureOperationTimestamps
    : [];
  data.secureOperationTimestamps = stored.filter((timestamp) =>
    typeof timestamp === "number" && Number.isFinite(timestamp)
    && timestamp <= now && now - timestamp < 5_000
  );
  if (data.secureOperationTimestamps.length >= MAX_SECURE_OPERATIONS_PER_5S) return false;
  data.secureOperationTimestamps.push(now);
  return true;
}

function closeLocalPendingAuthentication(ws: any, reason: string) {
  const data = ws.data as WSData;
  data.pendingAuthenticationRegistry?.delete(ws);
  data.pendingAuthenticationRegistry = undefined;
  try { ws.close(1008, reason); } catch {}
}

function rejectLocalSecureAuthentication(
  ws: any,
  code: SecureServerErrorCodeV4,
  reason = "authentication failed",
) {
  sendSecureError(ws, code);
  closeLocalPendingAuthentication(ws, reason);
}

function withLocalSecureLock<T>(room: SecureLocalRoom, operation: () => Promise<T>): Promise<T> {
  const run = room.transitionQueue.then(operation, operation);
  room.transitionQueue = run.then(() => undefined, () => undefined);
  return run;
}

function secureSocket(room: SecureLocalRoom, deviceId: string): any | null {
  const socket = room.connections.get(deviceId);
  if (!socket) return null;
  const attachment = socket.data as WSData;
  const member = room.state.members.find((candidate) => candidate.deviceId === deviceId);
  return attachment.secureAuthenticated && attachment.protocol === "v4"
    && attachment.secureDeviceId === deviceId
    && attachment.secureConnectionId === member?.connectionId ? socket : null;
}

function sendSecureToDevice(room: SecureLocalRoom, deviceId: string, frame: SecureServerFrameV4) {
  const socket = secureSocket(room, deviceId);
  if (socket) sendSecure(socket, frame);
}

function broadcastSecure(room: SecureLocalRoom, frame: SecureServerFrameV4) {
  for (const member of room.state.members) sendSecureToDevice(room, member.deviceId, frame);
}

/**
 * A terminal transition deliberately clears every persisted connection id.
 * Deliver its content-free retirement notice to the authenticated sockets
 * that were already attached to this in-memory room instead of trying to
 * route through the now-retired membership snapshot.
 */
export function broadcastLocalSecureTerminal(
  room: SecureLocalRoom,
  frame: Extract<SecureServerFrameV4, { type: "room-retired" }>,
) {
  const memberIds = new Set(room.state.members.map((member) => member.deviceId));
  for (const [deviceId, socket] of room.connections) {
    const attachment = socket.data as WSData;
    if (!memberIds.has(deviceId) || !attachment.secureAuthenticated ||
        attachment.protocol !== "v4" || attachment.secureDeviceId !== deviceId) continue;
    sendSecure(socket, frame);
  }
}

function dispatchLocalSecureEffects(room: SecureLocalRoom, effects: readonly SecureRelayEffectV4[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "deliver-key-package":
        sendSecureToDevice(room, effect.toDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "deliver-key-package",
          fromDeviceId: effect.fromDeviceId, admissionId: effect.admissionId,
          hello: effect.hello, memberBinding: effect.memberBinding,
        });
        break;
      case "route-relay":
        for (const deviceId of effect.toDeviceIds) sendSecureToDevice(room, deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "relay",
          fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
        });
        break;
      case "application-preview":
        sendSecureToDevice(room, effect.toHostDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "application-preview",
          fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
        });
        break;
      case "commit-preview":
        sendSecureToDevice(room, effect.toHostDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "commit-preview",
          fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
        });
        break;
      case "admission-proof-preview":
        sendSecureToDevice(room, effect.toHostDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "admission-proof-preview",
          fromDeviceId: effect.fromDeviceId, frame: effect.frame, logicalOrder: effect.logicalOrder,
        });
        break;
      case "order-granted":
        sendSecureToDevice(room, effect.toDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "order-granted", grant: effect.grant,
        });
        break;
      case "order-expired":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "order-expired", tokenId: effect.tokenId,
        });
        break;
      case "order-cancelled":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "order-cancelled",
          requestId: effect.requestId, reason: effect.reason,
        });
        break;
      case "frame-accepted":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "frame-accepted", messageId: effect.messageId,
        });
        break;
      case "application-accepted":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "application-result",
          messageId: effect.messageId, logicalOrder: effect.logicalOrder, result: "accepted", reason: null,
        });
        break;
      case "application-rejected":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "application-result",
          messageId: effect.messageId, logicalOrder: effect.logicalOrder,
          result: "rejected", reason: effect.reason,
        });
        break;
      case "commit-rejected":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "commit-rejected",
          messageId: effect.messageId, reason: effect.reason,
        });
        break;
      case "replay-backlog": {
        for (const entry of effect.entries) {
          if (entry.kind === "relay") {
            sendSecureToDevice(room, effect.toDeviceId, {
              kind: "secure-server", v: 4, suite: 1, type: "relay",
              fromDeviceId: entry.fromDeviceId, frame: entry.frame, logicalOrder: entry.logicalOrder,
            });
          } else if (entry.kind === "application-result") {
            sendSecureToDevice(room, effect.toDeviceId, {
              kind: "secure-server", v: 4, suite: 1, type: "application-result",
              messageId: entry.messageId, logicalOrder: entry.logicalOrder,
              result: entry.result, reason: entry.reason,
            });
          } else if (entry.kind === "commit-result") {
            sendSecureToDevice(room, effect.toDeviceId, entry.result === "accepted"
              ? {
                  kind: "secure-server", v: 4, suite: 1, type: "frame-accepted",
                  messageId: entry.messageId,
                }
              : {
                  kind: "secure-server", v: 4, suite: 1, type: "commit-rejected",
                  messageId: entry.messageId, reason: entry.reason!,
                });
          } else {
            sendSecureToDevice(room, effect.toDeviceId, {
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
        sendSecureToDevice(room, effect.toDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "backlog-end",
          lastMessageId: effect.lastMessageId,
        });
        break;
      case "room-state-snapshot":
        sendSecureToDevice(room, effect.toDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "room-state-snapshot",
          hostDeviceId: effect.hostDeviceId,
          members: effect.members,
          pendingHostTransfer: effect.pendingHostTransfer,
        });
        break;
      case "host-transfer-authorized":
        sendSecureToDevice(room, effect.toDeviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "host-transfer-authorized",
          fromHostDeviceId: effect.fromHostDeviceId,
          authorizationId: effect.authorizationId,
          offerMessageId: effect.offerMessageId,
          expiresAt: effect.expiresAt,
        });
        break;
      case "host-transfer-expired":
        for (const deviceId of effect.deviceIds) sendSecureToDevice(room, deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "host-transfer-expired",
          authorizationId: effect.authorizationId,
        });
        break;
      case "fresh-admission-required":
        sendSecureToDevice(room, effect.deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "fresh-admission-required", deviceId: effect.deviceId,
        });
        break;
      case "zombie-removal-required":
        for (const deviceId of effect.toDeviceIds) sendSecureToDevice(room, deviceId, {
          kind: "secure-server", v: 4, suite: 1, type: "zombie-removal-required",
          deviceId: effect.deviceId, admissionCommitMessageId: effect.admissionCommitMessageId,
        });
        break;
      case "member-lifecycle":
        broadcastSecure(room, {
          kind: "secure-server", v: 4, suite: 1, type: "member-lifecycle",
          deviceId: effect.deviceId, status: effect.status,
        });
        if (effect.status === "retired") {
          const retiredSocket = room.connections.get(effect.deviceId);
          if (retiredSocket) {
            const attachment = retiredSocket.data as WSData;
            attachment.secureAuthenticated = false;
            room.connections.delete(effect.deviceId);
            try { retiredSocket.close(1008, "membership ended"); } catch {}
          }
        }
        break;
      case "host-changed":
        broadcastSecure(room, {
          kind: "secure-server", v: 4, suite: 1, type: "host-changed", deviceId: effect.deviceId,
        });
        break;
      case "room-retired":
        broadcastLocalSecureTerminal(
          room,
          { kind: "secure-server", v: 4, suite: 1, type: "room-retired" },
        );
        break;
      default: {
        const unsupportedEffect: never = effect;
        throw new Error(`unsupported secure relay effect: ${String(unsupportedEffect)}`);
      }
    }
  }
}

function syncLocalSecureRelayTimer(room: SecureLocalRoom) {
  if (room.relayTimer) clearTimeout(room.relayTimer);
  room.relayTimer = null;
  const deadline = nextSecureRelayDeadlineV4(room.state);
  if (deadline === null || room.state.lifecycle !== "open") return;
  const timer = setTimeout(() => {
    void withLocalSecureLock(room, async () => {
      if (secureRooms.get(room.id) !== room || room.state.lifecycle !== "open"
        || room.relayTimer !== timer) return;
      room.relayTimer = null;
      const transition = advanceSecureRelayV4(room.state, {
        now: Date.now(),
        nextGrantTokenId: generateSecureRelayIdV4(),
      });
      if (!transition.ok) {
        syncLocalSecureRelayTimer(room);
        return;
      }
      // Local development has no durable store; assigning the authoritative
      // room snapshot is its persistence boundary and always precedes effects.
      room.state = transition.state;
      syncLocalSecureRelayTimer(room);
      dispatchLocalSecureEffects(room, transition.effects);
      if (room.state.lifecycle === "retired") destroyLocalSecureRoom(room, false);
    });
  }, Math.max(0, deadline - Date.now()));
  room.relayTimer = timer;
}

function resetLocalSecureIdle(room: SecureLocalRoom) {
  if (room.idleTimer) clearTimeout(room.idleTimer);
  const timer = setTimeout(() => {
    void withLocalSecureLock(room, async () => {
      // A prior timer may already be queued while an authenticated transition
      // refreshes the deadline. Only the still-authoritative timer may retire
      // the room, and destruction must serialize with reducer transitions.
      if (secureRooms.get(room.id) !== room || room.idleTimer !== timer) return;
      destroyLocalSecureRoom(room);
    });
  }, fortPassIdleMs(room.fortPassEntitlement, IDLE_MS));
  room.idleTimer = timer;
}

function destroyLocalSecureRoom(room: SecureLocalRoom, notify = true) {
  if (secureRooms.get(room.id) !== room) return;
  if (room.idleTimer) clearTimeout(room.idleTimer);
  if (room.relayTimer) clearTimeout(room.relayTimer);
  if (notify) broadcastLocalSecureTerminal(
    room,
    { kind: "secure-server", v: 4, suite: 1, type: "room-retired" },
  );
  for (const socket of room.connections.values()) {
    try { socket.close(1000, "room retired"); } catch {}
  }
  room.connections.clear();
  secureRooms.delete(room.id);
}

function members(room: Room): string[] {
  const m: string[] = room.host ? [room.host.name] : [];
  m.push(...room.guests.values());
  return m;
}

function memberPresence(d: WSData): { status: "available" | "away"; awayText?: string } {
  const p: { status: "available" | "away"; awayText?: string } = { status: d.status || "available" };
  if (d.status === "away" && d.awayText) p.awayText = d.awayText;
  return p;
}

function roomPresence(room: Room): Record<string, { status: "available" | "away"; awayText?: string }> {
  const out: Record<string, { status: "available" | "away"; awayText?: string }> = {};
  if (room.host) {
    const d = room.host.ws.data as WSData;
    if (room.host.name) out[room.host.name] = memberPresence(d);
  }
  for (const [ws, name] of room.guests) {
    const d = ws.data as WSData;
    if (name) out[name] = memberPresence(d);
  }
  return out;
}

function sanitizeEncryptedChat(enc: any): EncryptedChatPayload | null {
  if (!enc || enc.v !== 3 || enc.kdf !== "pbkdf2-sha256-600k-v1") return null;
  if (typeof enc.sid !== "string" || enc.sid.length < 16 || enc.sid.length > 64) return null;
  if (!Number.isSafeInteger(enc.seq) || enc.seq < 1) return null;
  if (typeof enc.iv !== "string" || typeof enc.ct !== "string") return null;
  if (!BASE64_RE.test(enc.iv) || !BASE64_RE.test(enc.ct)) return null;
  if (enc.iv.length < 16 || enc.iv.length > 32) return null;
  if (enc.ct.length < 16 || enc.ct.length > MAX_ENC_B64_LEN) return null;
  return { v: 3, kdf: enc.kdf, sid: enc.sid, seq: enc.seq, iv: enc.iv, ct: enc.ct };
}

async function readSmallJson(req: Request): Promise<unknown | null> {
  const body = await readByteLimitedText(req, 1024);
  if (!body.ok || !body.text) return null;
  try {
    return JSON.parse(body.text);
  } catch {
    return null;
  }
}

async function localRateLimitSourceKey(req: Request, server: any, scope: string): Promise<string | null> {
  const address = server.requestIP(req)?.address;
  if (typeof address !== "string" || !address || address.length > 128) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:local-rate-limit:v1:${scope}:${address}`)
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function takeLocalSlidingWindowSlot(
  attempts: Map<string, number[]>,
  source: string,
  limit: number,
  windowMs: number,
  maxSources: number,
  now = Date.now(),
): boolean {
  const cutoff = now - windowMs;
  const prior = (attempts.get(source) || []).filter(timestamp => timestamp > cutoff && timestamp <= now);
  if (prior.length >= limit) {
    attempts.set(source, prior);
    return false;
  }
  if (!attempts.has(source) && attempts.size >= maxSources) {
    for (const [key, timestamps] of attempts) {
      const active = timestamps.filter(timestamp => timestamp > cutoff && timestamp <= now);
      if (active.length) attempts.set(key, active);
      else attempts.delete(key);
    }
    if (attempts.size >= maxSources) return false;
  }
  attempts.set(source, [...prior, now]);
  return true;
}

async function takeLocalPublicSurfaceSlot(
  req: Request,
  server: any,
  scope: "analytics" | "fort-pass-code",
): Promise<boolean> {
  const source = await localRateLimitSourceKey(req, server, scope);
  if (!source) return false;
  return takeLocalSlidingWindowSlot(
    scope === "analytics" ? analyticsAttempts : fortPassCodeCheckAttempts,
    source,
    MAX_LOCAL_PUBLIC_SURFACE_REQUESTS_PER_MINUTE,
    60_000,
    MAX_LOCAL_PUBLIC_SURFACE_SOURCES,
  );
}

async function takeLocalCheckoutSlot(req: Request, server: any, now = Date.now()): Promise<boolean> {
  const source = await localRateLimitSourceKey(req, server, "fort-pass-checkout");
  if (!source) return false;
  return takeLocalSlidingWindowSlot(
    fortPassCheckoutAttempts,
    source,
    FORT_PASS_CHECKOUT_ATTEMPTS_PER_WINDOW,
    FORT_PASS_CHECKOUT_WINDOW_MS,
    MAX_FORT_PASS_CHECKOUT_SOURCES,
    now,
  );
}

type LocalFortPassReservationClaim =
  | { status: "claimed" }
  | { status: "supersession_required"; sessionId: string }
  | { status: "conflict" }
  | { status: "unavailable" };

function claimLocalFortPassReservation(
  roomId: string,
  token: string,
  claimHash: string,
  supersedesSessionId?: string,
  now = Date.now(),
): LocalFortPassReservationClaim {
  const existing = pendingFortPassReservations.get(roomId);
  if (existing && existing.expiresAt > now) return { status: "conflict" };
  if (supersedesSessionId !== undefined && existing?.sessionId !== supersedesSessionId) {
    return { status: "conflict" };
  }
  if (existing?.sessionId && supersedesSessionId === undefined) {
    return { status: "supersession_required", sessionId: existing.sessionId };
  }
  if (existing?.sessionId && existing.sessionId !== supersedesSessionId) return { status: "conflict" };
  if (!existing && pendingFortPassReservations.size >= MAX_PENDING_FORT_PASS_RESERVATIONS) {
    return { status: "unavailable" };
  }
  pendingFortPassReservations.set(roomId, {
    expiresAt: now + FORT_PASS_RESERVATION_MS,
    token,
    sessionId: null,
    claimHash,
  });
  return { status: "claimed" };
}

function bindLocalFortPassReservation(roomId: string, token: string, sessionId: string, now = Date.now()): boolean {
  const reservation = pendingFortPassReservations.get(roomId);
  if (!reservation || reservation.token !== token || reservation.expiresAt <= now) return false;
  if (reservation.sessionId !== null && reservation.sessionId !== sessionId) return false;
  reservation.sessionId = sessionId;
  pendingFortPassReservations.set(roomId, reservation);
  return true;
}

function localFortPassReservationOwns(roomId: string, sessionId: string, claimHash: string): boolean {
  const reservation = pendingFortPassReservations.get(roomId);
  return reservation?.sessionId === sessionId
    && constantTimeFortPassClaimHashEqual(reservation.claimHash, claimHash);
}

type LocalStripeFulfillmentClaim =
  | { status: "claimed"; sessionKey: string; token: string }
  | { status: "complete" }
  | { status: "busy" }
  | { status: "unavailable" };

async function claimLocalStripeFulfillment(
  sessionId: string,
  roomId: string,
  now = Date.now(),
): Promise<LocalStripeFulfillmentClaim> {
  let sessionKey: string;
  try {
    sessionKey = await stripeFulfillmentSessionKey(sessionId);
  } catch {
    return { status: "unavailable" };
  }

  const existing = localStripeFulfillmentLedger.get(sessionKey);
  if (existing?.roomId !== undefined && existing.roomId !== roomId) return { status: "unavailable" };
  if (existing?.status === "complete") return { status: "complete" };
  if (existing?.status === "pending" && existing.leaseExpiresAt > now) return { status: "busy" };

  // Only provider-verified, paid sessions can reach this point. Bound the
  // in-memory local-development ledger anyway so a long-lived process fails
  // closed instead of growing without limit.
  if (!existing && localStripeFulfillmentLedger.size >= MAX_LOCAL_STRIPE_FULFILLMENTS) {
    return { status: "unavailable" };
  }
  const token = createStripeFulfillmentClaimToken();
  localStripeFulfillmentLedger.set(sessionKey, {
    status: "pending",
    roomId,
    token,
    leaseExpiresAt: now + STRIPE_FULFILLMENT_LEASE_MS,
  });
  return { status: "claimed", sessionKey, token };
}

async function claimLocalStripeRevocation(
  eventId: string,
  roomId: string,
  now = Date.now(),
): Promise<LocalStripeFulfillmentClaim> {
  let eventKey: string;
  try {
    eventKey = await stripeRevocationEventKey(eventId);
  } catch {
    return { status: "unavailable" };
  }
  const existing = localStripeFulfillmentLedger.get(eventKey);
  if (existing?.roomId !== undefined && existing.roomId !== roomId) return { status: "unavailable" };
  if (existing?.status === "complete") return { status: "complete" };
  if (existing?.status === "pending" && existing.leaseExpiresAt > now) return { status: "busy" };
  if (!existing && localStripeFulfillmentLedger.size >= MAX_LOCAL_STRIPE_FULFILLMENTS) {
    return { status: "unavailable" };
  }
  const token = createStripeFulfillmentClaimToken();
  localStripeFulfillmentLedger.set(eventKey, {
    status: "pending",
    roomId,
    token,
    leaseExpiresAt: now + STRIPE_FULFILLMENT_LEASE_MS,
  });
  return { status: "claimed", sessionKey: eventKey, token };
}

function finishLocalStripeFulfillment(
  claim: Extract<LocalStripeFulfillmentClaim, { status: "claimed" }>,
  roomId: string,
  action: "complete" | "release",
): boolean {
  const existing = localStripeFulfillmentLedger.get(claim.sessionKey);
  if (
    existing?.status !== "pending"
    || existing.roomId !== roomId
    || existing.token !== claim.token
  ) return false;
  if (action === "complete") {
    localStripeFulfillmentLedger.set(claim.sessionKey, { status: "complete", roomId });
  } else {
    localStripeFulfillmentLedger.delete(claim.sessionKey);
  }
  return true;
}

type LocalStripeFulfillmentOutcome =
  | { status: "fulfilled"; replay: boolean }
  | { status: "busy" }
  | { status: "ledger_unavailable" }
  | { status: "fulfillment_failed" }
  | { status: "ledger_completion_failed" };

async function fulfillVerifiedLocalStripeSession(
  sessionId: string,
  claimHash: string,
  entitlement: FortPassEntitlement,
): Promise<LocalStripeFulfillmentOutcome> {
  const claim = await claimLocalStripeFulfillment(sessionId, entitlement.roomId);
  if (claim.status === "complete") return { status: "fulfilled", replay: true };
  if (claim.status === "busy") return { status: "busy" };
  if (claim.status === "unavailable") return { status: "ledger_unavailable" };
  if (!localFortPassReservationOwns(entitlement.roomId, sessionId, claimHash)) {
    finishLocalStripeFulfillment(claim, entitlement.roomId, "release");
    return { status: "fulfillment_failed" };
  }

  const existing = pendingFortPassEntitlements.get(entitlement.roomId)
    || rooms.get(entitlement.roomId)?.fortPassEntitlement
    || secureRooms.get(entitlement.roomId)?.fortPassEntitlement;
  let replay = false;
  if (existing?.providerRef === entitlement.providerRef) {
    replay = true;
  } else if (rooms.has(entitlement.roomId) || secureRooms.has(entitlement.roomId)) {
    finishLocalStripeFulfillment(claim, entitlement.roomId, "release");
    return { status: "fulfillment_failed" };
  } else {
    pendingFortPassEntitlements.set(entitlement.roomId, entitlement);
    pendingFortPassSetupClaims.set(entitlement.roomId, { sessionId, claimHash });
  }
  if (!finishLocalStripeFulfillment(claim, entitlement.roomId, "complete")) {
    return { status: "ledger_completion_failed" };
  }
  pendingFortPassReservations.delete(entitlement.roomId);
  return { status: "fulfilled", replay };
}

type LocalStripeRevocationOutcome =
  | { status: "processed"; revoked: boolean; stale: boolean; replay: boolean }
  | { status: "busy" | "ledger_unavailable" | "ledger_completion_failed" };

async function revokeVerifiedLocalStripeSession(
  eventId: string,
  sessionId: string,
  roomId: string,
  _reason: StripeFortPassRevocationReason,
): Promise<LocalStripeRevocationOutcome> {
  const claim = await claimLocalStripeRevocation(eventId, roomId);
  if (claim.status === "complete") {
    return { status: "processed", revoked: false, stale: false, replay: true };
  }
  if (claim.status === "busy") return { status: "busy" };
  if (claim.status === "unavailable") return { status: "ledger_unavailable" };

  const legacyRoom = rooms.get(roomId);
  const secureRoom = secureRooms.get(roomId);
  const pending = pendingFortPassEntitlements.get(roomId);
  const existing = legacyRoom?.fortPassEntitlement || secureRoom?.fortPassEntitlement || pending || null;
  const reservation = pendingFortPassReservations.get(roomId);
  const setupClaim = pendingFortPassSetupClaims.get(roomId);
  let revoked = false;
  let stale = false;
  if (!existing && reservation?.sessionId === sessionId) {
    // A refund/dispute may beat Checkout completion. Removing the exact bound
    // owner makes every later fulfillment attempt fail closed; a reservation
    // for another/newer Session is never touched.
    pendingFortPassReservations.delete(roomId);
    if (setupClaim?.sessionId === sessionId) pendingFortPassSetupClaims.delete(roomId);
    revoked = true;
  } else if (!existing || existing.provider !== "stripe" || existing.providerRef !== sessionId) {
    // The authoritative event is real but belongs to an absent or older owner.
    // Record it as processed without mutating a newer entitlement.
    stale = true;
  } else if (existing.status === "refunded") {
    if (setupClaim?.sessionId === sessionId) pendingFortPassSetupClaims.delete(roomId);
    if (reservation?.sessionId === sessionId) pendingFortPassReservations.delete(roomId);
  } else {
    const tombstone = normalizeFortPassEntitlement({ ...existing, status: "refunded" });
    if (!tombstone) {
      finishLocalStripeFulfillment(claim, roomId, "release");
      return { status: "ledger_unavailable" };
    }
    revoked = true;
    if (setupClaim?.sessionId === sessionId) pendingFortPassSetupClaims.delete(roomId);
    if (reservation?.sessionId === sessionId) pendingFortPassReservations.delete(roomId);
    if (legacyRoom) {
      legacyRoom.fortPassEntitlement = tombstone;
      if (legacyRoom.theme !== "away-message") {
        legacyRoom.theme = "away-message";
        broadcast(legacyRoom, "room-theme", { theme: legacyRoom.theme });
      }
      broadcast(legacyRoom, "fort-pass-updated", { fortPass: null });
      resetIdle(legacyRoom);
    } else if (secureRoom) {
      secureRoom.fortPassEntitlement = tombstone;
      resetLocalSecureIdle(secureRoom);
    } else {
      pendingFortPassEntitlements.set(roomId, tombstone);
    }
  }

  if (!finishLocalStripeFulfillment(claim, roomId, "complete")) {
    return { status: "ledger_completion_failed" };
  }
  return { status: "processed", revoked, stale, replay: false };
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  });
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}

const CLIENT_DIST_ROOT = resolve(import.meta.dir, "client", "dist");
const CLIENT_DIST_REAL_ROOT = realpath(CLIENT_DIST_ROOT).catch(() => null);
const MAX_STATIC_PATH_LENGTH = 2 * 1024;

function localStaticFilePath(pathname: string): string | null {
  if (
    !pathname.startsWith("/")
    || pathname.length > MAX_STATIC_PATH_LENGTH
    || /[\u0000-\u001f\u007f\\]/u.test(pathname)
  ) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(decoded)) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === ".." || segment.startsWith("."))) return null;

  const candidate = resolve(CLIENT_DIST_ROOT, `.${decoded}`);
  const inside = relative(CLIENT_DIST_ROOT, candidate);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) return null;
  return candidate;
}

async function staticFileResponse(path: string): Promise<Response> {
  const filePath = localStaticFilePath(path);
  if (!filePath) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  let realRoot: string | null;
  let realFile: string;
  try {
    realRoot = await CLIENT_DIST_REAL_ROOT;
    realFile = await realpath(filePath);
    const metadata = await stat(realFile);
    if (!realRoot || !metadata.isFile()) throw new Error("not a static file");
  } catch {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const inside = relative(realRoot, realFile);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const file = Bun.file(realFile);
  return new Response(file, {
    headers: { "content-type": contentTypeForPath(path) },
  });
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

function emitLeaderboards(room: Room, exclude?: any) {
  broadcast(room, "leaderboards", { leaderboards: room.leaderboards }, exclude);
}

function bumpLeaderboard(room: Room, game: keyof RoomLeaderboards, name: string, amount = 1) {
  if (!name) return;
  room.leaderboards[game][name] = (room.leaderboards[game][name] || 0) + amount;
}

function gameQueueSnapshot(room: Room): RoomGameQueue {
  return {
    current: room.activeGame ? { ...room.activeGame } : null,
    queue: room.gameQueue.map((q) => ({ ...q })),
  };
}

function activeGameSnapshot(room: Room, name: string) {
  if (room.rpsGame && (room.rpsGame.p1 === name || room.rpsGame.p2 === name)) {
    return { kind: "rps", p1: room.rpsGame.p1, p2: room.rpsGame.p2, phase: room.rpsGame.phase, koth: room.rpsGame.koth, myPick: room.rpsGame.p1 === name ? room.rpsGame.pick1 : room.rpsGame.pick2 };
  }
  if (room.tttGame && (room.tttGame.p1 === name || room.tttGame.p2 === name)) {
    return { kind: "ttt", p1: room.tttGame.p1, p2: room.tttGame.p2, phase: room.tttGame.phase, board: [...room.tttGame.board], turn: room.tttGame.turn };
  }
  return undefined;
}

function fortPassSnapshot(room: Room): { themePack?: string } | undefined {
  if (!room.fortPassEntitlement || !isFortPassActive(room.fortPassEntitlement)) return undefined;
  return room.fortPassEntitlement.perks.themePack
    ? { themePack: room.fortPassEntitlement.perks.themePack }
    : undefined;
}

function emitGameQueue(room: Room, exclude?: any) {
  broadcast(room, "game-queue", { gameQueue: gameQueueSnapshot(room) }, exclude);
}

function sameGameRequest(a: GameQueueItem, b: GameQueueItem): boolean {
  return a.kind === b.kind && a.by === b.by && (a.target || "") === (b.target || "");
}

function queueGame(room: Room, req: GameQueueItem, ws?: any): boolean {
  if (room.activeGame && sameGameRequest(room.activeGame, req)) return false;
  if (room.gameQueue.some((q) => sameGameRequest(q, req))) return false;
  if (room.gameQueue.length >= MAX_GAME_QUEUE) {
    if (ws) send(ws, "error", { message: "game queue is full" });
    return false;
  }
  room.gameQueue.push(req);
  emitGameQueue(room);
  if (ws) send(ws, "game-queued", { ...req, position: room.gameQueue.length });
  return true;
}

function setActiveGame(room: Room, current: GameQueueItem | null) {
  room.activeGame = current;
  emitGameQueue(room);
}

function drainGameQueue(room: Room) {
  if (room.activeGame) return;
  while (room.gameQueue.length > 0) {
    const req = room.gameQueue.shift()!;
    const nowMembers = members(room);
    if (!nowMembers.includes(req.by)) continue;
    if (req.target && !nowMembers.includes(req.target)) continue;
    let started = false;
    switch (req.kind) {
      case "vote":
        started = !!(req.target && startVote(room, req.by, req.target));
        break;
      case "rps":
        started = !!(req.target && startRps(room, req.by, req.target));
        break;
      case "ttt":
        started = !!(req.target && startTtt(room, req.by, req.target));
        break;
      case "saboteur":
        started = startSaboteur(room, req.by);
        break;
      case "koth":
        started = startKoth(room, req.by);
        break;
    }
    if (started) return;
  }
  emitGameQueue(room);
}

function clearActiveGame(room: Room, drain = true) {
  if (!room.activeGame) return;
  room.activeGame = null;
  emitGameQueue(room);
  if (drain) drainGameQueue(room);
}

function pruneGameQueue(room: Room) {
  const nowMembers = new Set(members(room));
  const next = room.gameQueue.filter((q) => nowMembers.has(q.by) && (!q.target || nowMembers.has(q.target)));
  if (next.length !== room.gameQueue.length) {
    room.gameQueue = next;
    emitGameQueue(room);
  }
}

function cancelActiveGamesForMember(room: Room, name: string) {
  let cancelled = false;
  if (room.activeVote?.target === name || room.activeVote?.starter === name) {
    clearTimeout(room.activeVote.timer);
    broadcast(room, "vote-result", {
      target: room.activeVote.target,
      yes: room.activeVote.yes.size,
      no: room.activeVote.no.size,
      ejected: false,
    });
    room.activeVote = null;
    cancelled = true;
  } else if (room.activeVote) {
    room.activeVote.yes.delete(name);
    room.activeVote.no.delete(name);
    const eligible = members(room).filter((member) => member !== room.activeVote!.target).length;
    const total = room.activeVote.yes.size + room.activeVote.no.size;
    if (total >= eligible) resolveVote(room);
  }
  if (room.rpsGame && (room.rpsGame.p1 === name || room.rpsGame.p2 === name)) {
    if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
    broadcast(room, "rps-declined", { from: name });
    room.rpsGame = null;
    room.kothGame = null;
    cancelled = true;
  }
  if (room.tttGame && (room.tttGame.p1 === name || room.tttGame.p2 === name)) {
    if (room.tttGame.timer) clearTimeout(room.tttGame.timer);
    broadcast(room, "ttt-declined", { from: name });
    room.tttGame = null;
    cancelled = true;
  }
  if (room.saboteurActive && room.saboteur === name) {
    room.saboteurActive = false;
    room.sabCanStrike = false;
    room.saboteur = null;
    if (room.sabVote) {
      clearTimeout(room.sabVote.timer);
      room.sabVote = null;
    }
    broadcast(room, "sab-vote-result", {
      accuser: "the fort",
      accused: name,
      yes: 0,
      no: 0,
      passed: true,
      wasSaboteur: true,
      saboteur: name,
    });
    cancelled = true;
  } else if (room.sabVote && (room.sabVote.accuser === name || room.sabVote.suspect === name)) {
    clearTimeout(room.sabVote.timer);
    broadcast(room, "sab-vote-result", { accuser: room.sabVote.accuser, accused: room.sabVote.suspect, yes: room.sabVote.yes.size, no: room.sabVote.no.size, passed: false, wasSaboteur: false, saboteur: null, cancelled: true });
    room.sabVote = null;
  } else if (room.sabVote) {
    room.sabVote.yes.delete(name);
    room.sabVote.no.delete(name);
    if (room.sabVote.yes.size + room.sabVote.no.size >= members(room).length) resolveSabVote(room);
  }
  if (cancelled) clearActiveGame(room);
}

function resetIdle(room: Room) {
  clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(
    () => destroy(room, "the fort went quiet for too long"),
    fortPassIdleMs(room.fortPassEntitlement, IDLE_MS)
  );
}

function destroy(room: Room, reason: string) {
  clearTimeout(room.idleTimer);
  if (room.sabVote) {
    clearTimeout(room.sabVote.timer);
    room.sabVote = null;
  }
  if (room.rpsGame?.timer) clearTimeout(room.rpsGame.timer);
  if (room.tttGame?.timer) clearTimeout(room.tttGame.timer);
  if (room.sabBombTimer) {
    clearTimeout(room.sabBombTimer);
    room.sabBombTimer = null;
  }
  // clear all grace timers
  for (const [, disc] of room.disconnected) clearTimeout(disc.timer);
  room.disconnected.clear();
  broadcast(room, "knocked-down", { reason });
  if (room.host) try { room.host.ws.close(); } catch {}
  for (const [ws] of room.guests) { try { ws.close(); } catch {} }
  rooms.delete(room.id);
}

function rateLimitedIP(ip: string): boolean {
  const now = Date.now();
  const ts = (roomCreationByIP.get(ip) || []).filter(t => now - t < 60_000);
  if (ts.length) roomCreationByIP.set(ip, ts);
  else roomCreationByIP.delete(ip);
  if (!roomCreationByIP.has(ip) && roomCreationByIP.size >= MAX_ROOM_CREATION_SOURCES) return true;
  return ts.length >= RATE_ROOMS_PER_MIN;
}

function rateLimitedMsg(data: WSData): boolean {
  const now = Date.now();
  data.msgTimestamps = data.msgTimestamps.filter(t => now - t < 5_000);
  return data.msgTimestamps.length >= RATE_MSGS_PER_5S;
}

function failedAuthKey(roomId: string, ip: string): string {
  return `${roomId}\u0000${Bun.hash(ip).toString(36)}`;
}

function recentAuthFailures(roomId: string, ip: string): number[] {
  const now = Date.now();
  for (const [key, timestamps] of failedAuthByRoomAndIP) {
    const recent = timestamps.filter((timestamp) => now - timestamp < 60_000);
    if (recent.length) failedAuthByRoomAndIP.set(key, recent);
    else failedAuthByRoomAndIP.delete(key);
  }
  return failedAuthByRoomAndIP.get(failedAuthKey(roomId, ip)) || [];
}

function recordAuthFailure(roomId: string, ip: string) {
  const failures = recentAuthFailures(roomId, ip);
  const key = failedAuthKey(roomId, ip);
  if (!failedAuthByRoomAndIP.has(key) && failedAuthByRoomAndIP.size >= MAX_AUTH_FAILURE_BUCKETS) return;
  failures.push(Date.now());
  failedAuthByRoomAndIP.set(key, failures);
  setTimeout(() => {
    const recent = (failedAuthByRoomAndIP.get(key) || []).filter((timestamp) => Date.now() - timestamp < 60_000);
    if (recent.length) failedAuthByRoomAndIP.set(key, recent);
    else failedAuthByRoomAndIP.delete(key);
  }, 60_100);
}

async function authenticateRoomAction(
  ws: any,
  d: WSData,
  msg: any,
  action: "set-up" | "join" | "rejoin",
  roomId: string,
  storedPublicKey?: string | null
): Promise<boolean> {
  const authFailureKey = failedAuthKey(roomId, d.ip);
  const failures = recentAuthFailures(roomId, d.ip);
  if ((!failedAuthByRoomAndIP.has(authFailureKey) && failedAuthByRoomAndIP.size >= MAX_AUTH_FAILURE_BUCKETS) ||
      failures.length >= MAX_AUTH_FAILURES_PER_MINUTE) {
    send(ws, "error", { message: "slow down — too many failed attempts" });
    return false;
  }
  if (Date.now() - d.authChallengeCreatedAt > ROOM_AUTH_CHALLENGE_TTL_MS) {
    recordAuthFailure(roomId, d.ip);
    send(ws, "error", { message: "authentication challenge expired" });
    return false;
  }

  const valid = await verifyRoomAuthProof({
    auth: msg.auth,
    action,
    roomId,
    name: typeof msg.name === "string" ? msg.name : "",
    expectedChallenge: d.authChallenge,
    storedPublicKey,
  });
  if (!valid) {
    recordAuthFailure(roomId, d.ip);
    send(ws, "error", { message: "wrong password" });
    return false;
  }
  failedAuthByRoomAndIP.delete(failedAuthKey(roomId, d.ip));
  return true;
}

function beginAuthAttempt(ws: any, d: WSData): boolean {
  if (d.authAttempted) {
    send(ws, "error", { message: "authentication already attempted" });
    return false;
  }
  d.authAttempted = true;
  return true;
}

function rejectMalformedAuth(ws: any, d: WSData, roomId: string, message: string) {
  recordAuthFailure(roomId || "unknown", d.ip);
  send(ws, "error", { message });
}

// --- handlers ---

async function verifyLocalSecureSocketProof(
  d: WSData,
  verifier: (challenge: string) => Promise<boolean>,
): Promise<null | "authentication-expired" | "authentication-failed" | "rate-limited"> {
  if (d.authAttempted || !d.authChallenge) return "authentication-failed";
  d.authAttempted = true;
  const failures = d.roomId ? recentAuthFailures(d.roomId, d.ip) : [];
  const failureKey = d.roomId ? failedAuthKey(d.roomId, d.ip) : null;
  if (failures.length >= MAX_AUTH_FAILURES_PER_MINUTE
    || (!!failureKey && !failedAuthByRoomAndIP.has(failureKey)
      && failedAuthByRoomAndIP.size >= MAX_AUTH_FAILURE_BUCKETS)) return "rate-limited";
  if (Date.now() - d.authChallengeCreatedAt > ROOM_AUTH_CHALLENGE_TTL_MS) {
    if (d.roomId) recordAuthFailure(d.roomId, d.ip);
    return "authentication-expired";
  }
  let ok = false;
  try { ok = await verifier(d.authChallenge); } catch {}
  if (!ok) {
    if (d.roomId) recordAuthFailure(d.roomId, d.ip);
    return "authentication-failed";
  }
  if (d.roomId) failedAuthByRoomAndIP.delete(failedAuthKey(d.roomId, d.ip));
  return null;
}

function markLocalSecureAuthenticated(
  ws: any,
  d: WSData,
  room: SecureLocalRoom,
  actor: SecureRelayActorV4,
) {
  d.name = "";
  d.isHost = false;
  d.authenticated = true;
  d.secureAuthenticated = true;
  d.secureAuthentication = actor.authentication;
  d.secureDeviceId = actor.deviceId;
  d.secureConnectionId = actor.connectionId;
  d.protocol = "v4";
  d.preAuthFrames = 0;
  d.pendingAuthenticationRegistry?.delete(ws);
  d.pendingAuthenticationRegistry = undefined;
  room.connections.set(actor.deviceId, ws);
}

async function onLocalSecureAuthenticate(ws: any, d: WSData, authenticate: SecureAuthenticateFrameV4) {
  const roomId = d.roomId && canonicalRoomId(d.roomId);
  if (!roomId || !d.secureConnectionId || d.secureAuthenticated || d.protocol === "legacy") {
    rejectLocalSecureAuthentication(ws, "authentication-failed");
    return;
  }
  const frame = authenticate.frame;
  const roomInstance = frame.kind === "setup" || frame.kind === "join"
    ? frame.hello.roomInstance
    : frame.roomInstance;
  const deviceId = frame.kind === "setup" || frame.kind === "join"
    ? frame.hello.deviceId
    : frame.deviceId;
  const connectionId = d.secureConnectionId;

  if (authenticate.mode === "setup") {
    if (localRoomExists(roomId)
      || (!hasActivePendingFortPass(roomId) && hasActiveFortPassReservation(roomId))) {
      rejectLocalSecureAuthentication(ws, "room-exists");
      return;
    }
    if (pendingRoomSetups.size >= MAX_PENDING_ROOM_SETUPS) {
      rejectLocalSecureAuthentication(ws, "rate-limited");
      return;
    }
    pendingRoomSetups.add(roomId);
    try {
      const proofError = await verifyLocalSecureSocketProof(d, (challenge) =>
        verifyRoomInvitationAuthV4({
          context: {
            mode: "setup", roomId, roomInstance, deviceId, connectionId,
            requestId: frame.requestId, challenge,
          },
          auth: authenticate.auth,
        })
      );
      if (proofError) {
        rejectLocalSecureAuthentication(ws, proofError);
        return;
      }
      const parsedAuth = parseRoomInvitationAuthPayloadV4(authenticate.auth, "setup");
      const keyPackageDigest = await roomInvitationKeyPackageDigestV4(frame.hello.keyPackage);
      if (!parsedAuth?.publicKey || !await verifyRoomInvitationMemberBindingV4({
        binding: frame.memberBinding,
        invitationPublicKey: parsedAuth.publicKey,
        expected: {
          mode: "founder",
          roomId,
          roomInstance,
          deviceId,
          admissionId: frame.requestId,
          signaturePublicKey: frame.signaturePublicKey,
          keyPackageDigest,
        },
      })) {
        rejectLocalSecureAuthentication(ws, "authentication-failed");
        return;
      }
      if (rateLimitedIP(d.ip)) {
        rejectLocalSecureAuthentication(ws, "rate-limited");
        return;
      }
      const entitlement = pendingFortPassEntitlements.get(roomId) || null;
      if (!isGeneratedFreeRoomId(roomId) && (
        !fortPassAllowsCustomRoomCode(entitlement, roomId)
        || !await localFortPassSetupClaimMatches(
          roomId,
          entitlement,
          authenticate.fortPassSessionId,
          authenticate.fortPassClaimSecret,
        )
      )) {
        rejectLocalSecureAuthentication(ws, "authentication-failed");
        return;
      }
      const actor: SecureRelayActorV4 = {
        deviceId,
        connectionId,
        authentication: "invitation",
      };
      const transition = await createSecureRelayStateV4(actor, frame, Date.now());
      if (!transition.ok) {
        rejectLocalSecureAuthentication(ws, transition.code);
        return;
      }
      const room: SecureLocalRoom = {
        id: roomId,
        state: transition.state,
        roomAuthPublicKey: parsedAuth.publicKey,
        connections: new Map(),
        transitionQueue: Promise.resolve(),
        relayTimer: null,
        idleTimer: null,
        fortPassEntitlement: entitlement,
        frameTimestamps: [],
      };
      // Map insertion is the local runtime's authoritative persistence boundary.
      secureRooms.set(roomId, room);
      pendingFortPassEntitlements.delete(roomId);
      pendingFortPassSetupClaims.delete(roomId);
      pendingFortPassReservations.delete(roomId);
      const timestamps = roomCreationByIP.get(d.ip) || [];
      timestamps.push(Date.now());
      roomCreationByIP.set(d.ip, timestamps);
      markLocalSecureAuthenticated(ws, d, room, actor);
      resetLocalSecureIdle(room);
      syncLocalSecureRelayTimer(room);
      sendSecure(ws, {
        kind: "secure-server", v: 4, suite: 1, type: "authenticated", mode: "setup",
        roomInstance: room.state.roomInstance, deviceId, status: "active",
      });
      dispatchLocalSecureEffects(room, transition.effects);
    } finally {
      pendingRoomSetups.delete(roomId);
    }
    return;
  }

  const room = secureRooms.get(roomId);
  if (!room || rooms.has(roomId)) {
    rejectLocalSecureAuthentication(ws, "room-not-found");
    return;
  }
  if (roomInstance !== room.state.roomInstance) {
    rejectLocalSecureAuthentication(ws, "wrong-room");
    return;
  }
  const proofError = await verifyLocalSecureSocketProof(d, async (challenge) => {
    if (authenticate.mode === "resume") {
      const signaturePublicKey = getSecureRelayDeviceSignatureKeyV4(room.state, deviceId);
      return !!signaturePublicKey && verifySecureDeviceResumeProofV4({
        roomId, roomInstance, deviceId, connectionId,
        requestId: frame.requestId, challenge,
      }, authenticate.resumeProof, signaturePublicKey);
    }
    return verifyRoomInvitationAuthV4({
      context: {
        mode: "join", roomId, roomInstance, deviceId, connectionId,
        requestId: frame.requestId, challenge,
      },
      auth: authenticate.auth,
      storedPublicKey: room.roomAuthPublicKey,
    });
  });
  if (proofError) {
    rejectLocalSecureAuthentication(ws, proofError);
    return;
  }
  if (authenticate.mode === "join") {
    const keyPackageDigest = await roomInvitationKeyPackageDigestV4(frame.hello.keyPackage);
    if (!await verifyRoomInvitationMemberBindingV4({
      binding: frame.memberBinding,
      invitationPublicKey: room.roomAuthPublicKey,
      expected: {
        mode: "admission",
        roomId,
        roomInstance,
        deviceId,
        admissionId: frame.requestId,
        signaturePublicKey: frame.signaturePublicKey,
        keyPackageDigest,
      },
    })) {
      rejectLocalSecureAuthentication(ws, "authentication-failed");
      return;
    }
  }

  await withLocalSecureLock(room, async () => {
    if (secureRooms.get(roomId) !== room) {
      rejectLocalSecureAuthentication(ws, "room-not-found");
      return;
    }
    const actor: SecureRelayActorV4 = {
      deviceId,
      connectionId,
      authentication: authenticate.mode === "resume" ? "device" : "invitation",
    };
    const replacedSocket = authenticate.mode === "resume"
      ? room.connections.get(deviceId) || null
      : null;
    const transition = await reduceSecureRelayV4(room.state, actor, frame, {
      now: Date.now(),
      nextGrantTokenId: generateSecureRelayIdV4(),
    });
    if (!transition.ok) {
      rejectLocalSecureAuthentication(ws, transition.code);
      return;
    }
    room.state = transition.state;
    const roomRetired = transition.state.lifecycle === "retired"
      || transition.effects.some((effect) => effect.type === "room-retired");
    const freshAdmissionRequired = transition.effects.some((effect) =>
      effect.type === "fresh-admission-required" && effect.deviceId === deviceId);
    if (roomRetired || freshAdmissionRequired) {
      dispatchLocalSecureEffects(room, transition.effects);
      rejectLocalSecureAuthentication(
        ws,
        roomRetired ? "room-retired" : "fresh-admission-required",
        roomRetired ? "room retired" : "fresh admission required",
      );
      if (roomRetired) destroyLocalSecureRoom(room, false);
      else syncLocalSecureRelayTimer(room);
      return;
    }
    markLocalSecureAuthenticated(ws, d, room, actor);
    if (replacedSocket && replacedSocket !== ws) {
      try { replacedSocket.close(4001, "connection replaced"); } catch {}
    }
    resetLocalSecureIdle(room);
    syncLocalSecureRelayTimer(room);
    if (authenticate.mode === "join") {
      const founderBinding = room.state.members.find((candidate) => candidate.joinedOrder === 1)?.memberBinding;
      if (!founderBinding) {
        rejectLocalSecureAuthentication(ws, "room-state-invalid");
        return;
      }
      sendSecure(ws, {
        kind: "secure-server", v: 4, suite: 1, type: "authenticated", mode: "join",
        roomInstance: room.state.roomInstance, deviceId, status: "pending", founderBinding,
      });
    } else {
      const member = room.state.members.find((candidate) => candidate.deviceId === deviceId);
      sendSecure(ws, {
        kind: "secure-server", v: 4, suite: 1, type: "authenticated", mode: "resume",
        roomInstance: room.state.roomInstance, deviceId,
        status: member?.status === "active" ? "active" : "pending",
      });
    }
    dispatchLocalSecureEffects(room, transition.effects);
  });
}

async function onLocalSecureFrame(ws: any, d: WSData, frame: SecureClientFrameV4) {
  const room = d.roomId ? secureRooms.get(d.roomId) : null;
  if (!room || !d.secureAuthenticated || d.protocol !== "v4" || !d.secureDeviceId
    || !d.secureConnectionId || !d.secureAuthentication) {
    sendSecureError(ws, "authentication-required");
    return;
  }
  await withLocalSecureLock(room, async () => {
    if (secureRooms.get(room.id) !== room || room.state.lifecycle !== "open") {
      sendSecureError(ws, "room-retired");
      return;
    }
    const actor: SecureRelayActorV4 = {
      deviceId: d.secureDeviceId!,
      connectionId: d.secureConnectionId!,
      authentication: d.secureAuthentication!,
    };
    const transition = await reduceSecureRelayV4(room.state, actor, frame, {
      now: Date.now(),
      nextGrantTokenId: generateSecureRelayIdV4(),
    });
    if (!transition.ok) {
      sendSecureError(ws, transition.code);
      return;
    }
    room.state = transition.state;
    resetLocalSecureIdle(room);
    syncLocalSecureRelayTimer(room);
    dispatchLocalSecureEffects(room, transition.effects);
    if (room.state.lifecycle === "retired") destroyLocalSecureRoom(room, false);
  });
}

async function onLocalSecureDisconnect(ws: any, d: WSData) {
  const room = d.roomId ? secureRooms.get(d.roomId) : null;
  if (!room || !d.secureAuthenticated || !d.secureDeviceId || !d.secureConnectionId
    || !d.secureAuthentication || room.state.lifecycle !== "open") return;
  await withLocalSecureLock(room, async () => {
    if (secureRooms.get(room.id) !== room || room.state.lifecycle !== "open") return;
    const actor: SecureRelayActorV4 = {
      deviceId: d.secureDeviceId!,
      connectionId: d.secureConnectionId!,
      authentication: d.secureAuthentication!,
    };
    const transition = disconnectSecureRelayDeviceV4(room.state, actor, {
      now: Date.now(),
      nextGrantTokenId: generateSecureRelayIdV4(),
    });
    if (!transition.ok) return;
    room.state = transition.state;
    if (room.connections.get(actor.deviceId) === ws) room.connections.delete(actor.deviceId);
    d.secureAuthenticated = false;
    syncLocalSecureRelayTimer(room);
    dispatchLocalSecureEffects(room, transition.effects);
  });
}

async function onSetUp(ws: any, d: WSData, msg: any) {
  if (!beginAuthAttempt(ws, d)) return;
  const normalizedName = normalizeAuthName(typeof msg.name === "string" ? msg.name : "");
  if (!normalizedName) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "bad_auth", surface: "local" });
    return rejectMalformedAuth(ws, d, d.roomId || "unknown", "name and password required");
  }
  if (d.isHost) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "already_inside", surface: "local" });
    return send(ws, "error", { message: "already in a fort" });
  }
  if (rateLimitedIP(d.ip)) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "rate_limited", surface: "local" });
    return send(ws, "error", { message: "slow down — too many forts" });
  }

  const id = d.roomId || generateLegacyRoomId();
  if (localRoomExists(id)
    || (!hasActivePendingFortPass(id) && hasActiveFortPassReservation(id))) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "exists", surface: "local" });
    return send(ws, "error", { message: "fort already exists" });
  }
  if (pendingRoomSetups.size >= MAX_PENDING_ROOM_SETUPS) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "rate_limited", surface: "local" });
    return send(ws, "error", { message: "slow down — too many pending forts" });
  }
  pendingRoomSetups.add(id);
  try {
  if (!await authenticateRoomAction(ws, d, msg, "set-up", id)) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "bad_auth", surface: "local" });
    return;
  }
  const fortPassEntitlement = pendingFortPassEntitlements.get(id) || null;
  if (!isGeneratedFreeRoomId(id) && (
    !fortPassAllowsCustomRoomCode(fortPassEntitlement, id)
    || !await localFortPassSetupClaimMatches(
      id,
      fortPassEntitlement,
      msg.fortPassSessionId,
      msg.fortPassClaimSecret,
    )
  )) {
    logRateLimitedOpsEvent("room-auth-local", "room_setup_failed", { reason: "paid_redemption", surface: "local" });
    return send(ws, "error", { message: "paid room redemption required" });
  }

  d.authenticated = true;
  d.pendingAuthenticationRegistry?.delete(ws);
  d.pendingAuthenticationRegistry = undefined;
  d.protocol = "legacy";
  d.roomId = id;
  d.isHost = true;
  d.name = normalizedName;
  d.status = "available";
  d.awayText = null;

  const ts = roomCreationByIP.get(d.ip) || [];
  ts.push(Date.now());
  roomCreationByIP.set(d.ip, ts);

  const room: Room = {
    id,
    authPublicKey: msg.auth.publicKey,
    host: { ws, name: d.name },
    guests: new Map(),
    idleTimer: setTimeout(() => destroy(room, "the fort went quiet for too long"), fortPassIdleMs(fortPassEntitlement, IDLE_MS)),
    pendingOldHost: null,
    tossPillowFrom: null,
    disconnected: new Map(),
    activeVote: null,
    rpsGame: null,
    tttGame: null,
    saboteur: null,
    saboteurActive: false,
    sabStrikes: 0,
    sabVote: null,
    sabCanStrike: false,
    sabBombTimer: null,
    kothGame: null,
    activeGame: null,
    gameQueue: [],
    leaderboards: createLeaderboards(),
    fortPassEntitlement,
    theme: "away-message",
  };
  pendingFortPassEntitlements.delete(id);
  pendingFortPassSetupClaims.delete(id);
  pendingFortPassReservations.delete(id);

  rooms.set(id, room);
  send(ws, "room-created", {
    room: id,
    leaderboards: room.leaderboards,
    gameQueue: gameQueueSnapshot(room),
    theme: room.theme,
    fortPass: fortPassSnapshot(room),
  });
  } finally {
    pendingRoomSetups.delete(id);
  }
}

async function onJoin(ws: any, d: WSData, msg: any) {
  if (!beginAuthAttempt(ws, d)) return;
  const roomId = canonicalRoomId(msg.room);
  const normalizedName = normalizeAuthName(typeof msg.name === "string" ? msg.name : "");
  if (!normalizedName || !roomId || (d.roomId !== null && d.roomId !== roomId)) {
    logRateLimitedOpsEvent("room-auth-local", "room_join_failed", { reason: "bad_auth", surface: "local" });
    return rejectMalformedAuth(
      ws,
      d,
      normalizeRoomId(msg.room) || d.roomId || "unknown",
      "name, password, and canonical fort flag required"
    );
  }
  if (d.isHost) {
    logRateLimitedOpsEvent("room-auth-local", "room_join_failed", { reason: "already_inside", surface: "local" });
    return send(ws, "error", { message: "already in a fort" });
  }

  const room = rooms.get(roomId);
  if (!room) {
    logRateLimitedOpsEvent("room-auth-local", "room_join_failed", { reason: "not_found", surface: "local" });
    return send(ws, "error", { message: "fort not found" });
  }
  if (!await authenticateRoomAction(ws, d, msg, "join", room.id, room.authPublicKey)) {
    logRateLimitedOpsEvent("room-auth-local", "room_join_failed", { reason: "wrong_password", surface: "local" });
    return;
  }
  if (room.guests.size >= MAX_GUESTS) {
    logRateLimitedOpsEvent("room-auth-local", "room_join_failed", { reason: "full", surface: "local" });
    return send(ws, "error", { message: "fort is full (20 max)" });
  }

  d.authenticated = true;
  d.pendingAuthenticationRegistry?.delete(ws);
  d.pendingAuthenticationRegistry = undefined;
  d.roomId = room.id;
  d.isHost = false;
  d.name = uniqueName(normalizedName, new Set(members(room)));
  d.status = "available";
  d.awayText = null;

  room.guests.set(ws, d.name);
  send(ws, "joined", {
    room: room.id,
    members: members(room),
    name: d.name,
    presence: roomPresence(room),
    leaderboards: room.leaderboards,
    gameQueue: gameQueueSnapshot(room),
    theme: room.theme,
    fortPass: fortPassSnapshot(room),
  });
  broadcast(room, "member-joined", { name: d.name, presence: memberPresence(d) }, ws);
  resetIdle(room);
}

function onChat(ws: any, d: WSData, msg: any) {
  if (!d.roomId) return;
  if (rateLimitedMsg(d))
    return send(ws, "error", { message: "slow down" });

  d.msgTimestamps.push(Date.now());
  const room = rooms.get(d.roomId);
  if (!room) return;

  const enc = sanitizeEncryptedChat(msg.enc);
  if (enc) {
    broadcast(room, "message", { from: d.name, enc });
    resetIdle(room);
    return;
  }

  return send(ws, "error", { message: "encrypted chat v3 required" });
}

function onKnockDown(ws: any, d: WSData) {
  if (!d.roomId || !d.isHost) return;
  const room = rooms.get(d.roomId);
  if (room) destroy(room, "host knocked it down");
}

function onTyping(ws: any, d: WSData) {
  if (!d.roomId) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  broadcast(room, "typing", { name: d.name }, ws);
}

function onSetStatus(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (msg.status !== "available" && msg.status !== "away") return;

  d.status = msg.status;
  if (d.status === "away") {
    const text = typeof msg.awayText === "string" ? msg.awayText.trim().slice(0, 120) : "";
    d.awayText = text || null;
  } else {
    d.awayText = null;
  }

  broadcast(room, "member-status", {
    name: d.name,
    status: d.status,
    awayText: d.awayText,
  });
  resetIdle(room);
}

function onSetTheme(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !d.isHost) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  const theme = normalizeRoomTheme(msg.theme);
  if (!theme) return send(ws, "error", { message: "invalid theme" });
  const localSkinDemo =
    d.ip === "127.0.0.1" ||
    d.ip === "::ffff:127.0.0.1" ||
    d.ip === "::1" ||
    d.ip === "0:0:0:0:0:0:0:1" ||
    d.ip === "localhost";
  if (!localSkinDemo && !fortPassAllowsRoomTheme(room.fortPassEntitlement, theme)) {
    return send(ws, "error", { message: "Fort Pass required" });
  }
  room.theme = theme;
  broadcast(room, "room-theme", { theme });
  resetIdle(room);
}

function offerHost(room: Room, oldHostName: string) {
  const candidates = [...room.guests.entries()].filter(([ws]) => {
    const d = ws.data as WSData;
    return !d.hostRejected;
  });

  if (candidates.length === 0) {
    destroy(room, "nobody caught the pillow");
    return;
  }

  const [pickWs, pickName] = candidates[unbiasedRandomIndex(candidates.length)];
  room.pendingOldHost = oldHostName;
  send(pickWs, "host-offer", { oldHost: oldHostName });
  broadcast(room, "host-offered", { name: pickName }, pickWs);
}

function onTossPillow(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.isHost || !msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;

  // find target in guests
  let targetWs: any = null;
  for (const [gws, gname] of room.guests) {
    if (gname === msg.target) { targetWs = gws; break; }
  }
  if (!targetWs) return;

  // demote host to guest
  room.tossPillowFrom = d.name;
  room.host = null;
  room.guests.set(ws, d.name);
  d.isHost = false;

  // send offer to specific target
  room.pendingOldHost = d.name;
  send(targetWs, "host-offer", { oldHost: d.name });
  broadcast(room, "host-offered", { name: msg.target }, targetWs);
}

function onAcceptHost(ws: any, d: WSData) {
  if (!d.roomId || d.isHost) return;
  const room = rooms.get(d.roomId);
  if (!room || room.host) return;

  // promote
  room.guests.delete(ws);
  d.isHost = true;
  d.hostRejected = false;
  room.host = { ws, name: d.name };
  room.pendingOldHost = null;
  room.tossPillowFrom = null;

  // clear rejections
  for (const [gws] of room.guests) {
    (gws.data as WSData).hostRejected = false;
  }

  broadcast(room, "new-host", { name: d.name });
  resetIdle(room);
}

function onRejectHost(ws: any, d: WSData) {
  if (!d.roomId || d.isHost) return;
  const room = rooms.get(d.roomId);
  if (!room) return;

  d.hostRejected = true;
  broadcast(room, "host-ducked", { name: d.name });

  // if this was a toss-pillow and target rejected, restore original host
  if (room.tossPillowFrom) {
    const origName = room.tossPillowFrom;
    room.tossPillowFrom = null;
    // find original host in guests
    for (const [gws, gname] of room.guests) {
      if (gname === origName) {
        room.guests.delete(gws);
        const gd = gws.data as WSData;
        gd.isHost = true;
        gd.hostRejected = false;
        room.host = { ws: gws, name: origName };
        room.pendingOldHost = null;
        // clear rejections
        for (const [rws] of room.guests) {
          (rws.data as WSData).hostRejected = false;
        }
        broadcast(room, "new-host", { name: origName });
        return;
      }
    }
  }

  offerHost(room, room.pendingOldHost || d.name);
}

function onLeave(_ws: any, d: WSData) {
  if (!d.roomId) return;
  const room = rooms.get(d.roomId);
  if (!room) { d.roomId = null; return; }
  removeMember(_ws, d, room);
  d.roomId = null;
  d.name = "";
  d.isHost = false;
  try { _ws.close(1000, "left"); } catch {}
}

function removeMember(ws: any, d: WSData, room: Room) {
  const leavingName = d.name;
  if (d.isHost) {
    if (room.guests.size === 0) {
      destroy(room, "host left and the fort is empty");
    } else {
      room.host = null;
      broadcast(room, "member-left", { name: d.name });
      offerHost(room, d.name);
    }
  } else {
    room.guests.delete(ws);
    broadcast(room, "member-left", { name: d.name });
  }
  cancelActiveGamesForMember(room, leavingName);
  pruneGameQueue(room);
}

function onDisconnect(ws: any, d: WSData) {
  if (!d.roomId) return;
  const room = rooms.get(d.roomId);
  if (!room) { d.roomId = null; return; }

  const name = d.name;
  const wasHost = d.isHost;

  // start grace period
  if (wasHost) {
    room.host = null;
  } else {
    room.guests.delete(ws);
  }

  broadcast(room, "member-away", { name });

  const timer = setTimeout(() => {
    room.disconnected.delete(name);
    broadcast(room, "member-left", { name });
    cancelActiveGamesForMember(room, name);
    pruneGameQueue(room);
    if (wasHost) {
      if (room.guests.size === 0 && !room.host) {
        destroy(room, "host left and the fort is empty");
      } else if (!room.host) {
        offerHost(room, name);
      }
    }
  }, GRACE_MS);

  room.disconnected.set(name, { name, wasHost, status: d.status, awayText: d.awayText, timer, ip: d.ip });
  d.roomId = null;
}

async function onRejoin(ws: any, d: WSData, msg: any) {
  if (!beginAuthAttempt(ws, d)) return;
  const roomId = canonicalRoomId(msg.room);
  const normalizedName = normalizeAuthName(typeof msg.name === "string" ? msg.name : "");
  if (!normalizedName || !roomId || (d.roomId !== null && d.roomId !== roomId))
    return rejectMalformedAuth(
      ws,
      d,
      normalizeRoomId(msg.room) || d.roomId || "unknown",
      "name, password, and canonical fort flag required"
    );

  const room = rooms.get(roomId);
  if (!room) return send(ws, "error", { message: "fort not found" });
  if (!await authenticateRoomAction(ws, d, msg, "rejoin", room.id, room.authPublicKey)) return;

  const disc = room.disconnected.get(normalizedName);
  if (disc) {
    // cancel grace timer, restore member
    clearTimeout(disc.timer);
    room.disconnected.delete(normalizedName);

    d.authenticated = true;
    d.pendingAuthenticationRegistry?.delete(ws);
    d.pendingAuthenticationRegistry = undefined;
    d.protocol = "legacy";
    d.roomId = room.id;
    d.name = disc.name;
    d.status = disc.status || "available";
    d.awayText = disc.awayText || null;

    if (disc.wasHost && !room.host) {
      d.isHost = true;
      room.host = { ws, name: d.name };
    } else {
      d.isHost = false;
      room.guests.set(ws, d.name);
    }

    send(ws, "rejoined", {
      room: room.id,
      members: members(room),
      name: d.name,
      isHost: d.isHost,
      presence: roomPresence(room),
      leaderboards: room.leaderboards,
      gameQueue: gameQueueSnapshot(room),
      gameState: activeGameSnapshot(room, d.name),
      theme: room.theme,
      fortPass: fortPassSnapshot(room),
    });
    broadcast(room, "member-back", { name: d.name }, ws);
    resetIdle(room);
  } else {
    // Grace expired: the rejoin proof has already authenticated this socket.
    if (room.guests.size >= MAX_GUESTS) return send(ws, "error", { message: "fort is full (20 max)" });
    d.authenticated = true;
    d.pendingAuthenticationRegistry?.delete(ws);
    d.pendingAuthenticationRegistry = undefined;
    d.protocol = "legacy";
    d.roomId = room.id;
    d.isHost = false;
    d.name = uniqueName(normalizedName, new Set(members(room)));
    d.status = "available";
    d.awayText = null;
    room.guests.set(ws, d.name);
    send(ws, "joined", {
      room: room.id,
      members: members(room),
      name: d.name,
      presence: roomPresence(room),
      leaderboards: room.leaderboards,
      gameQueue: gameQueueSnapshot(room),
      theme: room.theme,
      fortPass: fortPassSnapshot(room),
    });
    broadcast(room, "member-joined", { name: d.name, presence: memberPresence(d) }, ws);
    resetIdle(room);
  }
}

// --- game helpers ---

function findWs(room: Room, name: string): any | null {
  if (room.host && room.host.name === name) return room.host.ws;
  for (const [ws, n] of room.guests) {
    if (n === name) return ws;
  }
  return null;
}

function getHostWs(room: Room): any | null {
  return room.host ? room.host.ws : null;
}

function startVote(
  room: Room,
  starter: string,
  target: string,
  opts?: { auto?: boolean; starterLabel?: string }
): boolean {
  if (room.activeVote) return false;
  if (!opts?.auto && starter === target) return false;
  const m = members(room);
  if (!m.includes(target)) return false;
  if (!opts?.auto && !m.includes(starter)) return false;
  if (m.length < 3) return false;

  const endsAt = Date.now() + VOTE_DURATION_MS;
  room.activeVote = {
    target,
    starter,
    yes: opts?.auto ? new Set() : new Set([starter]),
    no: new Set(),
    auto: !!opts?.auto,
    endsAt,
    timer: setTimeout(() => resolveVote(room), VOTE_DURATION_MS),
  };
  setActiveGame(room, { kind: "vote", by: starter, target });
  broadcast(room, "vote-started", {
    target,
    starter: opts?.starterLabel || starter,
    duration: VOTE_DURATION_MS,
    endsAt,
    ...(opts?.auto ? { auto: true } : {}),
  });
  return true;
}

function startRps(room: Room, p1: string, p2: string): boolean {
  if (room.rpsGame) return false;
  const m = members(room);
  if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
  const tw = findWs(room, p2);
  if (!tw) return false;
  room.rpsGame = {
    p1,
    p2,
    phase: "pending",
    timer: setTimeout(() => {
      if (!room.rpsGame || room.rpsGame.p1 !== p1 || room.rpsGame.p2 !== p2 || room.rpsGame.phase !== "pending") return;
      broadcast(room, "rps-declined", { from: p2 });
      room.rpsGame = null;
      room.kothGame = null;
      clearActiveGame(room);
    }, CHALLENGE_TIMEOUT_MS),
  };
  setActiveGame(room, { kind: "rps", by: p1, target: p2 });
  send(tw, "rps-challenged", { from: p1 });
  broadcast(room, "rps-pending", { p1, p2 });
  return true;
}

function startTtt(room: Room, p1: string, p2: string): boolean {
  if (room.tttGame) return false;
  const m = members(room);
  if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
  const tw = findWs(room, p2);
  if (!tw) return false;
  room.tttGame = {
    p1,
    p2,
    phase: "pending",
    timer: setTimeout(() => {
      if (!room.tttGame || room.tttGame.p1 !== p1 || room.tttGame.p2 !== p2 || room.tttGame.phase !== "pending") return;
      broadcast(room, "ttt-declined", { from: p2 });
      room.tttGame = null;
      clearActiveGame(room);
    }, CHALLENGE_TIMEOUT_MS),
    board: Array(9).fill(""),
    turn: 0,
  };
  setActiveGame(room, { kind: "ttt", by: p1, target: p2 });
  send(tw, "ttt-challenged", { from: p1 });
  broadcast(room, "ttt-pending", { p1, p2 });
  return true;
}

function startSaboteur(room: Room, starter: string): boolean {
  if (room.saboteurActive) return false;
  const m = members(room);
  if (!m.includes(starter)) return false;
  if (m.length < SABOTEUR_MIN_PLAYERS) return false;

  room.saboteurActive = true;
  room.sabStrikes = 0;
  room.sabCanStrike = true;
  room.saboteur = m[unbiasedRandomIndex(m.length)];
  setActiveGame(room, { kind: "saboteur", by: starter });

  broadcast(room, "sab-started", { starter });
  const sabWs = findWs(room, room.saboteur);
  if (sabWs) send(sabWs, "sab-role", { role: "saboteur", canStrike: true });
  for (const name of m) {
    if (name !== room.saboteur) {
      const w = findWs(room, name);
      if (w) send(w, "sab-role", { role: "defender" });
    }
  }
  return true;
}

function startKoth(room: Room, challenger: string): boolean {
  const cw = findWs(room, challenger);
  if (!cw) return false;
  const cd = cw.data as WSData;
  if (cd.isHost) return false;
  if (room.rpsGame) return false;
  const hostWs = getHostWs(room);
  if (!hostWs || !room.host) return false;
  const hostName = room.host.name;

  room.kothGame = { challenger, host: hostName };
  room.rpsGame = {
    p1: challenger,
    p2: hostName,
    phase: "playing",
    koth: true,
    timer: setTimeout(() => {
      if (!room.rpsGame?.koth) return;
      broadcast(room, "rps-declined", { from: "game timeout" });
      room.rpsGame = null;
      room.kothGame = null;
      clearActiveGame(room);
    }, GAME_PLAY_TIMEOUT_MS),
  };
  setActiveGame(room, { kind: "koth", by: challenger, target: hostName });
  broadcast(room, "koth-started", { challenger, host: hostName });
  broadcast(room, "rps-started", { p1: challenger, p2: hostName, koth: true });
  return true;
}

// --- vote (pillow fight) ---

function onStartVote(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (msg.target === d.name) return send(ws, "error", { message: "you can't vote yourself out" });
  if (!members(room).includes(msg.target)) return;
  if (members(room).length < 3) return send(ws, "error", { message: "need at least 3 people to start a vote" });
  if (room.activeGame) {
    queueGame(room, { kind: "vote", by: d.name, target: msg.target }, ws);
    return;
  }
  if (room.activeVote) return send(ws, "error", { message: "a vote is already in progress" });

  if (!startVote(room, d.name, msg.target)) {
    send(ws, "error", { message: "could not start vote right now" });
  }
}

function onCastVote(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.activeVote) return;
  if (msg.vote !== "yes" && msg.vote !== "no") return;
  if (d.name === room.activeVote.target) return;
  if (room.activeVote.yes.has(d.name) || room.activeVote.no.has(d.name)) return;

  if (msg.vote === "yes") room.activeVote.yes.add(d.name);
  else room.activeVote.no.add(d.name);

  broadcast(room, "vote-cast", { voter: d.name, vote: msg.vote });

  const eligible = members(room).filter(n => n !== room.activeVote!.target).length;
  const total = room.activeVote.yes.size + room.activeVote.no.size;
  if (total >= eligible) resolveVote(room);
}

function resolveVote(room: Room) {
  if (!room.activeVote) return;
  clearTimeout(room.activeVote.timer);
  const { target, yes, no, starter, auto } = room.activeVote;
  const eligible = members(room).filter((name) => name !== target).length;
  const ejected = voteHasMajority(yes.size, no.size, eligible);
  broadcast(room, "vote-result", { target, yes: yes.size, no: no.size, ejected });
  if (!auto) {
    if (ejected) bumpLeaderboard(room, "pillowFight", starter);
    else bumpLeaderboard(room, "pillowFight", target);
    emitLeaderboards(room);
  }

  if (ejected) {
    const ejectedHost = room.host?.name === target;
    const tw = findWs(room, target);
    if (tw) {
      send(tw, "ejected", { reason: "You were voted out of the fort!" });
      const td = tw.data as WSData;
      td.roomId = null;
      td.name = "";
      td.isHost = false;
    }
    // remove from room
    if (room.host && room.host.name === target) {
      room.host = null;
    } else {
      for (const [ws, n] of room.guests) {
        if (n === target) { room.guests.delete(ws); break; }
      }
    }
    broadcast(room, "member-left", { name: target });
    if (tw) try { tw.close(1000, "ejected"); } catch {}
    pruneGameQueue(room);
    if (ejectedHost) offerHost(room, target);
  }
  room.activeVote = null;
  clearActiveGame(room);
}

// --- RPS ---

function onRpsChallenge(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.target || d.name === msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (room.activeGame) {
    queueGame(room, { kind: "rps", by: d.name, target: msg.target }, ws);
    return;
  }
  if (room.rpsGame) return send(ws, "error", { message: "a duel is already in progress" });
  if (!findWs(room, msg.target)) return;
  if (!startRps(room, d.name, msg.target)) {
    send(ws, "error", { message: "could not start RPS right now" });
  }
}

function onRpsAccept(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame || d.name !== room.rpsGame.p2) return;
  if (room.rpsGame.phase !== "pending") return;
  if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
  room.rpsGame.timer = undefined;
  room.rpsGame.phase = "playing";
  room.rpsGame.timer = setTimeout(() => {
    if (!room.rpsGame || room.rpsGame.phase !== "playing") return;
    broadcast(room, "rps-declined", { from: "game timeout" });
    room.rpsGame = null;
    room.kothGame = null;
    clearActiveGame(room);
  }, GAME_PLAY_TIMEOUT_MS);
  broadcast(room, "rps-started", { p1: room.rpsGame.p1, p2: room.rpsGame.p2 });
}

function onRpsDecline(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame || d.name !== room.rpsGame.p2) return;
  if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
  broadcast(room, "rps-declined", { from: d.name });
  room.rpsGame = null;
  if (room.kothGame) room.kothGame = null;
  clearActiveGame(room);
}

function onRpsPick(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.pick) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame) return;
  if (room.rpsGame.phase !== "playing") return;
  if (!isRpsPick(msg.pick)) return;

  if (d.name === room.rpsGame.p1) {
    if (room.rpsGame.pick1) return;
    room.rpsGame.pick1 = msg.pick;
  } else if (d.name === room.rpsGame.p2) {
    if (room.rpsGame.pick2) return;
    room.rpsGame.pick2 = msg.pick;
  }
  else return;

  send(ws, "rps-picked", {});

  if (room.rpsGame.pick1 && room.rpsGame.pick2) {
    const { p1, p2, pick1, pick2 } = room.rpsGame;
    if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
    const winner = rpsWinner(p1, p2, pick1, pick2);
    const isKoth = !!room.kothGame;
    broadcast(room, "rps-result", { p1, p2, pick1, pick2, winner, koth: isKoth || undefined });
    if (winner) {
      if (!isKoth) {
        bumpLeaderboard(room, "rps", winner);
        emitLeaderboards(room);
      }
    }
    room.rpsGame = null;
    if (isKoth && winner) resolveKoth(room, winner);
    else if (isKoth) {
      room.kothGame = null;
      clearActiveGame(room);
    } else {
      clearActiveGame(room);
    }
  }
}

// --- TTT ---

function onTttChallenge(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.target || d.name === msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (room.activeGame) {
    queueGame(room, { kind: "ttt", by: d.name, target: msg.target }, ws);
    return;
  }
  if (room.tttGame) return send(ws, "error", { message: "a game is already in progress" });
  if (!findWs(room, msg.target)) return;
  if (!startTtt(room, d.name, msg.target)) {
    send(ws, "error", { message: "could not start Tic-Tac-Toe right now" });
  }
}

function onTttAccept(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame || d.name !== room.tttGame.p2) return;
  if (room.tttGame.phase !== "pending") return;
  if (room.tttGame.timer) clearTimeout(room.tttGame.timer);
  room.tttGame.timer = undefined;
  room.tttGame.phase = "playing";
  room.tttGame.timer = setTimeout(() => {
    if (!room.tttGame || room.tttGame.phase !== "playing") return;
    broadcast(room, "ttt-declined", { from: "game timeout" });
    room.tttGame = null;
    clearActiveGame(room);
  }, GAME_PLAY_TIMEOUT_MS);
  broadcast(room, "ttt-started", { p1: room.tttGame.p1, p2: room.tttGame.p2, board: room.tttGame.board, turn: room.tttGame.turn });
}

function onTttDecline(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame || d.name !== room.tttGame.p2) return;
  if (room.tttGame.timer) clearTimeout(room.tttGame.timer);
  broadcast(room, "ttt-declined", { from: d.name });
  room.tttGame = null;
  clearActiveGame(room);
}

function onTttMove(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || msg.cell == null) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame) return;
  const g = room.tttGame;
  if (g.phase !== "playing") return;
  const currentPlayer = g.turn % 2 === 0 ? g.p1 : g.p2;
  if (d.name !== currentPlayer) return;
  if (!Number.isInteger(msg.cell) || msg.cell < 0 || msg.cell > 8 || g.board[msg.cell]) return;

  g.board[msg.cell] = g.turn % 2 === 0 ? "X" : "O";
  g.turn++;
  if (g.timer) clearTimeout(g.timer);
  g.timer = setTimeout(() => {
    if (room.tttGame !== g) return;
    broadcast(room, "ttt-declined", { from: "game timeout" });
    room.tttGame = null;
    clearActiveGame(room);
  }, GAME_PLAY_TIMEOUT_MS);

  const mark = g.board[msg.cell];
  let winner: string | null = null;
  if (tttWinner(g.board, mark)) winner = d.name;
  const draw = !winner && g.board.every(c => c);

  broadcast(room, "ttt-update", { board: g.board, turn: g.turn, lastMove: msg.cell, winner, draw });
  if (winner) {
    bumpLeaderboard(room, "ttt", winner);
    emitLeaderboards(room);
  }
  if (winner || draw) {
    if (g.timer) clearTimeout(g.timer);
    room.tttGame = null;
    clearActiveGame(room);
  }
}

// --- Saboteur ---

function onSabStart(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (room.saboteurActive) return send(ws, "error", { message: "saboteur mode is already active" });
  const m = members(room);
  if (m.length < SABOTEUR_MIN_PLAYERS) return send(ws, "error", { message: `need at least ${SABOTEUR_MIN_PLAYERS} people` });
  if (room.activeGame) {
    queueGame(room, { kind: "saboteur", by: d.name }, ws);
    return;
  }
  if (!startSaboteur(room, d.name)) {
    send(ws, "error", { message: "could not start Saboteur right now" });
  }
}

function onSabAccuse(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.suspect) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.saboteurActive) return;
  if (room.sabVote) return send(ws, "error", { message: "an accusation vote is already in progress" });
  if (d.name === room.saboteur) return send(ws, "error", { message: "saboteur can't accuse" });
  if (!members(room).includes(msg.suspect)) return;
  if (msg.suspect === d.name) return send(ws, "error", { message: "you can't accuse yourself" });

  room.sabVote = {
    accuser: d.name,
    suspect: msg.suspect,
    yes: new Set([d.name]),
    no: new Set(),
    timer: setTimeout(() => resolveSabVote(room), SABOTEUR_VOTE_MS),
  };
  broadcast(room, "sab-vote-start", {
    accuser: d.name,
    suspect: msg.suspect,
    duration: SABOTEUR_VOTE_MS,
    endsAt: Date.now() + SABOTEUR_VOTE_MS,
  });
}

function onSabVote(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.sabVote || !room.saboteurActive) return;
  if (msg.vote !== "yes" && msg.vote !== "no") return;

  room.sabVote.yes.delete(d.name);
  room.sabVote.no.delete(d.name);
  if (msg.vote === "yes") room.sabVote.yes.add(d.name);
  else room.sabVote.no.add(d.name);

  const total = room.sabVote.yes.size + room.sabVote.no.size;
  if (total >= members(room).length) resolveSabVote(room);
}

function resolveSabVote(room: Room) {
  if (!room.sabVote || !room.saboteurActive) return;
  clearTimeout(room.sabVote.timer);
  const { accuser, suspect, yes, no } = room.sabVote;
  const passed = yes.size > no.size;
  const correct = passed && suspect === room.saboteur;
  broadcast(room, "sab-vote-result", {
    accuser,
    accused: suspect,
    yes: yes.size,
    no: no.size,
    passed,
    wasSaboteur: correct,
    saboteur: correct ? room.saboteur : null,
  });

  if (correct) {
    const sabName = room.saboteur!;
    for (const defender of members(room)) {
      if (defender !== sabName) bumpLeaderboard(room, "saboteur", defender);
    }
    emitLeaderboards(room);
    room.saboteurActive = false;
    room.sabCanStrike = false;
    room.saboteur = null;
    room.sabVote = null;

    // auto-start pillow fight vote against the caught saboteur
    clearActiveGame(room, false);
    if (!room.activeVote && members(room).length >= 3 && members(room).includes(sabName)) {
      startVote(room, sabName, sabName, { auto: true, starterLabel: "the fort" });
    } else {
      drainGameQueue(room);
    }
  } else {
    room.sabVote = null;
    if (!room.sabCanStrike && room.saboteur) {
      room.sabCanStrike = true;
      const sabWs = findWs(room, room.saboteur);
      if (sabWs) send(sabWs, "sab-strike-ready", { reason: "wrong-accusation" });
    }
  }
}

function onSabStrike(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.saboteurActive || d.name !== room.saboteur) return;
  if (!room.sabCanStrike) return send(ws, "error", { message: "you can strike after a wrong accusation vote" });

  room.sabCanStrike = false;
  room.sabStrikes++;
  broadcast(room, "sab-strike", {
    strikes: room.sabStrikes,
    ...(room.sabStrikes >= 3 ? { saboteur: d.name } : {}),
  });

  if (room.sabStrikes >= 3) {
    // The saboteur plants a bomb. Let chat continue during countdown.
    bumpLeaderboard(room, "saboteur", d.name);
    emitLeaderboards(room);
    room.saboteurActive = false;
    room.sabCanStrike = false;
    room.saboteur = null;
    if (room.sabVote) { clearTimeout(room.sabVote.timer); room.sabVote = null; }
    if (room.sabBombTimer) clearTimeout(room.sabBombTimer);
    broadcast(room, "sab-bomb-start", { saboteur: d.name, seconds: SAB_BOMB_SECONDS, durationMs: SAB_BOMB_MS });
    room.sabBombTimer = setTimeout(() => {
      room.sabBombTimer = null;
      // Room may already be gone (host manual knockdown, etc.)
      if (!rooms.has(room.id)) return;
      destroy(room, "the saboteur's bomb exploded!");
    }, SAB_BOMB_MS);
  }
}

// --- KOTH ---

function onKothChallenge(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (d.isHost) return send(ws, "error", { message: "only non-hosts can challenge" });
  if (!room.host) return;
  if (room.activeGame) {
    queueGame(room, { kind: "koth", by: d.name, target: room.host.name }, ws);
    return;
  }
  if (room.rpsGame) return send(ws, "error", { message: "a duel is already in progress" });
  if (!startKoth(room, d.name)) {
    send(ws, "error", { message: "could not start KOTH right now" });
  }
}

function resolveKoth(room: Room, winner: string) {
  if (!room.kothGame) return;
  const { challenger, host } = room.kothGame;
  room.kothGame = null;

  if (winner === challenger) {
    // swap host
    const hostWs = findWs(room, host);
    const challWs = findWs(room, challenger);
    if (hostWs && room.host && room.host.name === host) {
      room.guests.set(hostWs, host);
      (hostWs.data as WSData).isHost = false;
      room.host = null;
    }
    if (challWs) {
      room.guests.delete(challWs);
      (challWs.data as WSData).isHost = true;
      room.host = { ws: challWs, name: challenger };
    }
    bumpLeaderboard(room, "koth", challenger);
    emitLeaderboards(room);
    broadcast(room, "new-host", { name: challenger });
    broadcast(room, "koth-result", { winner: challenger, loser: host });
  } else {
    bumpLeaderboard(room, "koth", host);
    emitLeaderboards(room);
    broadcast(room, "koth-result", { winner: host, loser: challenger });
  }
  clearActiveGame(room);
}

// --- draw passthrough ---

function onDraw(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  const now = Date.now();
  d.drawTimestamps = d.drawTimestamps.filter(t => now - t < 5_000);
  if (d.drawTimestamps.length >= MAX_DRAW_EVENTS_PER_5S) return send(ws, "error", { message: "slow down" });
  const draw = sanitizeDraw(msg);
  if (!draw) return;
  d.drawTimestamps.push(now);
  broadcast(room, "draw", { from: d.name, ...draw }, ws);
}

async function handleHttp(
  req: Request,
  server: any,
  allowLegacyWebSockets: boolean,
  webSocketPerimeter: LocalWebSocketPerimeterState,
  pendingAuthenticationRegistry: Set<any>,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  const probeReason = probeReasonForPath(url.pathname);
  if (probeReason) {
    logBlockedProbe(url.pathname);
    return blockedProbeResponse();
  }

  if (url.pathname === "/analytics") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!isStrictSameOriginRequest(req)) return new Response("forbidden", { status: 403 });
    if (!isJsonRequest(req)) return new Response("unsupported media type", { status: 415 });
    if (!await takeLocalPublicSurfaceSlot(req, server, "analytics")) {
      return new Response("rate limited", {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });
    }
    const event = await readAnalyticsEvent(req);
    if (!event) return new Response("bad analytics event", { status: 400 });
    console.log(analyticsLogLine(event));
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/fort-pass/redeem") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!isStrictSameOriginRequest(req)) return json({ error: "forbidden" }, 403);
    if (!isJsonRequest(req)) return json({ error: "unsupported_media_type" }, 415);
    if (!process.env.STRIPE_SECRET_KEY || !process.env.FORT_PASS_PRICE_ID || !process.env.STRIPE_WEBHOOK_SECRET) {
      return json({ error: "checkout_not_configured" }, 501);
    }
    const redemption = normalizeStripeRedemptionRequest(await readSmallJson(req));
    if (!redemption) return json({ error: "invalid_checkout_redemption" }, 400);
    if (!await takeLocalCheckoutSlot(req, server)) {
      return json(
        { error: "checkout_rate_limited" },
        429,
        { "retry-after": String(FORT_PASS_CHECKOUT_WINDOW_MS / 1_000) },
      );
    }
    const resolution = await resolveFortPassCheckoutSession(
      redemption.sessionId,
      redemption.customRoomCode,
      {
        secretKey: process.env.STRIPE_SECRET_KEY,
        priceId: process.env.FORT_PASS_PRICE_ID,
      },
    );
    if (resolution.status === "unavailable") return json({ error: "checkout_verification_failed" }, 502);
    if (resolution.status === "invalid" || resolution.status === "expired_unpaid") {
      return json({ error: "checkout_not_redeemable" }, 409);
    }
    const presentedClaimHash = await fortPassClaimHash(redemption.claimSecret);
    if (!constantTimeFortPassClaimHashEqual(presentedClaimHash, resolution.claimHash)) {
      return json({ error: "checkout_not_redeemable" }, 409);
    }
    if (resolution.status === "pending") {
      return json(
        { status: "pending", code: redemption.customRoomCode },
        202,
        { "retry-after": "1" },
      );
    }

    const fulfillment = await fulfillVerifiedLocalStripeSession(
      resolution.sessionId,
      resolution.claimHash,
      resolution.entitlement,
    );
    if (fulfillment.status === "fulfilled") {
      return json({
        redeemed: true,
        code: resolution.entitlement.roomId,
        ...(fulfillment.replay ? { replay: true } : {}),
      });
    }
    if (fulfillment.status === "busy") {
      return json(
        { status: "pending", code: redemption.customRoomCode },
        202,
        { "retry-after": "1" },
      );
    }
    if (fulfillment.status === "fulfillment_failed") {
      return json({ error: "checkout_not_redeemable" }, 409);
    }
    return json({ error: "checkout_redemption_unavailable" }, 503);
  }

  if (url.pathname === "/api/stripe/webhook") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "not_configured", status: 501 });
      return json({ error: "webhook_not_configured" }, 501);
    }
    const body = await readByteLimitedText(req, 64 * 1024);
    if (!body.ok || !body.text) {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "bad_payload", status: 400 });
      return json({ error: "bad_webhook_payload" }, 400);
    }
    const payload = body.text;
    const verification = await verifyStripeWebhookSignature(
      payload,
      req.headers.get("stripe-signature"),
      webhookSecret
    );
    if (!verification.ok) {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "bad_signature", status: 400 });
      return json({ error: "bad_webhook_signature" }, 400);
    }
    if (!process.env.STRIPE_SECRET_KEY || !process.env.FORT_PASS_PRICE_ID) {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "not_configured", status: 501 });
      return json({ error: "webhook_not_configured" }, 501);
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "bad_payload", status: 400 });
      return json({ error: "bad_webhook_payload" }, 400);
    }

    const revocation = await resolveFortPassRevocationFromStripeEvent(event, {
      secretKey: process.env.STRIPE_SECRET_KEY,
      priceId: process.env.FORT_PASS_PRICE_ID,
    });
    if (revocation.status !== "ignored") {
      if (revocation.status === "invalid") {
        logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", {
          reason: `revocation_${revocation.reason}`,
          status: 200,
        });
        return json({ received: true, ignored: true });
      }
      if (revocation.status === "unavailable") {
        logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", {
          reason: "revocation_provider_unavailable",
          status: 502,
        });
        return json({ error: "revocation_verification_failed" }, 502);
      }
      const outcome = await revokeVerifiedLocalStripeSession(
        revocation.eventId,
        revocation.sessionId,
        revocation.roomId,
        revocation.reason,
      );
      if (outcome.status === "processed") {
        return json({
          received: true,
          processed: true,
          ...(outcome.revoked ? { revoked: true } : {}),
          ...(outcome.stale ? { stale: true } : {}),
          ...(outcome.replay ? { replay: true } : {}),
        });
      }
      if (outcome.status === "busy") {
        return json(
          { error: "entitlement_revocation_in_progress" },
          503,
          { "retry-after": String(STRIPE_FULFILLMENT_LEASE_MS / 1_000) },
        );
      }
      return json({
        error: outcome.status === "ledger_completion_failed"
          ? "revocation_ledger_completion_failed"
          : "revocation_ledger_unavailable",
      }, 503);
    }

    const resolution = await resolveFortPassEntitlementFromStripeEvent(event, {
      secretKey: process.env.STRIPE_SECRET_KEY,
      priceId: process.env.FORT_PASS_PRICE_ID,
    });
    if (resolution.status === "ignored") return json({ received: true, ignored: true });
    if (resolution.status === "invalid") {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", {
        reason: resolution.reason,
        status: 200,
      });
      return json({ received: true, ignored: true });
    }
    if (resolution.status === "unavailable") {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "provider_unavailable", status: 502 });
      return json({ error: "checkout_verification_failed" }, 502);
    }

    const fulfillment = await fulfillVerifiedLocalStripeSession(
      resolution.sessionId,
      resolution.claimHash,
      resolution.entitlement,
    );
    if (fulfillment.status === "fulfilled") {
      return json({
        received: true,
        fulfilled: true,
        code: resolution.entitlement.roomId,
        ...(fulfillment.replay ? { replay: true } : {}),
      });
    }
    if (fulfillment.status === "busy") {
      return json(
        { error: "entitlement_fulfillment_in_progress" },
        503,
        { "retry-after": String(STRIPE_FULFILLMENT_LEASE_MS / 1_000) },
      );
    }
    if (fulfillment.status === "ledger_unavailable") {
      return json({ error: "entitlement_ledger_unavailable" }, 503);
    }
    if (fulfillment.status === "fulfillment_failed") {
      logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "fulfillment_failed", status: 409 });
      return json({ error: "entitlement_fulfillment_failed" }, 409);
    }
    logRateLimitedOpsEvent("stripe-webhook-local", "stripe_webhook_failed", { reason: "ledger_completion_failed", status: 502 });
    return json({ error: "entitlement_ledger_completion_failed" }, 502);
  }

  if (url.pathname === "/api/fort-pass/code") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const codeParameters = url.searchParams.getAll("code");
    const code = codeParameters.length === 1 ? normalizeCustomRoomCode(codeParameters[0]) : null;
    if (code && !await takeLocalPublicSurfaceSlot(req, server, "fort-pass-code")) {
      return new Response(JSON.stringify({ error: "code_check_rate_limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": "60",
        },
      });
    }
    const availability = code
      ? customRoomCodeAvailability(code, localRoomExists(code) || hasActivePendingFortPass(code) || hasActiveFortPassReservation(code))
      : customRoomCodeAvailability(null, false);
    return json(availability);
  }

  if (url.pathname === "/api/fort-pass/status") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const publicOrigin = checkoutPublicOrigin(process.env.PUBLIC_BASE_URL, url);
    return json({
      beta: true,
      checkoutConfigured: Boolean(
        process.env.STRIPE_SECRET_KEY
        && process.env.FORT_PASS_PRICE_ID
        && process.env.STRIPE_WEBHOOK_SECRET
        && publicOrigin
      ),
      priceLabel: "$5",
      perks: ["custom_code", "extended_idle", "theme_pack"],
    });
  }

  if (url.pathname === "/api/fort-pass/checkout") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!isStrictSameOriginRequest(req)) return json({ error: "forbidden" }, 403);
    if (!isJsonRequest(req)) return json({ error: "unsupported_media_type" }, 415);
    const checkout = normalizeFortPassCheckoutRequest(await readSmallJson(req));
    if (!checkout) return json({ error: "invalid_custom_room_code" }, 400);
    const publicOrigin = checkoutPublicOrigin(process.env.PUBLIC_BASE_URL, url);
    if (!process.env.STRIPE_SECRET_KEY || !process.env.FORT_PASS_PRICE_ID || !process.env.STRIPE_WEBHOOK_SECRET || !publicOrigin) {
      return json({ error: "checkout_not_configured", code: checkout.customRoomCode }, 501);
    }
    if (!await takeLocalCheckoutSlot(req, server)) {
      return new Response(JSON.stringify({ error: "checkout_rate_limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": String(FORT_PASS_CHECKOUT_WINDOW_MS / 1_000),
        },
      });
    }
    if (localRoomExists(checkout.customRoomCode) || hasActivePendingFortPass(checkout.customRoomCode) || hasActiveFortPassReservation(checkout.customRoomCode)) {
      return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
    }
    const reservationToken = createStripeFulfillmentClaimToken();
    let reservation = claimLocalFortPassReservation(
      checkout.customRoomCode, reservationToken, checkout.claimHash,
    );
    if (reservation.status === "supersession_required") {
      const prior = await resolveFortPassCheckoutSession(
        reservation.sessionId,
        checkout.customRoomCode,
        {
          secretKey: process.env.STRIPE_SECRET_KEY,
          priceId: process.env.FORT_PASS_PRICE_ID,
        },
      );
      if (prior.status === "verified") {
        const fulfillment = await fulfillVerifiedLocalStripeSession(
          prior.sessionId, prior.claimHash, prior.entitlement,
        );
        if (fulfillment.status === "fulfilled") {
          return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
        }
        return json({ error: "checkout_reservation_unavailable" }, 503);
      }
      if (prior.status !== "expired_unpaid") {
        return json(
          { error: prior.status === "pending" ? "custom_room_code_taken" : "checkout_reservation_unavailable" },
          prior.status === "pending" ? 409 : 503,
        );
      }
      reservation = claimLocalFortPassReservation(
        checkout.customRoomCode,
        reservationToken,
        checkout.claimHash,
        prior.sessionId,
      );
    }
    if (reservation.status === "conflict") {
      return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
    }
    if (reservation.status !== "claimed") {
      return json({ error: "checkout_reservation_unavailable" }, 503);
    }
    try {
      const session = await createFortPassStripeCheckoutSession({
        secretKey: process.env.STRIPE_SECRET_KEY,
        priceId: process.env.FORT_PASS_PRICE_ID,
        publicBaseUrl: publicOrigin,
        customRoomCode: checkout.customRoomCode,
        claimHash: checkout.claimHash,
      });
      const checkoutUrl = normalizeStripeHostedCheckoutUrl(session.url);
      if (!checkoutUrl) throw new Error("invalid Stripe-hosted checkout URL");
      if (!bindLocalFortPassReservation(
        checkout.customRoomCode,
        reservationToken,
        session.id,
      )) {
        return json({ error: "checkout_reservation_unavailable" }, 503);
      }
      return json({ code: checkout.customRoomCode, checkoutUrl, sessionId: session.id });
    } catch {
      // The provider may have created a payable Session before a timeout was
      // observed locally. Retain the reservation until its bounded expiry so
      // the code cannot be reallocated underneath a late successful payment.
      return json({ error: "checkout_provider_error" }, 502);
    }
  }

  if (url.pathname === "/ws") {
    if (!isStrictSameOriginRequest(req)) {
      logRateLimitedOpsEvent("ws-local", "ws_rejected", { reason: "bad_origin", surface: "local", status: 403 });
      return new Response("forbidden", { status: 403 });
    }
    if (!hasOnlyAllowedSearchParameters(url, ["room", "protocol"])) {
      logRateLimitedOpsEvent("ws-local", "ws_rejected", { reason: "unexpected_parameters", surface: "local", status: 400 });
      return new Response("invalid websocket parameters", { status: 400 });
    }
    const ip = server.requestIP(req)?.address || "unknown";
    if (url.searchParams.getAll("room").length > 1) {
      return new Response("invalid room", { status: 400 });
    }
    const rawRoomParam = url.searchParams.get("room") || "";
    const canonicalRoomParam = rawRoomParam ? normalizeRoomId(rawRoomParam) : null;
    if (rawRoomParam && (!canonicalRoomParam || canonicalRoomParam !== rawRoomParam)) {
      logRateLimitedOpsEvent("ws-local", "ws_rejected", { reason: "invalid_room", surface: "local", status: 400 });
      return new Response("invalid room", { status: 400 });
    }
    const protocolParameters = url.searchParams.getAll("protocol");
    if (protocolParameters.length !== 1) {
      return new Response("explicit websocket protocol required", { status: 426 });
    }
    const protocolParameter = protocolParameters[0];
    const requestedV4 = protocolParameter === "4";
    const requestedLegacy = protocolParameter === "legacy";
    if (!requestedV4 && !(allowLegacyWebSockets && requestedLegacy)) {
      return new Response("protocol v4 required", { status: 426 });
    }
    if (requestedV4 && !canonicalRoomParam) {
      return new Response("protocol v4 requires a room", { status: 400 });
    }
    // Legacy sockets exist only behind the explicit local-development opt-in.
    // Keep the server-wide abuse perimeter dedicated to the production v4
    // surface so legacy compatibility tests cannot exhaust v4 capacity.
    if (requestedV4 && !takeLocalWebSocketOpenSlot(webSocketPerimeter, ip)) {
      logRateLimitedOpsEvent("ws-local", "ws_rejected", { reason: "rate_limited", surface: "local", status: 429 });
      return new Response("websocket open rate limited", {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });
    }
    if ((canonicalRoomParam && secureRooms.has(canonicalRoomParam) && !requestedV4)
      || (canonicalRoomParam && rooms.has(canonicalRoomParam) && requestedV4)) {
      return new Response("protocol mismatch", { status: 409 });
    }
    const ok = server.upgrade(req, {
      data: {
        roomId: canonicalRoomParam,
        isHost: false,
        hostRejected: false,
        name: "",
        status: "available",
        awayText: null,
        hash: secureRandomHex(2),
        ip,
        msgTimestamps: [],
        drawTimestamps: [],
        authChallenge: createRoomAuthChallenge(),
        authChallengeCreatedAt: Date.now(),
        authAttempted: false,
        authenticated: false,
        preAuthFrames: 0,
        protocol: requestedV4 ? "v4" : "legacy",
        secureConnectionId: generateSecureRelayIdV4(),
        secureAuthenticated: false,
        pendingAuthenticationRegistry,
      } satisfies WSData,
    });
    return ok ? undefined : new Response("upgrade failed", { status: 400 });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { "allow": "GET, HEAD", "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/activity") {
    return staticFileResponse("/index.html");
  }

  // Room links use one canonical namespace. Human-entered uppercase aliases
  // redirect to lowercase before any room authentication or state lookup.
  const rawRoomPath = url.pathname.slice(1);
  const canonicalRoomPath = normalizeRoomId(rawRoomPath);
  if (canonicalRoomPath) {
    if (rawRoomPath !== canonicalRoomPath) {
      return new Response(null, {
        status: 308,
        headers: {
          // A relative Location cannot be turned into an external redirect by
          // a spoofed Host header at a development reverse proxy.
          "location": `/${canonicalRoomPath}${url.search}`,
          "cache-control": "no-store",
        },
      });
    }
    return staticFileResponse("/index.html");
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  return staticFileResponse(path);
}

// --- server ---

export interface LocalServerOptions {
  /** Test-only compatibility surface; production and normal local use stay v4-only. */
  allowLegacyWebSockets?: boolean;
  /** Tests may lower, but never raise, production security ceilings. */
  maxWebSocketOpensPerMinute?: number;
  maxPendingAuthenticationsPerRoom?: number;
  preAuthTimeoutMs?: number;
}

export function startLocalServer(port = PORT, options: LocalServerOptions = {}) {
  // Legacy transport exists solely to exercise compatibility tests. An env
  // flag or programmatic option must never reopen it in a deployed/dev server.
  const allowLegacyWebSockets = process.env.NODE_ENV === "test"
    && options.allowLegacyWebSockets === true;
  const boundedOption = (value: number | undefined, ceiling: number) =>
    Number.isSafeInteger(value) && value! >= 1 && value! <= ceiling ? value! : ceiling;
  const maxWebSocketOpensPerMinute = boundedOption(
    options.maxWebSocketOpensPerMinute,
    MAX_LOCAL_WS_OPENS_PER_MINUTE,
  );
  const maxPendingAuthenticationsPerRoom = boundedOption(
    options.maxPendingAuthenticationsPerRoom,
    MAX_LOCAL_UNAUTHENTICATED_SOCKETS_PER_ROOM,
  );
  const preAuthTimeoutMs = boundedOption(options.preAuthTimeoutMs, ROOM_AUTH_CHALLENGE_TTL_MS);
  const webSocketPerimeter: LocalWebSocketPerimeterState = {
    opensByIp: new Map(),
    maxOpensPerMinute: maxWebSocketOpensPerMinute,
  };
  const localUnauthenticatedSockets = new Set<any>();
  const localServer = Bun.serve({
    port,

  async fetch(req, server) {
    const response = await handleHttp(
      req,
      server,
      allowLegacyWebSockets,
      webSocketPerimeter,
      localUnauthenticatedSockets,
    );
    const mode: SecurityHeaderMode = isDiscordActivityRequest(req) ? "discord-activity" : "default";
    return response ? withSecurityHeaders(response, mode) : undefined;
  },

  websocket: {
    open(ws) {
      const d = ws.data as WSData;
      let pendingForRoom = 0;
      for (const pendingSocket of localUnauthenticatedSockets) {
        const pendingData = pendingSocket.data as WSData;
        if (pendingData.roomId === d.roomId) pendingForRoom++;
      }
      if (localUnauthenticatedSockets.size >= MAX_LOCAL_UNAUTHENTICATED_SOCKETS
        || pendingForRoom >= maxPendingAuthenticationsPerRoom) {
        closeLocalPendingAuthentication(ws, "too many pending authentications");
        return;
      }
      localUnauthenticatedSockets.add(ws);
      const authTimer = setTimeout(() => {
        if (d.authTimer !== authTimer) return;
        d.authTimer = undefined;
        if (!d.authenticated && !d.secureAuthenticated) {
          closeLocalPendingAuthentication(ws, "authentication timeout");
        }
      }, Math.max(0, d.authChallengeCreatedAt + preAuthTimeoutMs - Date.now()));
      d.authTimer = authTimer;
      const secureRoom = d.roomId ? secureRooms.get(d.roomId) : null;
      if (d.protocol === "v4" && d.roomId && d.secureConnectionId) {
        const challenge = parseSecureAuthChallengeFrameV4({
          kind: "secure-auth-challenge",
          v: 4,
          suite: 1,
          connectionId: d.secureConnectionId,
          challenge: d.authChallenge,
          roomInstance: secureRoom?.state.roomInstance || null,
        });
        if (challenge) sendSecure(ws, challenge);
      }
      if (d.protocol === "legacy") {
        send(ws, "auth-challenge", {
          challenge: d.authChallenge,
          expiresAt: d.authChallengeCreatedAt + ROOM_AUTH_CHALLENGE_TTL_MS,
        });
      }
    },
    async message(ws, raw) {
      try {
        const d = ws.data as WSData;
        if (typeof raw !== "string") {
          d.pendingAuthenticationRegistry?.delete(ws);
          d.pendingAuthenticationRegistry = undefined;
          ws.close(1003, "text frames required");
          return;
        }
        const rawBytes = new TextEncoder().encode(raw).byteLength;
        const frameLimit = d.protocol === "v4"
          ? MAX_SECURE_WEBSOCKET_FRAME_BYTES
          : MAX_WEBSOCKET_FRAME_BYTES;
        if (raw.length > frameLimit || rawBytes > frameLimit) {
          d.pendingAuthenticationRegistry?.delete(ws);
          d.pendingAuthenticationRegistry = undefined;
          ws.close(1009, "frame too large");
          return;
        }
        if (!d.authenticated && !d.secureAuthenticated) {
          d.preAuthFrames++;
          if (d.preAuthFrames > 3) {
            closeLocalPendingAuthentication(ws, "too many pre-auth frames");
            return;
          }
        }
        if (d.secureAuthenticated) {
          const now = Date.now();
          const secureRoom = d.roomId ? secureRooms.get(d.roomId) || null : null;
          if (!takeLocalSecureRoomFrameSlot(secureRoom, ws, d, now)) {
            sendSecureError(ws, "rate-limited");
            try { ws.close(1008, "rate limit exceeded"); } catch {}
            return;
          }
        }
        const msg = JSON.parse(raw);
        const secureAuthenticate = parseSecureAuthenticateFrameV4(msg);
        if (secureAuthenticate) {
          if (d.protocol !== "v4" || d.authenticated || d.secureAuthenticated
            || (d.roomId ? rooms.has(d.roomId) : false)) {
            rejectLocalSecureAuthentication(ws, "downgrade", "protocol mismatch");
            return;
          }
          await onLocalSecureAuthenticate(ws, d, secureAuthenticate);
          return;
        }
        if (msg?.kind === "secure-authenticate") {
          rejectLocalSecureAuthentication(ws, "invalid-frame", "invalid authentication frame");
          return;
        }
        if (d.secureAuthenticated) {
          const secureFrame = parseSecurePostAuthClientFrameV4(msg);
          if (!secureFrame) {
            sendSecureError(ws, "invalid-frame");
            return;
          }
          // Every mutation-bearing MLS frame is causally preceded by one
          // order request. Charge that initiator request once; ACKs, host
          // decisions, admission controls, and the granted relay frame remain
          // covered by the independent raw/socket and room-wide caps.
          if (secureFrame.kind === "order-request" &&
              !takeLocalSecureRoomOperationSlot(d, Date.now())) {
            sendSecureError(ws, "rate-limited");
            try { ws.close(1008, "rate limit exceeded"); } catch {}
            return;
          }
          await onLocalSecureFrame(ws, d, secureFrame);
          return;
        }
        if (d.protocol === "v4") {
          rejectLocalSecureAuthentication(ws, "invalid-frame", "invalid authentication frame");
          return;
        }
        if (d.roomId && secureRooms.has(d.roomId)) {
          rejectLocalSecureAuthentication(ws, "downgrade", "protocol mismatch");
          return;
        }
        if (!d.authenticated && msg.type !== "set-up" && msg.type !== "join" && msg.type !== "rejoin") {
          ws.close(1008, "authenticate first");
          return;
        }
        switch (msg.type) {
          case "set-up":       await onSetUp(ws, d, msg); break;
          case "join":         await onJoin(ws, d, msg); break;
          case "rejoin":       await onRejoin(ws, d, msg); break;
          case "chat":         onChat(ws, d, msg); break;
          case "knock-down":   onKnockDown(ws, d); break;
          case "typing":       onTyping(ws, d); break;
          case "set-status":   onSetStatus(ws, d, msg); break;
          case "set-theme":    onSetTheme(ws, d, msg); break;
          case "leave":        onLeave(ws, d); break;
          case "accept-host":  onAcceptHost(ws, d); break;
          case "reject-host":  onRejectHost(ws, d); break;
          case "toss-pillow":  onTossPillow(ws, d, msg); break;
          case "draw":         onDraw(ws, d, msg); break;
          // pvp games
          case "start-vote":    onStartVote(ws, d, msg); break;
          case "cast-vote":     onCastVote(ws, d, msg); break;
          case "rps-challenge": onRpsChallenge(ws, d, msg); break;
          case "rps-accept":    onRpsAccept(ws, d); break;
          case "rps-decline":   onRpsDecline(ws, d); break;
          case "rps-pick":      onRpsPick(ws, d, msg); break;
          case "ttt-challenge": onTttChallenge(ws, d, msg); break;
          case "ttt-accept":    onTttAccept(ws, d); break;
          case "ttt-decline":   onTttDecline(ws, d); break;
          case "ttt-move":      onTttMove(ws, d, msg); break;
          case "sab-start":     onSabStart(ws, d); break;
          case "sab-accuse":    onSabAccuse(ws, d, msg); break;
          case "sab-strike":    onSabStrike(ws, d); break;
          case "sab-vote":      onSabVote(ws, d, msg); break;
          case "koth-challenge": onKothChallenge(ws, d); break;
        }
      } catch {
        const d = ws.data as WSData;
        if (d.protocol === "v4") {
          if (d.secureAuthenticated) sendSecureError(ws, "invalid-frame");
          else rejectLocalSecureAuthentication(ws, "invalid-frame", "invalid authentication frame");
        }
      }
    },
    close(ws) {
      const data = ws.data as WSData;
      localUnauthenticatedSockets.delete(ws);
      data.pendingAuthenticationRegistry = undefined;
      if (data.authTimer) clearTimeout(data.authTimer);
      data.authTimer = undefined;
      if (data.secureAuthenticated) void onLocalSecureDisconnect(ws, data);
      else onDisconnect(ws, data);
    },
    maxPayloadLength: MAX_SECURE_WEBSOCKET_FRAME_BYTES,
  },
  });

  console.log(`pillowfort :${localServer.port}`);
  return localServer;
}

if (import.meta.main) {
  startLocalServer(PORT, {
    allowLegacyWebSockets: process.env.PILLOWFORT_ALLOW_LEGACY_WS === "1",
  });
}
