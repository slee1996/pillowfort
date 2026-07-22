import type {
  SecureApplicationContentV4,
  SecureRpsPickV4,
  SecureRoomStateSnapshotV4,
} from "../../../src/applicationEventsV4";
import { isSecureDisplayNameV4 } from "../../../src/applicationEventsV4";
import { decodeSecureAdmissionBundleV4, encodeSecureAdmissionBundleV4 } from "../../../src/admissionBundleV4";
import { computeRpsCommitmentV4, computeSaboteurCommitmentV4, type SecureReducerEffectV4 } from "../../../src/secureGameReducer";
import { normalizeRoomId } from "../../../src/entitlements";
import {
  parseRoomInvitationMemberBindingV4,
  secureKeyPackageDigestV4,
  type RoomInvitationMemberBindingV4,
} from "../../../src/roomInvitationMemberBindingV4";
import {
  MAX_SECURE_WEBSOCKET_FRAME_BYTES,
  SECURE_ROOM_ID_BYTES,
  canonicalBase64UrlByteLength,
  type SecureMemberHelloV4,
  type SecureRelayEnvelopeV4,
} from "../../../src/protocolV4";
import {
  MAX_SECURE_ZOMBIE_REMOVALS_V4,
  SECURE_ADMISSION_TTL_MS_V4,
  type SecureClientFrameV4,
  type SecureLogicalOrderGrantV4,
  type SecureRelayFrameV4,
} from "../../../src/secureRelayV4";
/*
 * Keep all transport-bound admission metadata opaque. A display name is sent
 * only later, inside the encrypted join proof.
 */
import type {
  PendingAdmission,
} from "../stores/gameStore";
import {
  parseSecureAuthChallengeFrameV4,
  parseSecureAuthenticateFrameV4,
  parseSecurePostAuthClientFrameV4,
  parseSecureServerFrameV4,
  type SecureAuthChallengeFrameV4,
  type SecureAuthenticateFrameV4,
  type SecureServerFrameV4,
} from "../../../src/secureTransportV4";
import { fromBase64Url, toBase64Url } from "../../../src/roomAuth";
import { useGameStore } from "../stores/gameStore";
import {
  createRoomInvitationAuthV4,
  createRoomInvitationMemberBindingV4,
  secureRoomInvitationSafetyCodeV4,
  verifyRoomInvitationMemberBindingWithSecretV4,
} from "./secureInvitationAuth";
import {
  SecureRoomEngine,
  SecureRoomEngineError,
  type SecureRoomCommitResult,
  type SecureRoomInboundRelayContext,
  type SecureRoomOutboundApplicationResult,
  type SecureRoomRetirementBarrierV4,
} from "./secureRoomEngine";
import {
  randomSecureRoomIdV4,
  secureRoomOpaqueStoreKey,
  type SecureRoomPendingOutboxEntryV1,
} from "./secureRoomState";
import {
  RoomCryptoLockCoordinator,
  type AcquireRoomCryptoLockOptions,
  type RoomCryptoLockAcquireResult,
  type RoomCryptoLockLease,
} from "./roomCryptoLock";
import {
  applySecureRoomUiV4,
  initializeSecureRoomUiV4,
  resetSecureRoomUiV4,
  secureDeviceIdForNameV4,
} from "./secureUiV4";
import {
  deriveProtocolRoomSecret,
  isGeneratedRoomSecret,
  validateCustomRoomSecret,
  validateRoomSecret,
} from "./roomSecret";

const UTF8 = new TextEncoder();
const RECOVERY_SESSION_KEY = "pillowfort:secure-room-recovery:v1";
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_QUEUED_ACTIONS = 64;
const RECONNECT_MAX_DELAY_MS = 30_000;
const VOTE_DURATION_MS = 30_000;
const SABOTEUR_VOTE_DURATION_MS = 30_000;
const SABOTEUR_ENTROPY_DURATION_MS = 30_000;
const DRAW_SUBMISSION_INTERVAL_MS = 250;
const MAX_PENDING_HOST_ADMISSIONS = 8;
const MAX_TRACKED_TRANSIENT_CONTROLS = 256;
const MAX_TRACKED_OUTBOUND_UI = MAX_QUEUED_ACTIONS + 8;
const HOST_ADMISSION_APPROVAL_WINDOW_MS = Math.max(1_000, SECURE_ADMISSION_TTL_MS_V4 - 5_000);
export const SECURE_PCS_UPDATE_INTERVAL_MS = 15 * 60_000;

export type SecureRoomConnectResult =
  | { status: "connected"; roomInstance: string }
  | Exclude<RoomCryptoLockAcquireResult, { status: "acquired" }>
  | { status: "failed"; reason: "invalid-input" | "authentication-failed" | "rate-limited" | "unavailable" | "recovery-required" | "recovery-credential-mismatch" | "socket-failed" | "aborted" };

export interface SecureRoomStartOptions {
  roomId: string;
  roomSecret: string;
  displayName: string;
  fortPassSessionId?: string;
  fortPassClaimSecret?: string;
  lock?: AcquireRoomCryptoLockOptions;
}

interface SessionConfig {
  initialMode: "setup" | "join";
  /** An earlier authentication frame may have committed; never mint a replacement identity. */
  recoveryOnly: boolean;
  roomId: string;
  roomSecret: string;
  roomSecretResolvedFor: string | null;
  displayName: string;
  fortPassSessionId?: string;
  fortPassClaimSecret?: string;
  /** Exact protocol instance known before setup or learned from the relay before join authentication. */
  roomInstance: string | null;
  setupRoomInstance: string | null;
}

export interface SecureRoomRecoveryHint {
  mode: "setup" | "join";
  roomId: string;
  displayName: string;
}

interface SecureRoomRecoveryContext extends SecureRoomRecoveryHint {
  v: 1;
  roomInstance: string;
  savedAt: number;
}

function recoveryStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function loadRecoveryContext(): SecureRoomRecoveryContext | null {
  const storage = recoveryStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(RECOVERY_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!plainRecord(value) || Object.keys(value).sort().join(",") !==
        "displayName,mode,roomId,roomInstance,savedAt,v" || value.v !== 1 ||
        (value.mode !== "setup" && value.mode !== "join") ||
        typeof value.roomId !== "string" || normalizeRoomId(value.roomId) !== value.roomId ||
        typeof value.displayName !== "string" || !isSecureDisplayNameV4(value.displayName) ||
        !Number.isSafeInteger(value.savedAt) || (value.savedAt as number) < 0 ||
        Date.now() < (value.savedAt as number) || Date.now() - (value.savedAt as number) > RECOVERY_MAX_AGE_MS ||
        canonicalBase64UrlByteLength(value.roomInstance) !== SECURE_ROOM_ID_BYTES) {
      storage.removeItem(RECOVERY_SESSION_KEY);
      return null;
    }
    return value as unknown as SecureRoomRecoveryContext;
  } catch {
    try { storage.removeItem(RECOVERY_SESSION_KEY); } catch {}
    return null;
  }
}

function persistRecoveryContext(context: SecureRoomRecoveryContext | null): void {
  const storage = recoveryStorage();
  if (!storage) return;
  try {
    if (context) storage.setItem(RECOVERY_SESSION_KEY, JSON.stringify(context));
    else storage.removeItem(RECOVERY_SESSION_KEY);
  } catch {
    // Recovery remains available for this page lifetime when storage is blocked.
  }
}

interface GrantIntent {
  key: string;
  run(grant: SecureLogicalOrderGrantV4): Promise<string | null>;
}

interface PendingGrantIntent {
  requestId: string;
  intent: GrantIntent;
}

interface PendingHandshake {
  generation: number;
  settle(result: SecureRoomConnectResult): void;
}

interface OutboundUiResult {
  state: SecureRoomStateSnapshotV4;
  effects: readonly SecureReducerEffectV4[];
}

interface PendingHostAdmission {
  admissionId: string;
  fromDeviceId: string;
  deviceFingerprint: string;
  keyPackage: Uint8Array;
  keyPackageEncoding: string;
  memberBinding: RoomInvitationMemberBindingV4;
  status: PendingAdmission["status"];
  expiresAt: number;
  inFlight: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface LocationLike {
  protocol: string;
  host: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] as string : null;
}

function activeGame(state: SecureRoomStateSnapshotV4): boolean {
  return state.vote !== null || state.rps !== null || state.ttt !== null || state.saboteur !== null;
}

export function secureAdmissionBindingFingerprintV4(bindingValue: RoomInvitationMemberBindingV4): string {
  const binding = parseRoomInvitationMemberBindingV4(bindingValue);
  if (!binding) throw new TypeError("invalid secure admission member binding");
  return `${binding.proof.slice(0, 6)}-${binding.proof.slice(-4)}`;
}

/** @deprecated Use the invitation-bound fingerprint; a device-id-only fingerprint is unsafe. */
export const secureAdmissionDeviceFingerprintV4 = secureAdmissionBindingFingerprintV4;

function inboundRelayContext(
  frame: Exclude<SecureRelayFrameV4, { relayKind: "welcome" | "commit" }>,
): Exclude<SecureRoomInboundRelayContext, { kind: "commit" }>;
function inboundRelayContext(
  frame: Exclude<SecureRelayFrameV4, { relayKind: "welcome" }>,
): SecureRoomInboundRelayContext;
function inboundRelayContext(
  frame: Exclude<SecureRelayFrameV4, { relayKind: "welcome" }>,
): SecureRoomInboundRelayContext {
  switch (frame.relayKind) {
    case "commit":
      return frame.admissionId !== undefined
        ? { kind: "commit", admissionId: frame.admissionId }
        : frame.retirementDeviceId !== undefined
          ? {
              kind: "commit",
              retirementDeviceId: frame.retirementDeviceId,
              retirementAdmissionCommitMessageId: frame.retirementAdmissionCommitMessageId!,
            }
          : { kind: "commit" };
    case "application": return { kind: "application" };
    case "bootstrap": return {
      kind: "bootstrap", admissionId: frame.admissionId, welcomeMessageId: frame.welcomeMessageId,
    };
    case "join-proof": return {
      kind: "join-proof", admissionId: frame.admissionId, welcomeMessageId: frame.welcomeMessageId,
    };
    case "host-transfer-accept": return {
      kind: "host-transfer-accept", authorizationId: frame.authorizationId,
    };
  }
}

export function secureRoomWebSocketUrl(roomId: string, current: LocationLike = location): string {
  const canonical = normalizeRoomId(roomId);
  if (!canonical || canonical !== roomId) throw new TypeError("invalid canonical room id");
  const protocol = current.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ room: canonical, protocol: "4" });
  return `${protocol}//${current.host}/ws?${query.toString()}`;
}

export class SecureRoomController {
  private socket: WebSocket | null = null;
  private engine: SecureRoomEngine | null = null;
  private lease: RoomCryptoLockLease | null = null;
  private config: SessionConfig | null = null;
  private generation = 0;
  /** Monotonic identity for a single WebSocket within a controller session. */
  private socketEpoch = 0;
  private authenticated = false;
  /** True only for local MLS state that has never completed relay authentication. */
  private discardEngineOnAuthenticationFailure = false;
  /** The relay may have durably committed the most recently sent auth frame. */
  private authenticationMayHaveCommitted = false;
  /** One-shot recovery override for a locally-active join that is still pending at the relay. */
  private nextAuthenticationMode: "join" | "resume" | null = null;
  /** Non-secret tab-scoped pointer needed to retry an ambiguous authentication. */
  private recoveryContext: SecureRoomRecoveryContext | null = loadRecoveryContext();
  private recoverySetup: { roomId: string; roomInstance: string } | null =
    this.recoveryContext?.mode === "setup"
      ? { roomId: this.recoveryContext.roomId, roomInstance: this.recoveryContext.roomInstance }
      : null;
  /** Keeps Setup/Join mounted until a transmitted authentication attempt is resolved. */
  private unresolvedAuthentication = false;
  private authenticatedMode: "setup" | "join" | "resume" | null = null;
  private challengeHandled = false;
  private stopped = true;
  private terminal = false;
  private uiInitialized = false;
  private replayingBacklog = false;
  private roomStateSnapshotReceived = false;
  private resumeCompleteRequestId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private serialQueue: Promise<void> = Promise.resolve();
  private executingGeneration: number | null = null;
  private pendingHandshake: PendingHandshake | null = null;
  private readonly grantQueue: GrantIntent[] = [];
  private pendingGrant: PendingGrantIntent | null = null;
  private readonly intentKeys = new Set<string>();
  private readonly messageIntentKeys = new Map<string, string>();
  private readonly outboundUi = new Map<string, OutboundUiResult>();
  private readonly transientControlIds = new Set<string>();
  private voteTimer: ReturnType<typeof setTimeout> | null = null;
  private voteTimerGameId: string | null = null;
  private saboteurVoteTimer: ReturnType<typeof setTimeout> | null = null;
  private saboteurVoteTimerGameId: string | null = null;
  private saboteurEntropyTimer: ReturnType<typeof setTimeout> | null = null;
  private saboteurEntropyTimerPhase: string | null = null;
  private pcsTimer: ReturnType<typeof setTimeout> | null = null;
  private drawTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDrawing: { color: string; points: [number, number][]; strokeStart: boolean } | null = null;
  private lastDrawSubmissionAt = 0;
  private pcsDue = false;
  private readonly sentDurableControls = new Set<string>();
  private readonly pendingHostAdmissions = new Map<string, PendingHostAdmission>();
  /** Exact invitation-signed admission ids in relay-enforced retirement order. */
  private readonly retirementBarriers = new Map<string, string>();
  private localMemberBinding: RoomInvitationMemberBindingV4 | null = null;
  private founderBinding: RoomInvitationMemberBindingV4 | null = null;
  private lockCoordinator: RoomCryptoLockCoordinator;

  constructor(lockCoordinator = new RoomCryptoLockCoordinator()) {
    this.lockCoordinator = lockCoordinator;
  }

  get webSocket(): WebSocket | null {
    return this.socket;
  }

  get currentEngine(): SecureRoomEngine | null {
    return this.engine;
  }

  get pendingRecovery(): SecureRoomRecoveryHint | null {
    const recovery = this.recoveryContext;
    return recovery ? {
      mode: recovery.mode,
      roomId: recovery.roomId,
      displayName: recovery.displayName,
    } : null;
  }

  async setup(options: SecureRoomStartOptions): Promise<SecureRoomConnectResult> {
    return this.start("setup", options);
  }

  async join(options: SecureRoomStartOptions): Promise<SecureRoomConnectResult> {
    return this.start("join", options);
  }

  sendUiAction(type: string, payload: Record<string, unknown> = {}): boolean {
    if (this.stopped || this.terminal || !this.config || !plainRecord(payload)) return false;
    const generation = this.generation;
    this.enqueue(async () => this.mapUiAction(type, payload), generation);
    return true;
  }

  reconnectIfNeeded(): void {
    if (this.stopped || this.terminal || !this.config || !this.lease?.isActive()) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) this.scheduleReconnect();
  }

  async disconnect(): Promise<void> {
    if (this.unresolvedAuthentication || this.authenticationMayHaveCommitted ||
        this.recoveryContext !== null || !!this.engine?.isAuthenticationAmbiguous) {
      await this.cancelPendingConnection();
      return;
    }
    this.pendingHandshake?.settle({ status: "failed", reason: "aborted" });
    this.pendingHandshake = null;
    this.generation += 1;
    this.stopped = true;
    this.authenticated = false;
    this.authenticationMayHaveCommitted = false;
    this.nextAuthenticationMode = null;
    this.recoverySetup = null;
    this.recoveryContext = null;
    persistRecoveryContext(null);
    this.unresolvedAuthentication = false;
    this.clearReconnectTimer();
    this.closeSocket("disconnected");
    this.engine?.dispose();
    this.engine = null;
    this.discardEngineOnAuthenticationFailure = false;
    this.releaseLease();
    this.config = null;
    this.clearTimers();
    this.resetUiSession();
  }

  /** Explicitly abandons only state first created by the in-flight handshake. */
  async cancelPendingConnection(): Promise<boolean> {
    const config = this.config;
    this.pendingHandshake?.settle({ status: "failed", reason: "aborted" });
    this.pendingHandshake = null;
    this.generation += 1;
    const cancelGeneration = this.generation;
    this.stopped = true;
    const wasAuthenticated = this.authenticated;
    this.authenticated = false;
    this.clearReconnectTimer();
    this.closeSocket("secure room setup cancelled");
    const engine = this.engine;
    // Once an authentication frame is on the wire, a lost response cannot
    // prove that the relay did not commit it. Preserve the recovery identity
    // rather than stranding a room or a redeemed Fort Pass.
    const recoveryRequired = this.unresolvedAuthentication || this.recoveryContext !== null ||
      this.recoverySetup !== null ||
      (!!engine && (engine.isAuthenticationAmbiguous ||
        (engine.isProvisional && (this.authenticationMayHaveCommitted || wasAuthenticated))));
    const discard = !!engine?.isProvisional && !recoveryRequired;
    this.engine = null;
    this.discardEngineOnAuthenticationFailure = false;
    this.authenticationMayHaveCommitted = false;
    this.nextAuthenticationMode = null;
    this.unresolvedAuthentication = recoveryRequired;
    this.config = null;
    this.clearTimers();
    this.resetUiSession();
    // A crypto/create operation already in the serial queue observes the new
    // generation and retires its own freshly-created artifact before return.
    await this.serialQueue.catch(() => {});
    let finalRecoveryRequired = recoveryRequired;
    try {
      if (engine && discard) {
        try {
          await engine.retire();
        } catch (error) {
          if (!(error instanceof SecureRoomEngineError && error.code === "retired")) {
            finalRecoveryRequired = true;
          }
        }
      }
      if (finalRecoveryRequired) this.rememberRecoveryContext(config);
      else this.clearRecoveryForCurrentConfig(config);
      this.unresolvedAuthentication = finalRecoveryRequired;
    } finally {
      engine?.dispose();
      if (this.generation === cancelGeneration) {
        // An operation that had already passed the queue's generation gate may
        // have completed captured-local UI/auth work while cancellation was
        // awaiting it. Scrub once more at the serialization boundary without
        // touching a newer session.
        this.pendingHandshake = null;
        this.authenticated = false;
        this.authenticatedMode = null;
        this.config = null;
        this.disposeCurrentEngine();
        this.discardEngineOnAuthenticationFailure = false;
        this.authenticationMayHaveCommitted = false;
        this.nextAuthenticationMode = null;
        this.unresolvedAuthentication = finalRecoveryRequired;
        this.nextAuthenticationMode = null;
        this.closeSocket("secure room setup cancelled");
        this.clearTimers();
        this.resetUiSession();
        this.releaseLease();
      }
    }
    return !finalRecoveryRequired;
  }

  async replaceLockCoordinatorForTests(coordinator: RoomCryptoLockCoordinator): Promise<void> {
    await this.disconnect();
    this.lockCoordinator.close();
    this.lockCoordinator = coordinator;
  }

  private async start(
    mode: "setup" | "join",
    options: SecureRoomStartOptions,
  ): Promise<SecureRoomConnectResult> {
    const roomId = normalizeRoomId(options.roomId);
    const displayName = options.displayName.normalize("NFC").trim();
    const exactRecovery = this.recoveryContext?.mode === mode &&
      this.recoveryContext.roomId === roomId && this.recoveryContext.displayName === displayName;
    const roomSecret = mode === "setup" && !exactRecovery && !isGeneratedRoomSecret(options.roomSecret)
      ? validateCustomRoomSecret(options.roomSecret, { context: [roomId || "", displayName] })
      : validateRoomSecret(options.roomSecret);
    const hasFortPassSession = options.fortPassSessionId !== undefined;
    const hasFortPassClaim = options.fortPassClaimSecret !== undefined;
    if (!roomId || roomId !== options.roomId || !roomSecret.valid || !isSecureDisplayNameV4(displayName) ||
        (mode !== "setup" && (hasFortPassSession || hasFortPassClaim)) ||
        hasFortPassSession !== hasFortPassClaim ||
        (hasFortPassSession && (!/^[a-zA-Z0-9_:-]{1,128}$/u.test(options.fortPassSessionId!) ||
          !/^[a-f0-9]{64}$/u.test(options.fortPassClaimSecret!)))) {
      return { status: "failed", reason: "invalid-input" };
    }
    if (this.recoveryContext &&
        (this.recoveryContext.mode !== mode || this.recoveryContext.roomId !== roomId ||
          this.recoveryContext.displayName !== displayName)) {
      return { status: "failed", reason: "recovery-required" };
    }
    const priorConnectionResolved = await this.cancelPendingConnection();
    if (!priorConnectionResolved && !exactRecovery) {
      return { status: "failed", reason: "recovery-required" };
    }
    const generation = ++this.generation;
    const setupRoomInstance = mode === "setup"
      ? this.recoverySetup?.roomId === roomId
        ? this.recoverySetup.roomInstance
        : randomSecureRoomIdV4(16)
      : null;
    const config: SessionConfig = {
      initialMode: mode,
      recoveryOnly: exactRecovery,
      roomId,
      roomSecret: roomSecret.secret,
      roomSecretResolvedFor: null,
      displayName,
      ...(options.fortPassSessionId && { fortPassSessionId: options.fortPassSessionId }),
      ...(options.fortPassClaimSecret && { fortPassClaimSecret: options.fortPassClaimSecret }),
      roomInstance: setupRoomInstance ?? (exactRecovery ? this.recoveryContext!.roomInstance : null),
      setupRoomInstance,
    };

    return new Promise<SecureRoomConnectResult>((resolve) => {
      let settled = false;
      const handshake: PendingHandshake = {
        generation,
        settle: (result) => {
          if (settled) return;
          settled = true;
          if (this.pendingHandshake === handshake) this.pendingHandshake = null;
          resolve(result);
        },
      };
      this.pendingHandshake = handshake;
      // A prior connection may still be finishing asynchronous crypto or
      // durable storage work. Do not expose the replacement configuration or
      // socket until that old serial operation has drained.
      this.enqueue(async () => {
        if (generation !== this.generation) {
          handshake.settle({ status: "failed", reason: "aborted" });
          return;
        }
        // The obsolete operation may have completed local bookkeeping after
        // disconnect() first cleared it. Scrub that late state once more at
        // the serialization boundary before the replacement room is exposed.
        this.closeSocket("replaced secure room session");
        this.engine?.dispose();
        this.engine = null;
        this.discardEngineOnAuthenticationFailure = false;
        this.authenticationMayHaveCommitted = false;
        this.nextAuthenticationMode = null;
        this.releaseLease();
        this.clearTimers();
        this.resetUiSession();
        this.stopped = false;
        this.terminal = false;
        this.config = config;
        useGameStore.getState().setIntentionalLeave(false);
        this.openSocket(generation, handshake, options.lock ?? {});
      }, generation, () => handshake.settle({ status: "failed", reason: "aborted" }));
    });
  }

  private openSocket(
    generation: number,
    handshake?: PendingHandshake,
    lockOptions: AcquireRoomCryptoLockOptions = {},
  ): void {
    const config = this.config;
    if (!config || generation !== this.generation || this.stopped) {
      handshake?.settle({ status: "failed", reason: "aborted" });
      return;
    }
    this.challengeHandled = false;
    this.authenticated = false;
    this.authenticatedMode = null;
    this.sentDurableControls.clear();
    this.transientControlIds.clear();
    let socket: WebSocket;
    try {
      socket = new WebSocket(secureRoomWebSocketUrl(config.roomId));
    } catch {
      handshake?.settle({ status: "failed", reason: "socket-failed" });
      return;
    }
    const socketEpoch = ++this.socketEpoch;
    this.socket = socket;
    socket.onmessage = (event) => {
      if (!this.isCurrentSocket(socket, generation, socketEpoch)) return;
      if (typeof event.data !== "string" || UTF8.encode(event.data).byteLength > MAX_SECURE_WEBSOCKET_FRAME_BYTES) {
        try { socket.close(1009, "frame too large"); } catch {}
        return;
      }
      const wire = event.data;
      this.enqueue(async () => this.handleWire(
        socket,
        generation,
        socketEpoch,
        wire,
        handshake,
        lockOptions,
      ), generation);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      // A browser can dispatch `close` immediately after `message`. The
      // message handler above deliberately serializes cryptographic work, so
      // invalidating the socket here would make that already-received final
      // frame look stale when it reaches the queue (notably room retirement
      // and self-removal commits). Reconcile the close in the same queue so
      // every earlier message event is authenticated and applied first.
      this.enqueue(async () => {
        if (!this.isCurrentSocket(socket, generation, socketEpoch)) return;
        const connectionWasAuthenticated = this.authenticated;
        this.socket = null;
        this.socketEpoch += 1;
        this.authenticated = false;
        const canReconnect = !this.stopped && !this.terminal && this.lease?.isActive() && this.config;
        if (!connectionWasAuthenticated && canReconnect && this.reconnectAttempts >= 3) {
          if (handshake || this.pendingHandshake) {
            const preserveRecovery = this.authenticationMayHaveCommitted ||
              !!this.engine?.isAuthenticationAmbiguous;
            await this.stopPendingConnection(
              handshake,
              { status: "failed", reason: preserveRecovery ? "recovery-required" : "socket-failed" },
              preserveRecovery,
            );
          } else {
            await this.protocolClose("authentication reconnect limit reached", "The secure connection could not recover. Try again.");
          }
          return;
        }
        if (canReconnect) {
          this.scheduleReconnect();
        } else {
          handshake?.settle({ status: "failed", reason: "socket-failed" });
        }
      }, generation);
    };
  }

  private enqueue(
    operation: () => void | Promise<void>,
    generation = this.executingGeneration ?? this.generation,
    onStale?: () => void,
  ): void {
    this.serialQueue = this.serialQueue.then(async () => {
      if (generation !== this.generation) {
        onStale?.();
        return;
      }
      const previousGeneration = this.executingGeneration;
      this.executingGeneration = generation;
      try {
        await operation();
      } catch (error) {
        // A late failure from an obsolete room/session must never fail-close a
        // replacement room that now owns this controller.
        if (generation === this.generation) await this.failClosed(error);
      } finally {
        this.executingGeneration = previousGeneration;
      }
    });
  }

  private async handleWire(
    socket: WebSocket,
    generation: number,
    socketEpoch: number,
    wire: string,
    handshake: PendingHandshake | undefined,
    lockOptions: AcquireRoomCryptoLockOptions,
  ): Promise<void> {
    if (!this.isCurrentSocket(socket, generation, socketEpoch)) return;
    let value: unknown;
    try {
      value = JSON.parse(wire);
    } catch {
      await this.protocolClose("invalid JSON");
      return;
    }
    if (!this.authenticated) {
      const challenge = parseSecureAuthChallengeFrameV4(value);
      if (challenge) {
        if (this.challengeHandled) {
          await this.protocolClose("duplicate authentication challenge");
          return;
        }
        this.challengeHandled = true;
        await this.handleChallenge(
          challenge,
          handshake,
          lockOptions,
          () => this.isCurrentSocket(socket, generation, socketEpoch),
        );
        return;
      }
      const response = parseSecureServerFrameV4(value);
      if (response?.type === "error") {
        await this.handleServerError(response, handshake);
        return;
      }
      if (!this.challengeHandled || this.authenticatedMode === null || response?.type !== "authenticated") {
        await this.protocolClose("invalid authentication frame");
        return;
      }
      await this.handleServerFrame(response, handshake);
      return;
    }
    const frame = parseSecureServerFrameV4(value);
    if (!frame) {
      await this.protocolClose("invalid secure server frame");
      return;
    }
    if (frame.type === "authenticated") {
      await this.protocolClose("duplicate authentication response");
      return;
    }
    await this.handleServerFrame(frame, handshake);
  }

  private async handleChallenge(
    challenge: SecureAuthChallengeFrameV4,
    handshake: PendingHandshake | undefined,
    lockOptions: AcquireRoomCryptoLockOptions,
    isCurrentConnection: () => boolean = () => true,
  ): Promise<void> {
    const config = this.config;
    if (!config) throw new Error("secure room configuration disappeared");
    const isBrandNewSetup = challenge.roomInstance === null;
    const knownRoomInstance = canonicalBase64UrlByteLength(config.roomInstance) === SECURE_ROOM_ID_BYTES
      ? config.roomInstance
      : null;
    const recoveryMayHaveCommitted = config.recoveryOnly || this.recoveryContext !== null ||
      this.unresolvedAuthentication || this.authenticationMayHaveCommitted ||
      !!this.engine?.isAuthenticationAmbiguous;
    const recoveryInstanceUnavailable = knownRoomInstance !== null && recoveryMayHaveCommitted &&
      ((config.initialMode === "join" && challenge.roomInstance === null) ||
        (challenge.roomInstance !== null && challenge.roomInstance !== knownRoomInstance));
    if (recoveryInstanceUnavailable) {
      await this.resolveUnavailableRecoveryRoom(
        knownRoomInstance,
        handshake,
        lockOptions,
        isCurrentConnection,
      );
      return;
    }
    const roomInstance = isBrandNewSetup ? config.setupRoomInstance : challenge.roomInstance;
    if (!roomInstance ||
        (isBrandNewSetup && config.initialMode !== "setup") ||
        (this.engine !== null && this.engine.roomInstance !== roomInstance)) {
      await this.protocolClose("room instance mismatch");
      handshake?.settle({ status: "failed", reason: "authentication-failed" });
      return;
    }
    config.roomInstance = roomInstance;

    if (config.roomSecretResolvedFor == null) {
      try {
        const resolved = await deriveProtocolRoomSecret(config.roomId, roomInstance, config.roomSecret);
        if (!isCurrentConnection()) return;
        config.roomSecret = resolved;
        config.roomSecretResolvedFor = roomInstance;
      } catch {
        await this.protocolClose("room secret derivation failed");
        handshake?.settle({ status: "failed", reason: "authentication-failed" });
        return;
      }
    } else if (config.roomSecretResolvedFor !== roomInstance) {
      await this.protocolClose("room secret instance mismatch");
      handshake?.settle({ status: "failed", reason: "authentication-failed" });
      return;
    }

    if (!this.lease?.isActive()) {
      const storeKey = await secureRoomOpaqueStoreKey(roomInstance);
      if (!isCurrentConnection()) return;
      const acquired = await this.lockCoordinator.acquire(storeKey, lockOptions);
      if (!isCurrentConnection()) {
        if (acquired.status === "acquired") acquired.lease.release();
        return;
      }
      if (acquired.status !== "acquired") {
        handshake?.settle(acquired);
        this.stopped = true;
        this.closeSocket("secure room lock unavailable");
        return;
      }
      this.lease = acquired.lease;
      this.installLeaseAbort(acquired.lease);
    }

    let authMode: "setup" | "join" | "resume";
    if (this.engine) {
      if (this.engine.roomInstance !== roomInstance) throw new Error("active engine room mismatch");
      if (isBrandNewSetup) {
        const retainedSetup = this.retainedJoinAuthEntry();
        if (!retainedSetup || !this.engine.isActive() ||
            this.engine.state.hostDeviceId !== this.engine.deviceId) {
          await this.protocolClose("invalid founder setup retry");
          handshake?.settle({ status: "failed", reason: "authentication-failed" });
          return;
        }
        authMode = "setup";
      } else {
        authMode = this.engine.isActive() && this.engine.state.members.some((member) =>
          member.deviceId === this.engine!.deviceId)
          ? "resume"
          : "join";
      }
    } else if (isBrandNewSetup) {
      if (config.recoveryOnly) {
        let restored: SecureRoomEngine;
        try {
          restored = await SecureRoomEngine.restore({
            roomInstance,
            roomSecret: config.roomSecret,
            lease: this.lease!,
          });
        } catch (error) {
          if (!isCurrentConnection()) return;
          const reason = error instanceof SecureRoomEngineError && error.code === "state-not-found"
            ? "recovery-credential-mismatch" as const
            : "recovery-required" as const;
          await this.stopPendingConnection(
            handshake,
            { status: "failed", reason },
            true,
          );
          return;
        }
        if (!isCurrentConnection()) {
          restored.dispose();
          return;
        }
        // A crash can occur after the relay accepted setup and the durable
        // lifecycle became established, but before the non-secret pointer was
        // cleared. A later null-instance challenge authoritatively means that
        // accepted room has since expired/retired; it must be retired locally,
        // not replayed as setup or preserved in an unresolvable recovery loop.
        if (!restored.isProvisional && !restored.isAuthenticationAmbiguous) {
          this.engine = restored;
          await this.resolveUnavailableRecoveryRoom(
            roomInstance,
            handshake,
            lockOptions,
            isCurrentConnection,
          );
          return;
        }
        const retainedSetup = restored.pendingOutbox.find((entry) =>
          entry.kind === "admission" && entry.welcomeMessageId === null) ?? null;
        if (restored.isProvisional || !restored.isAuthenticationAmbiguous ||
            !restored.isActive() || restored.state.hostDeviceId !== restored.deviceId ||
            retainedSetup?.kind !== "admission") {
          restored.dispose();
          await this.stopPendingConnection(
            handshake,
            { status: "failed", reason: "recovery-required" },
            true,
          );
          return;
        }
        this.engine = restored;
        this.discardEngineOnAuthenticationFailure = false;
        authMode = "setup";
      } else {
        const created = await SecureRoomEngine.createFounder({
          roomInstance,
          roomSecret: config.roomSecret,
          displayName: config.displayName,
          lease: this.lease!,
        });
        if (!isCurrentConnection()) {
          try { await created.retire(); } catch {}
          created.dispose();
          return;
        }
        this.engine = created;
        this.discardEngineOnAuthenticationFailure = true;
        authMode = "setup";
      }
    } else {
      try {
        const restored = await SecureRoomEngine.restore({
          roomInstance,
          roomSecret: config.roomSecret,
          lease: this.lease!,
        });
        if (!isCurrentConnection()) {
          restored.dispose();
          return;
        }
        this.engine = restored;
        const retainedJoin = this.retainedJoinAuthEntry();
        const restoredActiveMember = restored.isActive() && restored.state.members.some((member) =>
          member.deviceId === restored.deviceId);
        const validSetupRecovery = config.initialMode !== "setup" ||
          (restored.isActive() && restored.state.hostDeviceId === restored.deviceId);
        const validRecoveryState = !config.recoveryOnly ||
          (!restored.isProvisional && validSetupRecovery &&
            (restoredActiveMember || retainedJoin !== null));
        if (!validRecoveryState) {
          this.engine = null;
          restored.dispose();
          await this.stopPendingConnection(
            handshake,
            { status: "failed", reason: "recovery-required" },
            true,
          );
          return;
        }
        // A durable provisional marker proves no authentication frame was
        // ever sent (the marker is advanced atomically before transmission),
        // so a definitive rejection may clean it. Ambiguous and established
        // restores are never treated as artifacts of this attempt.
        this.discardEngineOnAuthenticationFailure = restored.isProvisional;
        // A device may crash after the relay activates setup/admission but
        // before the authenticated/result response arrives. Durable active
        // membership resumes even while the original admission outbox remains.
        authMode = restoredActiveMember ? "resume" : retainedJoin ? "join" : "resume";
      } catch (error) {
        if (config.recoveryOnly) {
          const reason = error instanceof SecureRoomEngineError && error.code === "state-not-found"
            ? "recovery-credential-mismatch" as const
            : "recovery-required" as const;
          await this.stopPendingConnection(
            handshake,
            { status: "failed", reason },
            true,
          );
          return;
        }
        if (!(error instanceof SecureRoomEngineError) || error.code !== "state-not-found") throw error;
        if (config.initialMode === "setup") {
          await this.protocolClose("founder state is unavailable for resume");
          handshake?.settle({ status: "failed", reason: "authentication-failed" });
          return;
        }
        const created = await SecureRoomEngine.createJoiner({
          roomInstance,
          roomSecret: config.roomSecret,
          lease: this.lease!,
        });
        if (!isCurrentConnection()) {
          try { await created.retire(); } catch {}
          created.dispose();
          return;
        }
        this.engine = created;
        this.discardEngineOnAuthenticationFailure = true;
        authMode = "join";
      }
    }

    if (this.nextAuthenticationMode !== null) {
      const forcedMode = this.nextAuthenticationMode;
      const retainedJoin = this.retainedJoinAuthEntry();
      if (forcedMode === "join" && config.initialMode === "join" && retainedJoin) {
        authMode = "join";
      } else if (forcedMode === "resume" && this.engine?.isActive()) {
        authMode = "resume";
      } else {
        await this.protocolClose("invalid authentication recovery mode");
        handshake?.settle({ status: "failed", reason: "authentication-failed" });
        return;
      }
      this.nextAuthenticationMode = null;
    }

    const authenticate = await this.createAuthenticateFrame(challenge, authMode);
    // Crypto and durable storage can outlive a socket. Never route an
    // authentication frame created for socket A through a replacement socket B.
    if (!isCurrentConnection()) return;
    await this.requireEngine().markAuthenticationAttempted();
    if (!isCurrentConnection()) return;
    this.authenticatedMode = authMode;
    this.authenticationMayHaveCommitted = true;
    this.unresolvedAuthentication = true;
    this.rememberRecoveryContext();
    this.sendAuthentication(authenticate);
  }

  /**
   * The relay has authoritatively shown that the pinned room instance no
   * longer exists at this flag. Retire only the exact credential-scoped local
   * identity; a wrong password cannot locate it and therefore keeps recovery
   * editable instead of clearing someone else's state.
   */
  private async resolveUnavailableRecoveryRoom(
    roomInstance: string,
    handshake: PendingHandshake | undefined,
    lockOptions: AcquireRoomCryptoLockOptions = {},
    isCurrentConnection: () => boolean = () => true,
  ): Promise<void> {
    const config = this.config;
    if (!config || canonicalBase64UrlByteLength(roomInstance) !== SECURE_ROOM_ID_BYTES) {
      await this.protocolClose("missing pinned recovery instance");
      return;
    }
    if (config.roomSecretResolvedFor == null) {
      try {
        config.roomSecret = await deriveProtocolRoomSecret(config.roomId, roomInstance, config.roomSecret);
        if (!isCurrentConnection()) return;
        config.roomSecretResolvedFor = roomInstance;
      } catch {
        if (!isCurrentConnection()) return;
        await this.stopPendingConnection(
          handshake,
          { status: "failed", reason: "recovery-required" },
          true,
        );
        return;
      }
    } else if (config.roomSecretResolvedFor !== roomInstance) {
      await this.stopPendingConnection(
        handshake,
        { status: "failed", reason: "recovery-required" },
        true,
      );
      return;
    }

    if (!this.lease?.isActive()) {
      const storeKey = await secureRoomOpaqueStoreKey(roomInstance);
      if (!isCurrentConnection()) return;
      const acquired = await this.lockCoordinator.acquire(storeKey, lockOptions);
      if (!isCurrentConnection()) {
        if (acquired.status === "acquired") acquired.lease.release();
        return;
      }
      if (acquired.status !== "acquired") {
        await this.stopPendingConnection(
          handshake,
          { status: "failed", reason: "recovery-required" },
          true,
        );
        return;
      }
      this.lease = acquired.lease;
      this.installLeaseAbort(acquired.lease);
    }

    if (!this.engine) {
      try {
        this.engine = await SecureRoomEngine.restore({
          roomInstance,
          roomSecret: config.roomSecret,
          lease: this.lease!,
        });
      } catch (error) {
        if (!isCurrentConnection()) return;
        const reason = error instanceof SecureRoomEngineError && error.code === "state-not-found"
          ? "recovery-credential-mismatch" as const
          : "recovery-required" as const;
        await this.stopPendingConnection(handshake, { status: "failed", reason }, true);
        return;
      }
    }
    if (!isCurrentConnection()) return;
    if (this.engine.roomInstance !== roomInstance || this.engine.isProvisional) {
      await this.stopPendingConnection(
        handshake,
        { status: "failed", reason: "recovery-required" },
        true,
      );
      return;
    }
    try {
      await this.engine.retire();
    } catch (error) {
      if (!(error instanceof SecureRoomEngineError && error.code === "retired")) {
        await this.stopPendingConnection(
          handshake,
          { status: "failed", reason: "recovery-required" },
          true,
        );
        return;
      }
    }
    this.authenticationMayHaveCommitted = false;
    this.unresolvedAuthentication = false;
    this.discardEngineOnAuthenticationFailure = false;
    await this.stopPendingConnection(
      handshake,
      { status: "failed", reason: "authentication-failed" },
      false,
    );
    useGameStore.getState().showError("That secure fort instance no longer exists. You can join or create another fort.");
  }

  private isCurrentSocket(socket: WebSocket, generation: number, socketEpoch: number): boolean {
    return socket === this.socket && generation === this.generation && socketEpoch === this.socketEpoch;
  }

  private async createAuthenticateFrame(
    challenge: SecureAuthChallengeFrameV4,
    mode: "setup" | "join" | "resume",
  ): Promise<SecureAuthenticateFrameV4> {
    const engine = this.requireEngine();
    const config = this.config!;
    if (mode === "resume") {
      const requestId = randomSecureRoomIdV4(16);
      const frame = {
        kind: "resume" as const,
        v: 4 as const,
        suite: 1 as const,
        roomInstance: engine.roomInstance,
        requestId,
        deviceId: engine.deviceId,
      };
      const resumeProof = await engine.signDeviceResumeProof({
        roomId: config.roomId,
        roomInstance: engine.roomInstance,
        deviceId: engine.deviceId,
        connectionId: challenge.connectionId,
        requestId,
        challenge: challenge.challenge,
      });
      return { kind: "secure-authenticate", v: 4, suite: 1, mode, frame, resumeProof };
    }

    let keyPackageEntry = this.retainedJoinAuthEntry();
    if (!keyPackageEntry) {
      const created = await engine.createKeyPackage();
      keyPackageEntry = engine.pendingOutbox.find(
        (entry): entry is Extract<SecureRoomPendingOutboxEntryV1, { kind: "admission" }> =>
          entry.kind === "admission" && entry.messageId === created.messageId && entry.welcomeMessageId === null,
      ) ?? null;
    }
    if (!keyPackageEntry || keyPackageEntry.kind !== "admission") {
      throw new Error("durable KeyPackage outbox entry is unavailable");
    }
    const hello: SecureMemberHelloV4 = {
      v: 4,
      suite: 1,
      roomInstance: engine.roomInstance,
      deviceId: engine.deviceId,
      keyPackage: toBase64Url(keyPackageEntry.outbound),
    };
    const memberBinding = await createRoomInvitationMemberBindingV4({
      mode: mode === "setup" ? "founder" : "admission",
      roomId: config.roomId,
      roomInstance: engine.roomInstance,
      deviceId: engine.deviceId,
      admissionId: keyPackageEntry.messageId,
      signaturePublicKey: engine.signaturePublicKey,
      keyPackageDigest: await secureKeyPackageDigestV4(keyPackageEntry.outbound),
    }, config.roomSecret);
    this.localMemberBinding = memberBinding;
    const auth = await createRoomInvitationAuthV4({
      mode,
      roomId: config.roomId,
      roomInstance: engine.roomInstance,
      deviceId: engine.deviceId,
      connectionId: challenge.connectionId,
      requestId: keyPackageEntry.messageId,
      challenge: challenge.challenge,
    }, config.roomSecret);
    return mode === "setup"
      ? {
          kind: "secure-authenticate", v: 4, suite: 1, mode,
          frame: {
            kind: "setup", requestId: keyPackageEntry.messageId,
            signaturePublicKey: engine.signaturePublicKey, hello, memberBinding,
          }, auth,
          ...(config.fortPassSessionId && config.fortPassClaimSecret && {
            fortPassSessionId: config.fortPassSessionId,
            fortPassClaimSecret: config.fortPassClaimSecret,
          }),
        }
      : {
          kind: "secure-authenticate", v: 4, suite: 1, mode,
          frame: {
            kind: "join", requestId: keyPackageEntry.messageId,
            signaturePublicKey: engine.signaturePublicKey, hello, memberBinding,
          }, auth,
        };
  }

  private sendAuthentication(frame: SecureAuthenticateFrameV4): void {
    if (!parseSecureAuthenticateFrameV4(frame)) throw new Error("constructed authentication frame is invalid");
    this.sendWire(frame);
  }

  private retainedJoinAuthEntry(): Extract<SecureRoomPendingOutboxEntryV1, { kind: "admission" }> | null {
    const entry = this.engine?.pendingOutbox.find((candidate) =>
      candidate.kind === "admission" && candidate.welcomeMessageId === null);
    return entry?.kind === "admission" ? entry : null;
  }

  private async handleServerFrame(
    frame: SecureServerFrameV4,
    handshake?: PendingHandshake,
  ): Promise<void> {
    switch (frame.type) {
      case "authenticated":
        await this.handleAuthenticated(frame, handshake);
        return;
      case "deliver-key-package":
        await this.handleKeyPackage(frame);
        return;
      case "relay":
        await this.handleRelay(frame);
        return;
      case "application-preview":
        await this.handleApplicationPreview(frame);
        return;
      case "commit-preview":
        await this.handleCommitPreview(frame);
        return;
      case "admission-proof-preview":
        await this.handleAdmissionProofPreview(frame);
        return;
      case "order-granted":
        await this.handleGrant(frame.grant);
        return;
      case "order-expired":
        await this.handleOrderExpired(frame.tokenId);
        return;
      case "order-cancelled":
        await this.handleOrderCancelled(frame.requestId, frame.reason);
        return;
      case "frame-accepted":
        await this.handleFrameAccepted(frame.messageId);
        return;
      case "application-result":
        await this.handleApplicationResult(frame);
        return;
      case "commit-rejected":
        await this.handleCommitRejected(frame.messageId, frame.reason);
        return;
      case "host-transfer-authorized":
        await this.handleHostTransferAuthorized(frame);
        return;
      case "host-transfer-expired":
        await this.handleHostTransferExpired(frame.authorizationId);
        return;
      case "backlog-end":
        await this.handleBacklogEnd(frame.lastMessageId);
        return;
      case "room-state-snapshot":
        await this.handleRoomStateSnapshot(frame);
        return;
      case "fresh-admission-required":
        if (frame.deviceId === this.requireEngine().deviceId) await this.finishTerminal("A fresh secure admission is required.");
        return;
      case "zombie-removal-required":
        this.handleZombieRemovalRequired(frame.deviceId, frame.admissionCommitMessageId);
        return;
      case "member-lifecycle":
        await this.handleMemberLifecycle(frame.deviceId, frame.status);
        return;
      case "host-changed":
        await this.handleHostChanged(frame.deviceId);
        return;
      case "room-retired":
        await this.handleRoomRetired();
        return;
      case "error":
        await this.handleServerError(frame, handshake);
        return;
    }
  }

  private async handleAuthenticated(
    frame: Extract<SecureServerFrameV4, { type: "authenticated" }>,
    handshake?: PendingHandshake,
  ): Promise<void> {
    const engine = this.requireEngine();
    const statusMatchesMode = frame.mode === "setup"
      ? frame.status === "active"
      : frame.mode === "join"
        ? frame.status === "pending"
        : frame.status === "pending";
    if (frame.mode !== this.authenticatedMode || frame.roomInstance !== engine.roomInstance ||
        frame.deviceId !== engine.deviceId || !statusMatchesMode) {
      await this.protocolClose("authentication result mismatch");
      handshake?.settle({ status: "failed", reason: "authentication-failed" });
      return;
    }
    if (frame.mode === "join") {
      const founderBinding = parseRoomInvitationMemberBindingV4(frame.founderBinding);
      const config = this.config;
      const localBinding = this.localMemberBinding;
      if (!config || !founderBinding || founderBinding.mode !== "founder" ||
          founderBinding.roomId !== config.roomId || founderBinding.roomInstance !== engine.roomInstance ||
          !localBinding || localBinding.mode !== "admission" ||
          !await verifyRoomInvitationMemberBindingWithSecretV4({
            binding: founderBinding,
            expected: founderBinding,
            roomSecret: config.roomSecret,
          })) {
        await this.protocolClose("invalid founder member binding");
        handshake?.settle({ status: "failed", reason: "authentication-failed" });
        return;
      }
      await engine.authorizeJoinFounder(config.roomId, founderBinding);
      this.founderBinding = founderBinding;
      this.publishPendingJoinFingerprint(localBinding);
    } else {
      this.founderBinding = null;
      this.publishPendingJoinFingerprint(null);
    }
    const config = this.config;
    if (!config) throw new Error("secure room configuration disappeared after authentication");
    // Setup and resume prove an active/resumable relay identity. A fresh join
    // remains bounded until the relay's authoritative own-member activation;
    // local MLS may become active earlier when it consumes Welcome.
    if (frame.mode !== "join") await engine.markAuthenticated();
    const safetyCode = await secureRoomInvitationSafetyCodeV4(
      config.roomId,
      engine.roomInstance,
      config.roomSecret,
    );
    this.discardEngineOnAuthenticationFailure = false;
    this.authenticationMayHaveCommitted = false;
    this.nextAuthenticationMode = null;
    this.unresolvedAuthentication = frame.mode === "join";
    this.authenticated = true;
    useGameStore.getState().setRoomSafetyCode(safetyCode);
    // The paid-setup bearer is single-purpose. Drop the controller's only
    // reference immediately after the server accepts setup authentication.
    if (config.initialMode === "setup") {
      delete config.fortPassClaimSecret;
      this.clearRecoveryForCurrentConfig();
    } else if (frame.mode === "resume") {
      this.clearRecoveryForCurrentConfig();
    }
    this.reconnectAttempts = 0;
    useGameStore.getState().setReconnecting(false);
    useGameStore.getState().setReconnectAttempts(0);
    if (frame.mode === "setup" || frame.mode === "join") {
      const keyPackage = this.retainedJoinAuthEntry();
      if (!keyPackage) throw new Error("authenticated KeyPackage context disappeared");
      await engine.acknowledgeOutbound(keyPackage.messageId);
      if (frame.mode === "setup") await engine.completeJoinAdmission(keyPackage.admissionId);
    } else {
      const retainedAuthentication = this.retainedJoinAuthEntry();
      const ownAdmission = engine.state.membershipAdmissionBindings.find((binding) =>
        binding.deviceId === engine.deviceId)?.admissionId ?? null;
      if (retainedAuthentication && engine.isActive() &&
          engine.state.members.some((member) => member.deviceId === engine.deviceId) &&
          ownAdmission === retainedAuthentication.admissionId) {
        // Setup/admission may have activated server-side just before its result
        // was lost. A credential-signed resume plus the invitation-signed
        // admission ledger proves this exact device exists at the relay, so
        // retire the retained authentication outbox without creating a second
        // identity.
        await engine.acknowledgeOutbound(retainedAuthentication.messageId);
        await engine.completeJoinAdmission(retainedAuthentication.admissionId);
      }
    }
    this.roomStateSnapshotReceived = false;
    if (frame.mode === "resume" && frame.status === "pending") this.replayingBacklog = true;

    if (frame.mode === "setup" || frame.mode === "resume") {
      this.initializeUi(frame.mode === "resume");
    }
    handshake?.settle({ status: "connected", roomInstance: engine.roomInstance });
    if (!this.replayingBacklog) {
      await this.retryDurableWork();
      this.maybeSchedulePostCompromiseUpdate(frame.mode === "resume");
    }
    await this.runAutomations();
  }

  private async handleKeyPackage(
    frame: Extract<SecureServerFrameV4, { type: "deliver-key-package" }>,
  ): Promise<void> {
    const engine = this.requireEngine();
    if (!this.isHost()) {
      await this.protocolClose("non-host received KeyPackage");
      return;
    }
    const keyPackage = fromBase64Url(frame.hello.keyPackage);
    const memberBinding = parseRoomInvitationMemberBindingV4(frame.memberBinding);
    const config = this.config;
    if (!keyPackage || !memberBinding || !config || frame.hello.deviceId !== frame.fromDeviceId ||
        frame.hello.roomInstance !== engine.roomInstance || frame.admissionId === engine.deviceId) {
      await this.protocolClose("invalid KeyPackage delivery");
      return;
    }
    const keyPackageEncoding = toBase64Url(keyPackage);
    const expectedBinding = {
      mode: "admission" as const,
      roomId: config.roomId,
      roomInstance: engine.roomInstance,
      deviceId: frame.fromDeviceId,
      admissionId: frame.admissionId,
      signaturePublicKey: memberBinding.signaturePublicKey,
      keyPackageDigest: await secureKeyPackageDigestV4(keyPackage),
    };
    if (memberBinding.mode !== "admission" || memberBinding.keyPackageDigest !== expectedBinding.keyPackageDigest ||
        !await verifyRoomInvitationMemberBindingWithSecretV4({
          binding: memberBinding,
          expected: expectedBinding,
          roomSecret: config.roomSecret,
        })) {
      keyPackage.fill(0);
      await this.protocolClose("KeyPackage is not invitation-authorized");
      return;
    }
    const existing = this.pendingHostAdmissions.get(frame.admissionId);
    if (existing) {
      if (existing.fromDeviceId !== frame.fromDeviceId || existing.keyPackageEncoding !== keyPackageEncoding ||
          existing.memberBinding.proof !== memberBinding.proof) {
        keyPackage.fill(0);
        await this.protocolClose("admission id rebound to different KeyPackage material");
      } else {
        keyPackage.fill(0);
      }
      return;
    }
    if (this.hasMembershipBarrier() || activeGame(engine.state) || engine.state.pendingHostDeviceId !== null ||
        engine.state.pendingRemovalDeviceIds.length !== 0 ||
        engine.state.members.some((member) => member.deviceId === frame.fromDeviceId) ||
        this.pendingHostAdmissions.size >= MAX_PENDING_HOST_ADMISSIONS) {
      keyPackage.fill(0);
      this.sendAdmissionCancellation(frame.admissionId, frame.fromDeviceId);
      return;
    }
    const pending: PendingHostAdmission = {
      admissionId: frame.admissionId,
      fromDeviceId: frame.fromDeviceId,
      deviceFingerprint: secureAdmissionBindingFingerprintV4(memberBinding),
      keyPackage,
      keyPackageEncoding,
      memberBinding,
      status: "pending",
      expiresAt: Date.now() + HOST_ADMISSION_APPROVAL_WINDOW_MS,
      inFlight: false,
      timeout: null,
    };
    this.pendingHostAdmissions.set(frame.admissionId, pending);
    this.armPendingHostAdmissionTimeout(pending);
    this.syncPendingHostAdmissions();
  }

  private approvePendingHostAdmission(admissionId: string): void {
    const engine = this.requireEngine();
    const pending = this.pendingHostAdmissions.get(admissionId);
    if (!pending || pending.status !== "pending" || !this.isHost()) return;
    if (this.hasMembershipBarrier() || activeGame(engine.state) || engine.state.pendingHostDeviceId !== null ||
        engine.state.pendingRemovalDeviceIds.length !== 0 || this.pendingGrant ||
        this.grantQueue.length !== 0 || this.hasBlockingOutbox()) {
      useGameStore.getState().showError("Finish the current secure action before approving this device.");
      return;
    }
    if (Date.now() >= pending.expiresAt) {
      this.removePendingHostAdmission(admissionId);
      this.sendAdmissionCancellation(admissionId, pending.fromDeviceId);
      return;
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.status = "approving";
    pending.timeout = null;
    this.armPendingHostAdmissionTimeout(pending);
    this.syncPendingHostAdmissions();
    this.enqueueGrantIntent({
      key: `admit:${admissionId}`,
      run: async (grant) => {
        const exact = this.pendingHostAdmissions.get(admissionId);
        if (exact !== pending || exact.status !== "approving" || !this.isHost()) return null;
        if (Date.now() >= exact.expiresAt) {
          this.removePendingHostAdmission(admissionId);
          this.sendAdmissionCancellation(admissionId, exact.fromDeviceId);
          return null;
        }
        if (exact.timeout) clearTimeout(exact.timeout);
        exact.timeout = null;
        exact.inFlight = true;
        try {
          const config = this.config;
          if (!config) throw new Error("secure room configuration disappeared during admission");
          const result = await engine.addMember(
            exact.keyPackage,
            admissionId,
            grant,
            config.roomId,
            exact.memberBinding,
          );
          // addMember() durably establishes the admission barrier. Preserve
          // only the exact approval object across barrier activation so its
          // post-await integrity check remains meaningful; every unrelated
          // pending admission is still cancelled and erased.
          this.activateMembershipBarrier(exact);
          const stillExact = this.pendingHostAdmissions.get(admissionId);
          if (stillExact !== exact || !stillExact.inFlight || stillExact.status !== "approving") {
            await engine.rejectOutbound(result.messageId);
            await this.finishTerminal("Secure admission approval changed during commit. Recreate the fort.", false);
            return null;
          }
          this.removePendingHostAdmission(admissionId);
          this.rememberOutboundUi(result.messageId, { state: engine.state, effects: [] });
          this.sendPendingEntry(result.messageId);
          return result.messageId;
        } catch (error) {
          const current = this.pendingHostAdmissions.get(admissionId);
          if (current === pending) {
            current.inFlight = false;
            if (Date.now() >= current.expiresAt) {
              this.removePendingHostAdmission(admissionId);
              this.sendAdmissionCancellation(admissionId, current.fromDeviceId);
            } else {
              current.status = "pending";
              this.armPendingHostAdmissionTimeout(current);
              this.syncPendingHostAdmissions();
            }
          }
          throw error;
        }
      },
    }, true);
  }

  private rejectPendingHostAdmission(admissionId: string): void {
    const pending = this.pendingHostAdmissions.get(admissionId);
    if (!pending || pending.status !== "pending" || !this.isHost()) return;
    this.removePendingHostAdmission(admissionId);
    this.sendAdmissionCancellation(admissionId, pending.fromDeviceId);
  }

  private sendAdmissionCancellation(admissionId: string, deviceId: string): void {
    if (!this.authenticated || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const requestId = randomSecureRoomIdV4(16);
    this.trackTransientControlId(requestId);
    this.sendClientFrame({
      kind: "cancel-admission", v: 4, suite: 1,
      roomInstance: this.requireEngine().roomInstance,
      requestId,
      deviceId,
      admissionId,
    });
  }

  private removePendingHostAdmission(admissionId: string): void {
    const pending = this.pendingHostAdmissions.get(admissionId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.keyPackage.fill(0);
    this.pendingHostAdmissions.delete(admissionId);
    this.syncPendingHostAdmissions();
  }

  private clearPendingHostAdmissions(): void {
    for (const pending of this.pendingHostAdmissions.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.keyPackage.fill(0);
    }
    this.pendingHostAdmissions.clear();
    this.syncPendingHostAdmissions();
  }

  private syncPendingHostAdmissions(): void {
    useGameStore.getState().setPendingAdmissions([...this.pendingHostAdmissions.values()].map((pending) => ({
      admissionId: pending.admissionId,
      deviceFingerprint: pending.deviceFingerprint,
      status: pending.status,
    })));
  }

  private publishPendingJoinFingerprint(binding: RoomInvitationMemberBindingV4 | null): void {
    useGameStore.getState().setPendingJoinFingerprint(binding === null
      ? null
      : secureAdmissionBindingFingerprintV4(binding));
  }

  private armPendingHostAdmissionTimeout(pending: PendingHostAdmission): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    const delay = Math.max(0, pending.expiresAt - Date.now());
    const generation = this.executingGeneration ?? this.generation;
    pending.timeout = setTimeout(() => this.enqueue(async () => {
      const current = this.pendingHostAdmissions.get(pending.admissionId);
      if (current !== pending || current.inFlight) return;
      this.removePendingHostAdmission(pending.admissionId);
      this.sendAdmissionCancellation(pending.admissionId, pending.fromDeviceId);
    }, generation), delay);
  }

  private async handleRelay(
    delivery: Extract<SecureServerFrameV4, { type: "relay" }>,
  ): Promise<void> {
    const engine = this.requireEngine();
    const envelope = delivery.frame.envelope;
    if (envelope.roomInstance !== engine.roomInstance) {
      await this.protocolClose("cross-room relay");
      return;
    }
    const payload = fromBase64Url(envelope.payload);
    if (!payload) {
      await this.protocolClose("invalid relay payload");
      return;
    }

    if (delivery.frame.relayKind === "welcome") {
      if (delivery.logicalOrder !== null || envelope.route !== "device" || envelope.to !== engine.deviceId) {
        await this.protocolClose("invalid Welcome route");
        return;
      }
      const bundle = decodeSecureAdmissionBundleV4(payload);
      if (!bundle) {
        await this.protocolClose("invalid Welcome bundle");
        return;
      }
      const result = await engine.join(
        bundle.welcome, bundle.ratchetTree, envelope.messageId, delivery.frame.admissionId,
      );
      if (result.kind === "join") {
        const retained = this.retainedJoinAuthEntry();
        if (!retained || retained.admissionId !== delivery.frame.admissionId) {
          throw new Error("Welcome admission does not match retained join authentication");
        }
        this.activateMembershipBarrier();
      }
      this.ackDurableDelivery(envelope.messageId);
      return;
    }

    if (delivery.frame.relayKind === "commit" && delivery.logicalOrder !== null ||
        delivery.frame.relayKind !== "commit" && (delivery.logicalOrder === null ||
          delivery.logicalOrder !== delivery.frame.grant.logicalOrder)) {
      await this.protocolClose("invalid relay logical order");
      return;
    }
    const relayContext = inboundRelayContext(delivery.frame);
    this.assertInboundRetirementContext(relayContext, envelope.messageId);
    const result = await engine.receive(payload, {
      messageId: envelope.messageId,
      fromDeviceId: delivery.fromDeviceId,
      logicalOrder: delivery.logicalOrder,
      relayContext,
    });
    if (result.kind !== "already-processed") {
      applySecureRoomUiV4(result.state, result.effects, engine.deviceId);
      if (result.kind === "inbound-commit" && relayContext.kind === "commit" &&
          relayContext.retirementDeviceId !== undefined) {
        this.consumeRetirementBarrier({
          deviceId: relayContext.retirementDeviceId,
          admissionCommitMessageId: relayContext.retirementAdmissionCommitMessageId!,
        });
      }
      if (result.kind === "inbound-commit" && result.retired) {
        this.ackDurableDelivery(envelope.messageId);
        // Voluntary leave completes through the sender's accepted
        // member-leave event above. Receiving an MLS Remove for this device is
        // therefore an externally initiated retirement (vote, host cleanup,
        // or zombie removal) and must not masquerade as an intentional exit.
        await this.finishTerminal("You were removed from the secure fort.", false);
        return;
      }
      this.ackDurableDelivery(envelope.messageId);
      await this.afterAppliedState(result.state, result.effects);
    } else {
      if (delivery.frame.relayKind === "commit" && relayContext.kind === "commit" &&
          relayContext.retirementDeviceId !== undefined &&
          !engine.roster().some((entry) => entry.deviceId === relayContext.retirementDeviceId)) {
        const replayedBarrier = {
          deviceId: relayContext.retirementDeviceId,
          admissionCommitMessageId: relayContext.retirementAdmissionCommitMessageId!,
        };
        engine.resolveRetirementBarrier(replayedBarrier);
        this.consumeRetirementBarrier(replayedBarrier);
      }
      this.ackDurableDelivery(envelope.messageId);
    }
  }

  private async handleApplicationPreview(
    preview: Extract<SecureServerFrameV4, { type: "application-preview" }>,
  ): Promise<void> {
    const payload = fromBase64Url(preview.frame.envelope.payload);
    let decision: "approve" | "reject" = "reject";
    if (payload && this.isHost()) {
      try {
        await this.requireEngine().inspectInboundApplication(
          payload,
          preview.fromDeviceId,
          preview.logicalOrder,
          inboundRelayContext(preview.frame),
        );
        decision = "approve";
      } catch {}
    }
    this.sendClientFrame({
      kind: "application-decision", v: 4, suite: 1,
      roomInstance: this.requireEngine().roomInstance,
      requestId: randomSecureRoomIdV4(16),
      messageId: preview.frame.envelope.messageId,
      decision,
    });
  }

  private async handleCommitPreview(
    preview: Extract<SecureServerFrameV4, { type: "commit-preview" }>,
  ): Promise<void> {
    const payload = fromBase64Url(preview.frame.envelope.payload);
    let decision: "approve" | "reject" = "reject";
    if (payload && this.isHost()) {
      try {
        await this.requireEngine().inspectInboundCommit(payload, preview.fromDeviceId);
        decision = "approve";
      } catch {}
    }
    this.sendClientFrame({
      kind: "commit-decision", v: 4, suite: 1,
      roomInstance: this.requireEngine().roomInstance,
      requestId: randomSecureRoomIdV4(16),
      messageId: preview.frame.envelope.messageId,
      decision,
    });
  }

  private async handleAdmissionProofPreview(
    preview: Extract<SecureServerFrameV4, { type: "admission-proof-preview" }>,
  ): Promise<void> {
    const engine = this.requireEngine();
    const payload = fromBase64Url(preview.frame.envelope.payload);
    if (!payload || !this.isHost()) return;
    try {
      await engine.inspectInboundApplication(
        payload,
        preview.fromDeviceId,
        preview.logicalOrder,
        inboundRelayContext(preview.frame),
      );
      const rosterEntry = engine.roster().find((entry) => entry.deviceId === preview.fromDeviceId);
      if (!rosterEntry) throw new Error("admission proof signer absent from MLS roster");
      this.sendClientFrame({
        kind: "activate", v: 4, suite: 1,
        roomInstance: engine.roomInstance,
        requestId: randomSecureRoomIdV4(16),
        deviceId: preview.fromDeviceId,
        admissionId: preview.frame.admissionId,
        proofMessageId: preview.frame.envelope.messageId,
        signaturePublicKey: rosterEntry.signaturePublicKey,
      });
    } catch {
      // Failing closed means no activate frame; the relay expires the admission.
    }
  }

  private async handleGrant(grant: SecureLogicalOrderGrantV4): Promise<void> {
    const engine = this.requireEngine();
    if (grant.roomInstance !== engine.roomInstance || grant.deviceId !== engine.deviceId) {
      await this.protocolClose("misbound order grant");
      return;
    }
    if (this.pendingGrant?.requestId === grant.requestId) {
      const pending = this.pendingGrant;
      this.pendingGrant = null;
      let intent = pending.intent;
      if (this.hasMembershipBarrier() && !this.isIntentAllowedDuringMembershipBarrier(intent.key)) {
        this.releaseIntentKey(intent.key);
        const replacementIndex = this.grantQueue.findIndex((candidate) =>
          this.isIntentAllowedDuringMembershipBarrier(candidate.key));
        if (replacementIndex < 0) {
          this.pumpGrantQueue();
          return;
        }
        intent = this.grantQueue.splice(replacementIndex, 1)[0];
      }
      try {
        const messageId = await intent.run(grant);
        if (messageId) {
          this.rememberMessageIntent(messageId, intent.key);
        } else {
          this.releaseIntentKey(intent.key);
          this.pumpGrantQueue();
        }
      } catch (error) {
        this.releaseIntentKey(intent.key);
        this.showOperationError(error);
        this.pumpGrantQueue();
      }
      return;
    }

    const retained = this.retainedJoinAuthEntry();
    if (retained && grant.requestId === retained.admissionId) {
      const existing = engine.pendingOutbox.find((entry) =>
        entry.kind === "application" && entry.relayContext.kind === "join-proof");
      if (existing) this.sendPendingEntry(existing.messageId);
      else await this.sendJoinProof(grant, retained.admissionId);
      return;
    }
    const retry = engine.pendingOutbox.find((entry) => entry.grant?.tokenId === grant.tokenId);
    if (retry) {
      this.sendPendingEntry(retry.messageId);
      return;
    }
    await this.protocolClose("unsolicited order grant");
  }

  private async handleOrderExpired(tokenId: string): Promise<void> {
    const engine = this.requireEngine();
    const entry = engine.pendingOutbox.find((candidate) => candidate.grant?.tokenId === tokenId);
    if (!entry || (entry.kind !== "application" && entry.kind !== "commit" && entry.kind !== "admission")) return;
    const messageId = entry.messageId;
    try {
      const outcome = await engine.rejectOutbound(messageId);
      this.releaseMessageIntent(messageId);
      if (outcome === "retired") {
        await this.finishTerminal("Secure membership changed but the relay rejected it. Rejoin with a fresh invitation.", false);
        return;
      }
      applySecureRoomUiV4(engine.state, [], engine.deviceId);
      this.pumpGrantQueue();
    } catch (error) {
      this.showOperationError(error);
    }
  }

  private async handleOrderCancelled(
    requestId: string,
    reason: Extract<SecureServerFrameV4, { type: "order-cancelled" }>['reason'],
  ): Promise<void> {
    if (this.pendingGrant?.requestId === requestId) {
      const intent = this.pendingGrant.intent;
      this.pendingGrant = null;
      if ((reason === "removal-pending" || reason === "admission-pending") &&
          !this.isIntentAllowedDuringMembershipBarrier(intent.key)) {
        this.releaseIntentKey(intent.key);
      } else {
        this.grantQueue.unshift(intent);
      }
      if (!this.replayingBacklog) this.pumpGrantQueue();
      return;
    }

    // A barrier can race with the client after a grant has already been used
    // and durably recorded but before the relay accepts its ciphertext. The
    // original pendingGrant is gone at that point; locate the exact grant in
    // the durable outbox and resolve its rollback boundary so the membership
    // transition cannot deadlock behind stale encrypted work.
    const engine = this.requireEngine();
    const entry = engine.pendingOutbox.find((candidate) =>
      candidate.grant?.requestId === requestId &&
      (candidate.kind !== "admission" || !candidate.commitAcknowledged));
    if (!entry) return;
    try {
      const outcome = await engine.rejectOutbound(entry.messageId);
      this.releaseMessageIntent(entry.messageId);
      if (outcome === "retired") {
        await this.finishTerminal(
          "Secure membership changed but the relay cancelled it. Rejoin with a fresh invitation.",
          false,
        );
        return;
      }
      applySecureRoomUiV4(engine.state, [], engine.deviceId);
      if (reason === "removal-pending" || reason === "admission-pending") {
        this.activateMembershipBarrier();
      }
    } catch (error) {
      this.showOperationError(error);
      return;
    }
    if (!this.replayingBacklog) this.pumpGrantQueue();
  }

  private async handleFrameAccepted(messageId: string): Promise<void> {
    const engine = this.requireEngine();
    if (messageId === this.resumeCompleteRequestId) {
      this.resumeCompleteRequestId = null;
      this.replayingBacklog = false;
      await this.retryDurableWork();
      this.maybeSchedulePostCompromiseUpdate(true);
      return;
    }
    if (this.transientControlIds.delete(messageId)) return;

    const before = engine.pendingOutbox;
    const entry = before.find((candidate) => candidate.messageId === messageId ||
      candidate.kind === "admission" && candidate.welcomeMessageId === messageId);
    if (!entry) return;
    const recoveredUi = messageId === entry.messageId &&
      (entry.kind === "application" || entry.kind === "commit" ||
        entry.kind === "admission" && entry.welcomeMessageId !== null)
      ? await this.recoverOutboundUi(messageId)
      : null;
    const acceptedRetirement = entry.kind === "commit"
      ? this.retirementBarrierForCommit(entry.messageId)
      : null;
    const backlogBackedCommitResult = messageId === entry.messageId &&
      (entry.kind === "commit" || entry.kind === "admission");
    await engine.acknowledgeOutbound(messageId);
    // The relay durably queues accepted commit/Add results for the sender.
    // Clear that exact delivery only after the matching local transaction is
    // durable, and before any follow-on order request or automation.
    if (backlogBackedCommitResult) this.ackDurableDelivery(messageId);

    if (entry.kind === "application") {
      this.applyAcceptedOutbound(recoveredUi);
      if (entry.relayContext.kind === "bootstrap") {
        await engine.completeAdmission(entry.relayContext.admissionId);
      }
      this.releaseMessageIntent(messageId);
    } else if (entry.kind === "commit") {
      if (acceptedRetirement) {
        engine.resolveRetirementBarrier(acceptedRetirement);
        this.consumeRetirementBarrier(acceptedRetirement);
      }
      this.applyAcceptedOutbound(recoveredUi);
      this.releaseMessageIntent(messageId);
    } else if (entry.welcomeMessageId !== null) {
      if (messageId === entry.messageId) {
        this.applyAcceptedOutbound(recoveredUi);
        this.releaseMessageIntent(messageId);
        if (recoveredUi) await this.afterAppliedState(recoveredUi.state, recoveredUi.effects);
        this.sendPendingEntry(entry.welcomeMessageId);
        return;
      }
      if (messageId === entry.welcomeMessageId) {
        this.enqueueBootstrap(entry.admissionId);
      }
    }
    if (recoveredUi) await this.afterAppliedState(recoveredUi.state, recoveredUi.effects);
    else {
      await this.retryRelayControls();
      await this.runAutomations();
    }
    this.pumpGrantQueue();
  }

  private async handleApplicationResult(
    result: Extract<SecureServerFrameV4, { type: "application-result" }>,
  ): Promise<void> {
    const engine = this.requireEngine();
    const entry = engine.pendingOutbox.find(
      (candidate): candidate is Extract<SecureRoomPendingOutboxEntryV1, { kind: "application" }> =>
        candidate.kind === "application" && candidate.messageId === result.messageId,
    );
    if (!entry) return;
    if (entry.event.logicalOrder !== result.logicalOrder) {
      await this.protocolClose("application result order mismatch");
      return;
    }
    const content = entry.event.content;
    if (result.result === "accepted") {
      const recoveredUi = await this.recoverOutboundUi(result.messageId);
      await engine.acknowledgeOutbound(result.messageId);
      this.ackDurableDelivery(result.messageId);
      this.applyAcceptedOutbound(recoveredUi);
      if (entry.relayContext.kind === "join-proof") {
        useGameStore.getState().setPendingJoinFingerprint(null);
        this.initializeUi(false);
      }
      this.releaseMessageIntent(result.messageId);
      if (content.type === "member-leave") {
        await engine.retire();
        await this.finishTerminal("You left the secure fort.", false);
        return;
      }
      await this.afterAppliedState(recoveredUi.state, recoveredUi.effects);
    } else {
      await engine.rejectOutbound(result.messageId);
      this.ackDurableDelivery(result.messageId);
      this.outboundUi.delete(result.messageId);
      this.releaseMessageIntent(result.messageId);
      applySecureRoomUiV4(engine.state, [], engine.deviceId);
      if (content.type === "member-leave" || content.type === "room-close") {
        useGameStore.getState().setIntentionalLeave(false);
      }
    }
    this.pumpGrantQueue();
  }

  private async handleCommitRejected(
    messageId: string,
    _reason: Extract<SecureServerFrameV4, { type: "commit-rejected" }>['reason'],
  ): Promise<void> {
    const engine = this.requireEngine();
    if (!engine.pendingOutbox.some((entry) =>
      (entry.kind === "commit" || entry.kind === "admission") && entry.messageId === messageId)) return;
    const outcome = await engine.rejectOutbound(messageId);
    this.ackDurableDelivery(messageId);
    this.outboundUi.delete(messageId);
    this.releaseMessageIntent(messageId);
    if (outcome === "retired") {
      await this.finishTerminal("Secure membership changed but the relay rejected it. Rejoin with a fresh invitation.", false);
      return;
    }
    applySecureRoomUiV4(engine.state, [], engine.deviceId);
    this.pumpGrantQueue();
  }

  private async handleHostTransferAuthorized(
    frame: Extract<SecureServerFrameV4, { type: "host-transfer-authorized" }>,
  ): Promise<void> {
    const engine = this.requireEngine();
    if (frame.fromHostDeviceId === engine.deviceId) return;
    await engine.recordHostTransferAuthorization(frame.offerMessageId, frame.authorizationId);
    // Host-transfer authorization is also a durable target backlog item. Its
    // ACK must precede the order request needed to encrypt the acceptance.
    this.ackDurableDelivery(frame.authorizationId);
  }

  private async handleHostTransferExpired(authorizationId: string): Promise<void> {
    const engine = this.requireEngine();
    const accept = engine.pendingOutbox.find((entry) => entry.kind === "application" &&
      entry.relayContext.kind === "host-transfer-accept" &&
      entry.relayContext.authorizationId === authorizationId);
    if (accept) {
      await engine.rejectOutbound(accept.messageId);
      this.releaseMessageIntent(accept.messageId);
    }
    const control = engine.pendingRelayControls.find((candidate) =>
      candidate.kind === "transfer-host" && candidate.authorizationId === authorizationId);
    if (control) {
      await engine.completeRelayControl({ kind: "host-transfer-expired", authorizationId });
      this.sentDurableControls.delete(authorizationId);
    }
    applySecureRoomUiV4(engine.state, [], engine.deviceId);
    await this.runAutomations();
    this.pumpGrantQueue();
  }

  private async handleRoomStateSnapshot(
    frame: Extract<SecureServerFrameV4, { type: "room-state-snapshot" }>,
  ): Promise<void> {
    if (!this.replayingBacklog || this.roomStateSnapshotReceived) {
      throw new SecureRoomEngineError("unauthorized", "unexpected or duplicate authoritative room snapshot");
    }
    const engine = this.requireEngine();
    const relayMembers = new Map(frame.members.map((member) => [member.deviceId, member.status]));
    const ownRelayStatus = relayMembers.get(engine.deviceId);
    if (ownRelayStatus === undefined) {
      await engine.retire();
      await this.finishTerminal("This secure device was retired. Rejoin with a fresh invitation.", false);
      return;
    }
    if (ownRelayStatus !== "active") {
      throw new SecureRoomEngineError("unauthorized", "resume snapshot did not activate this secure device");
    }

    let rosterIds = new Set(engine.roster().map((entry) => entry.deviceId));
    let applicationMemberIds = new Set(engine.state.members.map((member) => member.deviceId));
    for (const member of frame.members) {
      if (member.status !== "pending" &&
          (!rosterIds.has(member.deviceId) || !applicationMemberIds.has(member.deviceId))) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "relay activated a member without a causally prior MLS Add and signed profile",
        );
      }
    }

    // Resolve a host-transfer application whose relay result was lost across
    // the crash. The exact durable control binds both the target and capability.
    let transferControl = engine.pendingRelayControls.find((control) => control.kind === "transfer-host");
    if (transferControl?.kind === "transfer-host" && transferControl.acceptMessageId !== null) {
      const acceptPending = engine.pendingOutbox.some((entry) =>
        entry.kind === "application" && entry.messageId === transferControl!.acceptMessageId);
      if (acceptPending && frame.pendingHostTransfer === null) {
        if (frame.hostDeviceId === transferControl.targetDeviceId) {
          await engine.acknowledgeOutbound(transferControl.acceptMessageId);
          this.releaseMessageIntent(transferControl.acceptMessageId);
          await engine.completeRelayControl({ kind: "host-changed", deviceId: transferControl.targetDeviceId });
        } else {
          const outcome = await engine.rejectOutbound(transferControl.acceptMessageId);
          if (outcome !== "reverted") {
            throw new SecureRoomEngineError("state-invalid", "host-transfer application rollback retired its device");
          }
          this.releaseMessageIntent(transferControl.acceptMessageId);
          const restored = engine.pendingRelayControls.find((control) => control.kind === "transfer-host");
          if (restored?.kind === "transfer-host" && restored.authorizationId !== null) {
            await engine.completeRelayControl({
              kind: "host-transfer-expired",
              authorizationId: restored.authorizationId,
            });
          }
        }
      } else if (!acceptPending && frame.pendingHostTransfer === null &&
          frame.hostDeviceId === transferControl.targetDeviceId) {
        await engine.completeRelayControl({ kind: "host-changed", deviceId: transferControl.targetDeviceId });
      }
    }

    transferControl = engine.pendingRelayControls.find((control) => control.kind === "transfer-host");
    if (frame.pendingHostTransfer !== null) {
      if (engine.state.pendingHostDeviceId !== frame.pendingHostTransfer.targetDeviceId) {
        throw new SecureRoomEngineError("unauthorized", "relay host-transfer snapshot lacks its signed offer");
      }
      if (transferControl?.kind === "transfer-host" &&
          transferControl.targetDeviceId === frame.pendingHostTransfer.targetDeviceId) {
        if (transferControl.authorizationId === null) {
          await engine.recordHostTransferAuthorization(
            transferControl.offerMessageId,
            frame.pendingHostTransfer.authorizationId,
          );
        } else if (transferControl.authorizationId !== frame.pendingHostTransfer.authorizationId) {
          throw new SecureRoomEngineError("unauthorized", "relay rebound a host-transfer authorization");
        }
      }
    } else if (transferControl?.kind === "transfer-host" &&
        transferControl.authorizationId !== null && transferControl.acceptMessageId === null) {
      await engine.completeRelayControl({
        kind: "host-transfer-expired",
        authorizationId: transferControl.authorizationId,
      });
    }

    transferControl = engine.pendingRelayControls.find((control) => control.kind === "transfer-host");
    const exactPendingAcceptance = transferControl?.kind === "transfer-host" &&
      transferControl.acceptMessageId !== null && frame.pendingHostTransfer !== null &&
      transferControl.targetDeviceId === frame.pendingHostTransfer.targetDeviceId &&
      transferControl.authorizationId === frame.pendingHostTransfer.authorizationId;
    if (engine.state.hostDeviceId !== frame.hostDeviceId && !exactPendingAcceptance) {
      throw new SecureRoomEngineError("unauthorized", "relay host does not match signed E2EE authority");
    }

    const admission = engine.pendingAdmissionBarrier;
    if (admission) {
      const status = relayMembers.get(admission.deviceId);
      if (status === "active" || status === "disconnected") {
        await engine.completeAdmissionLifecycle(admission.deviceId, "active");
      } else if (status === undefined) {
        await engine.completeAdmissionLifecycle(admission.deviceId, "retired");
      }
    }

    rosterIds = new Set(engine.roster().map((entry) => entry.deviceId));
    applicationMemberIds = new Set(engine.state.members.map((member) => member.deviceId));
    for (const deviceId of rosterIds) {
      if (relayMembers.has(deviceId)) continue;
      if (!this.retirementBarriers.has(deviceId)) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "relay retired an MLS member without the exact removal marker",
        );
      }
    }
    for (const deviceId of applicationMemberIds) {
      if (!rosterIds.has(deviceId)) {
        throw new SecureRoomEngineError("state-invalid", "application membership escaped the MLS roster");
      }
    }

    for (;;) {
      const retirement = this.currentRetirementBarrier();
      if (!retirement || relayMembers.has(retirement.deviceId) || rosterIds.has(retirement.deviceId)) break;
      engine.resolveRetirementBarrier(retirement);
      this.consumeRetirementBarrier(retirement);
    }
    for (const control of [...engine.pendingRelayControls]) {
      if (control.kind !== "retire-member" || relayMembers.has(control.deviceId) || rosterIds.has(control.deviceId)) continue;
      if (engine.pendingOutbox.some((entry) => entry.messageId === control.commitMessageId)) {
        await engine.acknowledgeOutbound(control.commitMessageId);
        this.releaseMessageIntent(control.commitMessageId);
      }
      await engine.completeRelayControl({ kind: "member-lifecycle", deviceId: control.deviceId, status: "retired" });
      this.sentDurableControls.delete(control.requestId);
    }

    this.roomStateSnapshotReceived = true;
    applySecureRoomUiV4(engine.state, [], engine.deviceId);
  }

  private async handleBacklogEnd(lastMessageId: string): Promise<void> {
    if (!this.replayingBacklog) return;
    if (!this.roomStateSnapshotReceived) {
      await this.protocolClose("resume backlog omitted its authoritative room snapshot");
      return;
    }
    if (this.resumeCompleteRequestId !== null) {
      throw new SecureRoomEngineError("unauthorized", "duplicate resume backlog terminator");
    }
    const requestId = randomSecureRoomIdV4(16);
    this.resumeCompleteRequestId = requestId;
    this.sendClientFrame({
      kind: "resume-complete", v: 4, suite: 1,
      roomInstance: this.requireEngine().roomInstance,
      requestId,
      lastMessageId,
    });
  }

  private handleZombieRemovalRequired(deviceId: string, admissionCommitMessageId: string): void {
    const engine = this.requireEngine();
    const barrier = { deviceId, admissionCommitMessageId };
    const existingAdmission = this.retirementBarriers.get(deviceId);
    if (existingAdmission !== undefined && existingAdmission !== admissionCommitMessageId ||
        existingAdmission === undefined && [...this.retirementBarriers.entries()].some(
          ([otherDeviceId, marker]) => otherDeviceId !== deviceId && marker === admissionCommitMessageId,
        )) {
      throw new SecureRoomEngineError("unauthorized", "relay rebound a pending zombie retirement marker");
    }
    if (existingAdmission === undefined && this.retirementBarriers.size >= MAX_SECURE_ZOMBIE_REMOVALS_V4) {
      throw new SecureRoomEngineError("pending-saturated", "pending zombie retirement marker limit reached");
    }

    if (!engine.registerRetirementBarrier(barrier)) return;
    if (existingAdmission === undefined) this.retirementBarriers.set(deviceId, admissionCommitMessageId);

    for (const pending of [...this.pendingHostAdmissions.values()]) {
      this.sendAdmissionCancellation(pending.admissionId, pending.fromDeviceId);
    }
    this.clearPendingHostAdmissions();
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.drawTimer = null;
    this.pendingDrawing = null;

    for (let index = this.grantQueue.length - 1; index >= 0; index -= 1) {
      const intent = this.grantQueue[index];
      if (this.isCurrentRetirementIntent(intent.key)) continue;
      this.grantQueue.splice(index, 1);
      this.releaseIntentKey(intent.key);
    }
    if (this.isHost()) this.queueCurrentRetirementBarrier();
    this.pumpGrantQueue();
  }

  private currentRetirementBarrier(): SecureRoomRetirementBarrierV4 | null {
    const current = this.retirementBarriers.entries().next().value as [string, string] | undefined;
    return current
      ? { deviceId: current[0], admissionCommitMessageId: current[1] }
      : null;
  }

  private hasMembershipBarrier(): boolean {
    const engine = this.engine;
    return this.retirementBarriers.size !== 0 || !!engine &&
      ((engine.pendingSignedRemovalDeviceId ?? null) !== null ||
        (engine.pendingAdmissionBarrier ?? null) !== null);
  }

  private isIntentAllowedDuringMembershipBarrier(key: string): boolean {
    const retirement = this.currentRetirementBarrier();
    if (retirement) return key === this.retirementIntentKey(retirement);
    const engine = this.engine;
    if (!engine) return false;
    const removalDeviceId = engine.pendingSignedRemovalDeviceId ?? null;
    if (removalDeviceId !== null) return key.startsWith(`remove:${removalDeviceId}:`);
    const admission = engine.pendingAdmissionBarrier ?? null;
    if (!admission) return true;
    return key === `bootstrap:${admission.admissionId}` ||
      key === `join-proof:${admission.admissionId}`;
  }

  private isPendingEntryAllowedDuringMembershipBarrier(entry: SecureRoomPendingOutboxEntryV1): boolean {
    const retirement = this.currentRetirementBarrier();
    if (retirement) {
      return entry.kind === "commit" && this.retirementBarrierForCommit(entry.messageId) !== null;
    }
    const engine = this.engine;
    if (!engine) return false;
    const removalDeviceId = engine.pendingSignedRemovalDeviceId ?? null;
    if (removalDeviceId !== null) {
      if (entry.kind === "application" &&
          engine.pendingRemovalAuthorizationMessageId === entry.messageId) return true;
      return entry.kind === "commit" && engine.pendingRelayControls.some((control) =>
        control.kind === "retire-member" && control.deviceId === removalDeviceId &&
        control.commitMessageId === entry.messageId);
    }
    const admission = engine.pendingAdmissionBarrier ?? null;
    if (!admission) return true;
    if (entry.kind === "admission") return entry.admissionId === admission.admissionId;
    return entry.kind === "application" &&
      (entry.relayContext.kind === "bootstrap" || entry.relayContext.kind === "join-proof") &&
      entry.relayContext.admissionId === admission.admissionId;
  }

  private activateMembershipBarrier(preserveAdmission: PendingHostAdmission | null = null): void {
    if (!this.hasMembershipBarrier()) return;
    for (const pending of [...this.pendingHostAdmissions.values()]) {
      if (pending === preserveAdmission) continue;
      this.sendAdmissionCancellation(pending.admissionId, pending.fromDeviceId);
      this.removePendingHostAdmission(pending.admissionId);
    }
    for (let index = this.grantQueue.length - 1; index >= 0; index -= 1) {
      const intent = this.grantQueue[index];
      if (this.isIntentAllowedDuringMembershipBarrier(intent.key)) continue;
      this.grantQueue.splice(index, 1);
      this.releaseIntentKey(intent.key);
    }
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.drawTimer = null;
    this.pendingDrawing = null;
    if (!this.isHost()) return;
    const retirement = this.currentRetirementBarrier();
    if (retirement) {
      this.queueCurrentRetirementBarrier();
      return;
    }
    const removalDeviceId = this.engine?.pendingSignedRemovalDeviceId ?? null;
    if (removalDeviceId) this.queueMemberRemoval(removalDeviceId, "durable-pending-removal");
  }

  private retirementIntentKey(barrier: SecureRoomRetirementBarrierV4): string {
    return `remove:${barrier.deviceId}:zombie:${barrier.admissionCommitMessageId}`;
  }

  private isCurrentRetirementIntent(key: string): boolean {
    const current = this.currentRetirementBarrier();
    return current !== null && key === this.retirementIntentKey(current);
  }

  private queueCurrentRetirementBarrier(): void {
    const current = this.currentRetirementBarrier();
    if (!current || !this.isHost()) return;
    this.queueMemberRemoval(
      current.deviceId,
      `zombie:${current.admissionCommitMessageId}`,
      current,
    );
  }

  private retirementBarrierForCommit(messageId: string): SecureRoomRetirementBarrierV4 | null {
    const current = this.currentRetirementBarrier();
    if (!current) return null;
    const control = this.requireEngine().pendingRelayControls.find((candidate) =>
      candidate.kind === "retire-member" && candidate.commitMessageId === messageId &&
      candidate.deviceId === current.deviceId &&
      candidate.retirementAdmissionCommitMessageId === current.admissionCommitMessageId);
    return control ? current : null;
  }

  private assertInboundRetirementContext(context: SecureRoomInboundRelayContext, messageId: string): void {
    const current = this.currentRetirementBarrier();
    if (!current) {
      if (context.kind === "commit" && context.retirementDeviceId !== undefined) {
        // receive() recomputes a digest over ciphertext plus this exact relay
        // context before returning already-processed, so a crash replay of an
        // already-consumed Remove needs no fresh relay-controlled barrier.
        if (this.requireEngine().hasProcessedRelayMessage(messageId)) return;
        throw new SecureRoomEngineError("unauthorized", "unregistered relay retirement commit was delivered");
      }
      return;
    }
    if (context.kind !== "commit" || context.admissionId !== undefined ||
        context.retirementDeviceId !== current.deviceId ||
        context.retirementAdmissionCommitMessageId !== current.admissionCommitMessageId) {
      throw new SecureRoomEngineError("unauthorized", "relay delivery bypassed the FIFO zombie retirement barrier");
    }
  }

  private consumeRetirementBarrier(barrier: SecureRoomRetirementBarrierV4): void {
    const current = this.currentRetirementBarrier();
    if (!current || current.deviceId !== barrier.deviceId ||
        current.admissionCommitMessageId !== barrier.admissionCommitMessageId) {
      throw new SecureRoomEngineError("unauthorized", "retirement commit consumed a non-current zombie marker");
    }
    this.retirementBarriers.delete(barrier.deviceId);
    if (this.isHost()) this.queueCurrentRetirementBarrier();
  }

  private async handleMemberLifecycle(
    deviceId: string,
    status: "pending" | "active" | "disconnected" | "retired",
  ): Promise<void> {
    const engine = this.requireEngine();
    if (status === "retired" && deviceId === engine.deviceId) {
      await engine.retire();
      await this.finishTerminal("This secure device was retired. Rejoin with a fresh invitation.", false);
      return;
    }
    if (status === "active" &&
        (!engine.roster().some((entry) => entry.deviceId === deviceId) ||
          !engine.state.members.some((member) => member.deviceId === deviceId))) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "relay activated a member without a causally prior MLS Add and signed profile",
      );
    }
    let admissionResolved = false;
    if (status === "active" || status === "retired") {
      admissionResolved = await engine.completeAdmissionLifecycle(deviceId, status);
    }
    if (status === "active" && deviceId === engine.deviceId && engine.isAuthenticationAmbiguous) {
      await engine.markAuthenticated();
      this.unresolvedAuthentication = false;
      this.clearRecoveryForCurrentConfig();
    }
    if (status === "retired") {
      const retirement = this.currentRetirementBarrier();
      if (retirement?.deviceId === deviceId) {
        engine.resolveRetirementBarrier(retirement);
        this.consumeRetirementBarrier(retirement);
      }
      const control = engine.pendingRelayControls.find((candidate) =>
        candidate.kind === "retire-member" && candidate.deviceId === deviceId);
      if (control?.kind === "retire-member") {
        await engine.completeRelayControl({ kind: "member-lifecycle", deviceId, status });
        this.sentDurableControls.delete(control.requestId);
      }
    }
    if (admissionResolved) {
      await this.retryDurableWork();
      await this.runAutomations();
      this.pumpGrantQueue();
    }
  }

  private async handleHostChanged(deviceId: string): Promise<void> {
    const engine = this.requireEngine();
    const control = engine.pendingRelayControls.find((candidate) =>
      candidate.kind === "transfer-host" && candidate.targetDeviceId === deviceId);
    if (control?.kind === "transfer-host") {
      await engine.completeRelayControl({ kind: "host-changed", deviceId });
      if (control.authorizationId) this.sentDurableControls.delete(control.authorizationId);
    }
    applySecureRoomUiV4(engine.state, [], engine.deviceId);
    await this.runAutomations();
  }

  private async handleRoomRetired(): Promise<void> {
    const engine = this.requireEngine();
    const close = engine.pendingRelayControls.some((control) => control.kind === "close-room");
    if (close) await engine.completeRelayControl({ kind: "room-retired" });
    else await engine.retire();
    await this.finishTerminal("The secure fort was knocked down.", false);
  }

  private enqueueGrantIntent(intent: GrantIntent, priority = false): void {
    if (this.hasMembershipBarrier() && !this.isIntentAllowedDuringMembershipBarrier(intent.key)) return;
    if (this.intentKeys.has(intent.key)) return;
    if (this.grantQueue.length >= MAX_QUEUED_ACTIONS) {
      useGameStore.getState().showError("Secure action queue is full. Try again in a moment.");
      return;
    }
    if (!this.rememberIntentKey(intent.key)) return;
    if (priority) this.grantQueue.unshift(intent);
    else this.grantQueue.push(intent);
    this.pumpGrantQueue();
  }

  private pumpGrantQueue(): void {
    if (!this.authenticated || this.replayingBacklog || this.pendingGrant || !this.engine ||
        this.hasBlockingOutbox() || this.grantQueue.length === 0 || !this.engine.isActive()) return;
    const membershipBarrier = this.hasMembershipBarrier();
    const intentIndex = membershipBarrier
      ? this.grantQueue.findIndex((candidate) => this.isIntentAllowedDuringMembershipBarrier(candidate.key))
      : 0;
    if (intentIndex < 0) return;
    const intent = this.grantQueue.splice(intentIndex, 1)[0];
    const requestId = randomSecureRoomIdV4(16);
    this.pendingGrant = { requestId, intent };
    this.sendClientFrame({
      kind: "order-request", v: 4, suite: 1,
      roomInstance: this.engine.roomInstance,
      requestId,
    });
  }

  private hasBlockingOutbox(): boolean {
    const pendingOutbox = this.requireEngine().pendingOutbox;
    return pendingOutbox.some((entry) => {
      if (entry.kind === "application" || entry.kind === "commit") return true;
      if (entry.welcomeMessageId === null) return !entry.commitAcknowledged;
      return !entry.commitAcknowledged || !entry.welcomeAcknowledged ||
        entry.bootstrapMessageId !== null && pendingOutbox.some((candidate) =>
          candidate.kind === "application" && candidate.messageId === entry.bootstrapMessageId);
    });
  }

  private releaseMessageIntent(messageId: string): void {
    const key = this.messageIntentKeys.get(messageId);
    if (key) this.releaseIntentKey(key);
    this.messageIntentKeys.delete(messageId);
    this.outboundUi.delete(messageId);
    if (key === "pcs:self-update") this.maybeSchedulePostCompromiseUpdate(false);
  }

  private releaseIntentKey(key: string): void {
    this.intentKeys.delete(key);
    if (key === "drawing") this.scheduleDrawingFlush();
  }

  private rememberIntentKey(key: string): boolean {
    if (this.intentKeys.has(key)) return false;
    if (this.intentKeys.size >= MAX_TRACKED_OUTBOUND_UI) {
      useGameStore.getState().showError("Secure action queue is full. Try again in a moment.");
      return false;
    }
    this.intentKeys.add(key);
    return true;
  }

  private rememberOutboundUi(messageId: string, value: OutboundUiResult): void {
    if (!this.outboundUi.has(messageId) && this.outboundUi.size >= MAX_TRACKED_OUTBOUND_UI) {
      throw new SecureRoomEngineError("pending-saturated", "transient outbound UI result limit reached");
    }
    this.outboundUi.set(messageId, value);
  }

  private rememberMessageIntent(messageId: string, key: string): void {
    if (!this.messageIntentKeys.has(messageId) && this.messageIntentKeys.size >= MAX_TRACKED_OUTBOUND_UI) {
      throw new SecureRoomEngineError("pending-saturated", "transient message intent limit reached");
    }
    this.messageIntentKeys.set(messageId, key);
  }

  private trackTransientControlId(requestId: string): void {
    while (this.transientControlIds.size >= MAX_TRACKED_TRANSIENT_CONTROLS) {
      const oldest = this.transientControlIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.transientControlIds.delete(oldest);
    }
    this.transientControlIds.add(requestId);
  }

  private trackSentDurableControl(requestId: string): void {
    while (this.sentDurableControls.size >= MAX_TRACKED_TRANSIENT_CONTROLS) {
      const oldest = this.sentDurableControls.values().next().value as string | undefined;
      if (!oldest) break;
      this.sentDurableControls.delete(oldest);
    }
    this.sentDurableControls.add(requestId);
  }

  private async recoverOutboundUi(messageId: string): Promise<OutboundUiResult> {
    const cached = this.outboundUi.get(messageId);
    if (cached) return cached;
    return this.requireEngine().pendingOutboundUiResult(messageId);
  }

  private applyAcceptedOutbound(ui: OutboundUiResult | null): void {
    const engine = this.requireEngine();
    applySecureRoomUiV4(ui?.state ?? engine.state, ui?.effects ?? [], engine.deviceId);
  }

  private enqueueBootstrap(admissionId: string): void {
    this.enqueueGrantIntent({
      key: `bootstrap:${admissionId}`,
      run: async (grant) => {
        const result = await this.requireEngine().encryptStateSnapshot(admissionId, grant);
        this.rememberOutboundUi(result.messageId, { state: result.state, effects: result.effects });
        this.sendPendingEntry(result.messageId);
        return result.messageId;
      },
    }, true);
  }

  private async sendJoinProof(grant: SecureLogicalOrderGrantV4, admissionId: string): Promise<void> {
    const engine = this.requireEngine();
    const welcome = engine.pendingOutbox.find((entry) => entry.kind === "application" &&
      entry.relayContext.kind === "join-proof" && entry.relayContext.admissionId === admissionId);
    if (welcome?.kind === "application") {
      this.sendPendingEntry(welcome.messageId);
      return;
    }
    const processedWelcome = this.retainedJoinAuthEntry()?.joinWelcomeMessageId ?? null;
    if (!processedWelcome) throw new Error("join proof grant arrived before durable Welcome/bootstrap processing");
    const result = await engine.encryptJoinProof(
      this.config!.displayName,
      admissionId,
      processedWelcome,
      grant,
    );
    this.rememberOutboundUi(result.messageId, { state: result.state, effects: result.effects });
    this.rememberMessageIntent(result.messageId, `join-proof:${admissionId}`);
    this.rememberIntentKey(`join-proof:${admissionId}`);
    this.sendPendingEntry(result.messageId);
  }

  private sendPendingEntry(messageId: string): void {
    const engine = this.requireEngine();
    const entry = engine.pendingOutbox.find((candidate) => candidate.messageId === messageId ||
      candidate.kind === "admission" && candidate.welcomeMessageId === messageId);
    if (!entry) return;
    if (!this.isPendingEntryAllowedDuringMembershipBarrier(entry)) return;
    if (entry.kind === "commit") {
      const retirementBarrier = this.currentRetirementBarrier();
      const exactRetirement = this.retirementBarrierForCommit(entry.messageId);
      if (retirementBarrier && !exactRetirement) return;
      this.sendClientFrame({
        kind: "relay", relayKind: "commit", grant: entry.grant,
        ...(exactRetirement && {
          retirementDeviceId: exactRetirement.deviceId,
          retirementAdmissionCommitMessageId: exactRetirement.admissionCommitMessageId,
        }),
        envelope: this.envelope(entry.messageId, "group", entry.outbound),
      });
      return;
    }
    if (entry.kind === "application") {
      const envelope = this.envelope(entry.messageId, "group", entry.outbound);
      switch (entry.relayContext.kind) {
        case "application":
          this.sendClientFrame({ kind: "relay", relayKind: "application", grant: entry.grant, envelope });
          return;
        case "bootstrap":
          this.sendClientFrame({
            kind: "relay", relayKind: "bootstrap",
            admissionId: entry.relayContext.admissionId,
            welcomeMessageId: entry.relayContext.welcomeMessageId,
            grant: entry.grant,
            envelope,
          });
          return;
        case "join-proof":
          this.sendClientFrame({
            kind: "relay", relayKind: "join-proof",
            admissionId: entry.relayContext.admissionId,
            welcomeMessageId: entry.relayContext.welcomeMessageId,
            grant: entry.grant,
            envelope,
          });
          return;
        case "host-transfer-accept":
          this.sendClientFrame({
            kind: "relay", relayKind: "host-transfer-accept",
            authorizationId: entry.relayContext.authorizationId,
            grant: entry.grant,
            envelope,
          });
          return;
      }
    }
    if (entry.welcomeMessageId === null) return;
    if (!entry.commitAcknowledged) {
      this.sendClientFrame({
        kind: "relay", relayKind: "commit",
        grant: entry.grant!,
        admissionId: entry.admissionId,
        envelope: this.envelope(entry.messageId, "group", entry.outbound),
      });
      return;
    }
    if (!entry.welcomeAcknowledged && entry.welcome && entry.ratchetTree && entry.addedDeviceId) {
      const bundle = encodeSecureAdmissionBundleV4(entry.welcome, entry.ratchetTree);
      try {
        this.sendClientFrame({
          kind: "relay", relayKind: "welcome",
          admissionId: entry.admissionId,
          commitMessageId: entry.messageId,
          envelope: this.envelope(entry.welcomeMessageId, "device", bundle, entry.addedDeviceId),
        });
      } finally {
        bundle.fill(0);
      }
    }
  }

  private envelope(
    messageId: string,
    route: "group" | "device",
    payload: Uint8Array,
    to?: string,
  ): SecureRelayEnvelopeV4 {
    return {
      v: 4,
      suite: 1,
      roomInstance: this.requireEngine().roomInstance,
      messageId,
      route,
      ...(route === "device" && to ? { to } : {}),
      payload: toBase64Url(payload),
    };
  }

  private async retryDurableWork(): Promise<void> {
    const engine = this.requireEngine();
    for (const entry of engine.pendingOutbox) {
      if (entry.kind === "application" || entry.kind === "commit") {
        this.sendPendingEntry(entry.messageId);
      } else if (entry.welcomeMessageId !== null) {
        if (!entry.commitAcknowledged) this.sendPendingEntry(entry.messageId);
        else if (!entry.welcomeAcknowledged) this.sendPendingEntry(entry.welcomeMessageId);
        else if (entry.bootstrapMessageId === null) this.enqueueBootstrap(entry.admissionId);
      }
    }
    await this.retryRelayControls();
    this.pumpGrantQueue();
  }

  private async retryRelayControls(): Promise<void> {
    if (!this.authenticated || this.replayingBacklog) return;
    const engine = this.requireEngine();
    for (const original of engine.pendingRelayControls) {
      let control = original;
      if (control.kind === "admission-barrier") continue;
      if (control.kind === "retire-member") {
        const { requestId, deviceId, commitMessageId } = control;
        if (engine.pendingOutbox.some((entry) => entry.messageId === commitMessageId) ||
            this.sentDurableControls.has(requestId)) continue;
        this.trackSentDurableControl(requestId);
        this.sendClientFrame({
          kind: "retire-member", v: 4, suite: 1,
          roomInstance: engine.roomInstance,
          requestId,
          deviceId,
          commitMessageId,
        });
        continue;
      }
      if (control.kind === "close-room") {
        const { requestId, authorizationMessageId } = control;
        if (engine.pendingOutbox.some((entry) => entry.messageId === authorizationMessageId) ||
            this.sentDurableControls.has(requestId)) continue;
        this.trackSentDurableControl(requestId);
        this.sendClientFrame({
          kind: "close-room", v: 4, suite: 1,
          roomInstance: engine.roomInstance,
          requestId,
          authorizationMessageId,
        });
        continue;
      }
      const offerMessageId = control.offerMessageId;
      if (control.targetDeviceId === engine.deviceId) continue;
      if (engine.state.hostDeviceId !== engine.deviceId ||
          engine.pendingOutbox.some((entry) => entry.messageId === offerMessageId)) continue;
      if (control.authorizationId === null) {
        const authorizationId = await engine.renewHostTransferAuthorization(offerMessageId);
        control = { ...control, authorizationId };
      }
      const authorizationId = control.authorizationId;
      if (authorizationId === null || this.sentDurableControls.has(authorizationId)) continue;
      this.trackSentDurableControl(authorizationId);
      this.sendClientFrame({
        kind: "authorize-host-transfer", v: 4, suite: 1,
        roomInstance: engine.roomInstance,
        requestId: authorizationId,
        deviceId: control.targetDeviceId,
        offerMessageId,
      });
    }
  }

  private ackDurableDelivery(lastMessageId: string): void {
    if (this.replayingBacklog) return;
    // If the socket closed after the local durable transaction, leave the
    // relay item pending. Resume's authoritative backlog cursor will clear it;
    // throwing here would skip local UI/automation reconciliation.
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const requestId = randomSecureRoomIdV4(16);
    this.trackTransientControlId(requestId);
    this.sendClientFrame({
      kind: "delivery-ack", v: 4, suite: 1,
      roomInstance: this.requireEngine().roomInstance,
      requestId,
      lastMessageId,
    });
  }

  private sendClientFrame(frame: SecureClientFrameV4): void {
    if (!parseSecurePostAuthClientFrameV4(frame)) throw new Error("constructed secure client frame is invalid");
    this.sendWire(frame);
  }

  private sendWire(frame: SecureAuthenticateFrameV4 | SecureClientFrameV4): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("secure socket is not open");
    const wire = JSON.stringify(frame);
    if (UTF8.encode(wire).byteLength > MAX_SECURE_WEBSOCKET_FRAME_BYTES) {
      throw new Error("constructed secure frame exceeds the protocol cap");
    }
    socket.send(wire);
  }

  private maybeSchedulePostCompromiseUpdate(immediate: boolean): void {
    if (immediate) this.pcsDue = true;
    if (this.pcsTimer) clearTimeout(this.pcsTimer);
    const generation = this.executingGeneration ?? this.generation;
    this.pcsTimer = setTimeout(() => {
      this.pcsTimer = null;
      this.pcsDue = true;
      this.enqueue(async () => this.runAutomations(), generation);
    }, SECURE_PCS_UPDATE_INTERVAL_MS);
    this.maybeEnqueuePcsUpdate();
  }

  private maybeEnqueuePcsUpdate(): void {
    const engine = this.engine;
    if (!this.pcsDue || !engine || !this.authenticated || this.replayingBacklog ||
        this.hasMembershipBarrier() ||
        engine.pendingOutbox.length !== 0 || engine.pendingRelayControls.length !== 0 ||
        this.pendingGrant || this.grantQueue.length !== 0) return;
    this.pcsDue = false;
    this.enqueueGrantIntent({
      key: "pcs:self-update",
      run: async (grant) => {
        const result = await engine.selfUpdate(grant);
        this.rememberOutboundUi(result.messageId, { state: engine.state, effects: result.effects });
        this.sendPendingEntry(result.messageId);
        return result.messageId;
      },
    });
  }

  private async mapUiAction(type: string, payload: Record<string, unknown>): Promise<void> {
    const engine = this.requireEngine();
    if (!this.authenticated || this.replayingBacklog || !engine.isActive()) {
      useGameStore.getState().showError("The secure room is reconnecting. Try again in a moment.");
      return;
    }
    if (this.hasMembershipBarrier()) {
      useGameStore.getState().showError("Securing the fort after a member disconnected. Try again in a moment.");
      return;
    }
    const state = engine.state;
    const target = (key: string): string | null => {
      const name = stringField(payload, key)?.normalize("NFC").trim();
      return name ? secureDeviceIdForNameV4(state, name) : null;
    };
    const enqueueGame = (
      game: "vote" | "rps" | "ttt" | "saboteur" | "koth",
      direct: SecureApplicationContentV4,
      targetDeviceId?: string,
    ) => {
      const gameId = "gameId" in direct ? direct.gameId : randomSecureRoomIdV4(16);
      const content: SecureApplicationContentV4 = activeGame(state)
        ? {
            type: "queue",
            action: "enqueue",
            requestId: gameId,
            game,
            ...(targetDeviceId ? { targetDeviceId } : {}),
          }
        : direct;
      this.enqueueApplication(content, `${game}:${gameId}`);
    };

    switch (type) {
      case "admission-approve": {
        const admissionId = stringField(payload, "admissionId");
        if (!admissionId || !this.isHost()) return;
        this.approvePendingHostAdmission(admissionId);
        return;
      }
      case "admission-reject": {
        const admissionId = stringField(payload, "admissionId");
        if (!admissionId || !this.isHost()) return;
        this.rejectPendingHostAdmission(admissionId);
        return;
      }
      case "chat": {
        const text = stringField(payload, "text")?.normalize("NFC").trim();
        if (!text) return;
        const rawStyle = plainRecord(payload.style) ? payload.style : null;
        const style = rawStyle ? {
          ...(rawStyle.bold === true ? { bold: true as const } : {}),
          ...(rawStyle.italic === true ? { italic: true as const } : {}),
          ...(rawStyle.underline === true ? { underline: true as const } : {}),
          ...(typeof rawStyle.color === "string" ? { color: rawStyle.color } : {}),
        } : undefined;
        this.enqueueApplication({ type: "chat", text, ...(style && { style }) }, `chat:${randomSecureRoomIdV4(16)}`);
        return;
      }
      case "typing":
        this.enqueueApplication({ type: "typing" }, "typing");
        return;
      case "draw": {
        const color = stringField(payload, "color");
        if (!color || !Array.isArray(payload.pts) || payload.pts.length < 1 || payload.pts.length > 128) return;
        const points: [number, number][] = [];
        for (const point of payload.pts) {
          if (!Array.isArray(point) || point.length !== 2 ||
              !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
              (point[0] as number) < 0 || (point[0] as number) > 1 ||
              (point[1] as number) < 0 || (point[1] as number) > 1) return;
          points.push([point[0] as number, point[1] as number]);
        }
        this.queueDrawing(color, points, payload.s === 1);
        return;
      }
      case "set-status": {
        if (payload.status !== "available" && payload.status !== "away") return;
        const awayText = stringField(payload, "awayText")?.normalize("NFC").trim();
        this.enqueueApplication({
          type: "presence",
          status: payload.status,
          ...(payload.status === "away" && awayText ? { awayText } : {}),
        }, "presence");
        return;
      }
      case "set-theme":
        if (payload.theme !== "away-message" && payload.theme !== "campus-blue" && payload.theme !== "top-8") return;
        this.enqueueApplication({ type: "theme", theme: payload.theme }, "theme");
        return;
      case "leave":
        if (this.isHost()) return;
        useGameStore.getState().setIntentionalLeave(true);
        this.enqueueApplication({ type: "member-leave" }, "member-leave", true);
        return;
      case "knock-down":
        if (!this.isHost()) return;
        useGameStore.getState().setIntentionalLeave(true);
        this.enqueueApplication({ type: "room-close", reason: "The host knocked down the fort." }, "room-close", true);
        return;
      case "toss-pillow": {
        const targetDeviceId = target("target");
        if (!targetDeviceId) return;
        this.enqueueApplication({ type: "pillow-toss", targetDeviceId }, "host-offer");
        return;
      }
      case "accept-host": {
        const control = engine.pendingRelayControls.find((candidate) => candidate.kind === "transfer-host" &&
          candidate.targetDeviceId === engine.deviceId && candidate.authorizationId !== null &&
          candidate.acceptMessageId === null);
        if (!control || control.kind !== "transfer-host" || !control.authorizationId) {
          useGameStore.getState().showError("That host offer is no longer valid.");
          return;
        }
        this.enqueueApplication(
          { type: "host-transfer", action: "accept", authorizationId: control.authorizationId },
          `host-accept:${control.authorizationId}`,
          true,
        );
        return;
      }
      case "reject-host":
        this.enqueueApplication({ type: "host-transfer", action: "reject" }, "host-reject", true);
        return;
      case "start-vote": {
        const targetDeviceId = target("target");
        if (!targetDeviceId) return;
        const gameId = randomSecureRoomIdV4(16);
        enqueueGame("vote", { type: "vote", action: "start", gameId, targetDeviceId }, targetDeviceId);
        return;
      }
      case "cast-vote":
        if (!state.vote || (payload.vote !== "yes" && payload.vote !== "no")) return;
        this.enqueueApplication({ type: "vote", action: "cast", gameId: state.vote.gameId, choice: payload.vote }, `vote-cast:${state.vote.gameId}`);
        return;
      case "rps-challenge": {
        const targetDeviceId = target("target");
        if (!targetDeviceId) return;
        const gameId = randomSecureRoomIdV4(16);
        enqueueGame("rps", { type: "rps", action: "challenge", gameId, targetDeviceId }, targetDeviceId);
        return;
      }
      case "rps-accept":
      case "rps-decline":
        if (!state.rps) return;
        this.enqueueApplication({
          type: "rps", action: type === "rps-accept" ? "accept" : "decline", gameId: state.rps.gameId,
        }, `${type}:${state.rps.gameId}`);
        return;
      case "rps-cancel":
      case "rps-forfeit": {
        const game = state.rps;
        if (!game) return;
        const cancel = type === "rps-cancel";
        if (cancel ? game.phase !== "pending" || game.p1DeviceId !== engine.deviceId
          : game.phase === "pending" || (game.p1DeviceId !== engine.deviceId && game.p2DeviceId !== engine.deviceId)) return;
        this.enqueueApplication({
          type: "rps", action: cancel ? "cancel" : "forfeit", gameId: game.gameId,
        }, `${type}:${game.gameId}`, true);
        return;
      }
      case "rps-pick":
        if (!state.rps || (payload.pick !== "rock" && payload.pick !== "paper" && payload.pick !== "scissors")) return;
        await this.enqueueRpsCommit(state.rps.gameId, payload.pick);
        return;
      case "ttt-challenge": {
        const targetDeviceId = target("target");
        if (!targetDeviceId) return;
        const gameId = randomSecureRoomIdV4(16);
        enqueueGame("ttt", { type: "ttt", action: "challenge", gameId, targetDeviceId }, targetDeviceId);
        return;
      }
      case "ttt-accept":
      case "ttt-decline":
        if (!state.ttt) return;
        this.enqueueApplication({
          type: "ttt", action: type === "ttt-accept" ? "accept" : "decline", gameId: state.ttt.gameId,
        }, `${type}:${state.ttt.gameId}`);
        return;
      case "ttt-cancel":
      case "ttt-forfeit": {
        const game = state.ttt;
        if (!game) return;
        const cancel = type === "ttt-cancel";
        if (cancel ? game.phase !== "pending" || game.p1DeviceId !== engine.deviceId
          : game.phase === "pending" || (game.p1DeviceId !== engine.deviceId && game.p2DeviceId !== engine.deviceId)) return;
        this.enqueueApplication({
          type: "ttt", action: cancel ? "cancel" : "forfeit", gameId: game.gameId,
        }, `${type}:${game.gameId}`, true);
        return;
      }
      case "ttt-move":
        if (!state.ttt || !Number.isSafeInteger(payload.cell)) return;
        this.enqueueApplication({ type: "ttt", action: "move", gameId: state.ttt.gameId, cell: payload.cell as number }, `ttt-move:${state.ttt.gameId}:${state.ttt.turn}`);
        return;
      case "sab-start": {
        const gameId = randomSecureRoomIdV4(16);
        enqueueGame("saboteur", { type: "saboteur", action: "start", gameId });
        return;
      }
      case "sab-accuse": {
        const suspectDeviceId = target("suspect");
        if (!state.saboteur || !suspectDeviceId) return;
        this.enqueueApplication({ type: "saboteur", action: "accuse", gameId: state.saboteur.gameId, suspectDeviceId }, `sab-accuse:${state.saboteur.gameId}`);
        return;
      }
      case "sab-vote":
        if (!state.saboteur?.accusation || (payload.vote !== "yes" && payload.vote !== "no")) return;
        this.enqueueApplication({ type: "saboteur", action: "vote", gameId: state.saboteur.gameId, choice: payload.vote }, `sab-vote:${state.saboteur.gameId}`);
        return;
      case "sab-strike":
        if (!state.saboteur) return;
        this.enqueueApplication({ type: "saboteur", action: "strike", gameId: state.saboteur.gameId }, `sab-strike:${state.saboteur.gameId}`);
        return;
      case "koth-challenge": {
        const gameId = randomSecureRoomIdV4(16);
        enqueueGame("koth", { type: "koth", action: "challenge", gameId });
        return;
      }
      default:
        return;
    }
  }

  private enqueueApplication(content: SecureApplicationContentV4, key: string, priority = false): void {
    if (this.hasMembershipBarrier()) return;
    this.enqueueGrantIntent({
      key,
      run: async (grant) => {
        const engine = this.requireEngine();
        const result = await engine.encryptEvent(content, grant);
        this.rememberOutboundUi(result.messageId, { state: result.state, effects: result.effects });
        this.sendPendingEntry(result.messageId);
        return result.messageId;
      },
    }, priority);
  }

  private queueDrawing(color: string, points: [number, number][], strokeStart: boolean): void {
    const pending = this.pendingDrawing;
    if (pending && (pending.color !== color || strokeStart)) {
      this.flushPendingDrawing();
      if (this.pendingDrawing) return;
    }
    if (!this.pendingDrawing) this.pendingDrawing = { color, points: [], strokeStart };
    const capacity = 128 - this.pendingDrawing.points.length;
    if (capacity > 0) this.pendingDrawing.points.push(...points.slice(0, capacity));
    this.scheduleDrawingFlush();
  }

  private scheduleDrawingFlush(minimumDelay = 0): void {
    if (!this.pendingDrawing || this.drawTimer || this.stopped || this.terminal) return;
    const delay = Math.max(minimumDelay, this.lastDrawSubmissionAt + DRAW_SUBMISSION_INTERVAL_MS - Date.now());
    const generation = this.executingGeneration ?? this.generation;
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      this.enqueue(async () => this.flushPendingDrawing(), generation);
    }, delay);
  }

  private flushPendingDrawing(): void {
    if (!this.pendingDrawing) return;
    if (this.hasMembershipBarrier()) {
      this.pendingDrawing = null;
      return;
    }
    if (this.intentKeys.has("drawing") || this.stopped || this.terminal || !this.authenticated || this.replayingBacklog) {
      this.scheduleDrawingFlush(DRAW_SUBMISSION_INTERVAL_MS);
      return;
    }
    const drawing = this.pendingDrawing;
    this.pendingDrawing = null;
    this.lastDrawSubmissionAt = Date.now();
    this.enqueueApplication({
      type: "drawing",
      color: drawing.color,
      points: drawing.points,
      ...(drawing.strokeStart ? { strokeStart: true } : {}),
    }, "drawing");
  }

  private async enqueueRpsCommit(gameId: string, pick: SecureRpsPickV4): Promise<void> {
    const engine = this.requireEngine();
    const existing = engine.pendingCommitSecret(gameId);
    if (existing && (existing.kind !== "rps" || existing.pick !== pick)) {
      useGameStore.getState().showError("Your encrypted pick for this round is already locked in.");
      return;
    }
    const nonce = existing?.kind === "rps" ? existing.nonce : randomSecureRoomIdV4(32);
    const commitment = existing?.kind === "rps"
      ? existing.commitment
      : await computeRpsCommitmentV4(gameId, engine.deviceId, pick, nonce);
    this.enqueueGrantIntent({
      key: `rps-commit:${gameId}`,
      run: async (grant) => {
        const result = await engine.encryptCommitEvent(
          { type: "rps", action: "commit", gameId, commitment },
          { kind: "rps", gameId, pick, nonce, commitment },
          grant,
        );
        this.rememberOutboundUi(result.messageId, { state: result.state, effects: result.effects });
        this.sendPendingEntry(result.messageId);
        return result.messageId;
      },
    });
  }

  private async runAutomations(): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.authenticated || this.replayingBacklog || !engine.isActive()) return;
    if (this.hasMembershipBarrier()) {
      this.activateMembershipBarrier();
      return;
    }
    const state = engine.state;

    if (state.hostDeviceId !== engine.deviceId) {
      this.clearPendingHostAdmissions();
    } else if (activeGame(state) || state.pendingHostDeviceId !== null ||
        state.pendingRemovalDeviceIds.length !== 0) {
      for (const pending of [...this.pendingHostAdmissions.values()]) {
        this.removePendingHostAdmission(pending.admissionId);
        this.sendAdmissionCancellation(pending.admissionId, pending.fromDeviceId);
      }
    }

    if (state.hostDeviceId === engine.deviceId) {
      for (const deviceId of state.pendingRemovalDeviceIds) {
        this.queueMemberRemoval(deviceId, "durable-pending-removal");
      }
    }

    const rps = state.rps;
    if (rps && (rps.p1DeviceId === engine.deviceId || rps.p2DeviceId === engine.deviceId)) {
      const ownCommitment = rps.commitments.some((entry) => entry.deviceId === engine.deviceId);
      const ownReveal = rps.reveals.some((entry) => entry.deviceId === engine.deviceId);
      const secret = engine.pendingCommitSecret(rps.gameId);
      if (rps.phase === "committing" && secret?.kind === "rps" && !ownCommitment) {
        await this.enqueueRpsCommit(rps.gameId, secret.pick);
      } else if (rps.phase === "revealing" && !ownReveal && secret?.kind === "rps") {
        this.enqueueApplication({
          type: "rps", action: "reveal", gameId: rps.gameId, pick: secret.pick, nonce: secret.nonce,
        }, `rps-reveal:${rps.gameId}`, true);
      }
    }

    const saboteur = state.saboteur;
    if (saboteur?.participantDeviceIds.includes(engine.deviceId)) {
      const ownCommitment = saboteur.commitments.some((entry) => entry.deviceId === engine.deviceId);
      const ownReveal = saboteur.reveals.some((entry) => entry.deviceId === engine.deviceId);
      let secret = engine.pendingCommitSecret(saboteur.gameId);
      if (saboteur.phase === "committing" && !ownCommitment) {
        if (!secret) {
          const nonce = randomSecureRoomIdV4(32);
          const commitment = await computeSaboteurCommitmentV4(saboteur.gameId, engine.deviceId, nonce);
          secret = { kind: "saboteur", gameId: saboteur.gameId, nonce, commitment };
        }
        if (secret.kind === "saboteur") {
          const durableSecret = secret;
          this.enqueueGrantIntent({
            key: `sab-commit:${saboteur.gameId}`,
            run: async (grant) => {
              const result = await engine.encryptCommitEvent({
                type: "saboteur", action: "entropy-commit",
                gameId: durableSecret.gameId, commitment: durableSecret.commitment,
              }, durableSecret, grant);
              this.rememberOutboundUi(result.messageId, { state: result.state, effects: result.effects });
              this.sendPendingEntry(result.messageId);
              return result.messageId;
            },
          }, true);
        }
      } else if (saboteur.phase === "revealing" && !ownReveal && secret?.kind === "saboteur") {
        this.enqueueApplication({
          type: "saboteur", action: "entropy-reveal", gameId: saboteur.gameId, nonce: secret.nonce,
        }, `sab-reveal:${saboteur.gameId}`, true);
      }
    }

    if (state.pendingHostDeviceId && state.hostDeviceId === engine.deviceId &&
        !engine.pendingRelayControls.some((control) => control.kind === "transfer-host")) {
      this.enqueueApplication({
        type: "host-transfer", action: "offer", targetDeviceId: state.pendingHostDeviceId,
      }, `host-offer:${state.pendingHostDeviceId}`, true);
    }
    this.syncGameTimers(state);
    this.maybeEnqueuePcsUpdate();
  }

  private async afterAppliedState(
    state: SecureRoomStateSnapshotV4,
    effects: readonly SecureReducerEffectV4[],
  ): Promise<void> {
    const engine = this.requireEngine();
    this.activateMembershipBarrier();
    if (state.closedReason !== null) {
      await this.retryRelayControls();
      return;
    }
    this.syncGameTimers(state);
    await this.retryRelayControls();
    await this.runAutomations();
    if (effects.some((effect) => effect.type === "host-changed" || effect.type === "member-removed" || effect.type === "profile")) {
      this.maybeSchedulePostCompromiseUpdate(false);
    }
    // Keep the engine reference live across the awaits above; an abort may have
    // terminally replaced it while timers were being synchronized.
    if (this.engine !== engine) return;
  }

  private queueMemberRemoval(
    deviceId: string,
    reason: string,
    retirementBarrier?: SecureRoomRetirementBarrierV4,
  ): void {
    const engine = this.requireEngine();
    const member = engine.roster().find((entry) => entry.deviceId === deviceId);
    if (!member || member.deviceId === engine.deviceId) return;
    this.enqueueGrantIntent({
      key: `remove:${deviceId}:${reason}`,
      run: async (grant) => {
        const current = engine.roster().find((entry) => entry.deviceId === deviceId);
        if (!current) return null;
        const result = await engine.removeMember(current.leafIndex, grant, retirementBarrier);
        this.rememberOutboundUi(result.messageId, { state: engine.state, effects: result.effects });
        this.sendPendingEntry(result.messageId);
        return result.messageId;
      },
    }, true);
  }

  private syncGameTimers(state: SecureRoomStateSnapshotV4): void {
    if (state.vote?.gameId !== this.voteTimerGameId) {
      if (this.voteTimer) clearTimeout(this.voteTimer);
      this.voteTimer = null;
      this.voteTimerGameId = state.vote?.gameId ?? null;
      if (state.vote && state.hostDeviceId === this.engine?.deviceId) {
        const gameId = state.vote.gameId;
        const generation = this.executingGeneration ?? this.generation;
        this.voteTimer = setTimeout(() => this.enqueue(async () => {
          const current = this.engine?.state.vote;
          if (current?.gameId === gameId && this.isHost()) {
            this.enqueueApplication({ type: "vote", action: "cancel", gameId }, `vote-timeout:${gameId}`, true);
          }
        }, generation), VOTE_DURATION_MS);
      }
    }
    const accusationId = state.saboteur?.accusation ? state.saboteur.gameId : null;
    if (accusationId !== this.saboteurVoteTimerGameId) {
      if (this.saboteurVoteTimer) clearTimeout(this.saboteurVoteTimer);
      this.saboteurVoteTimer = null;
      this.saboteurVoteTimerGameId = accusationId;
      if (accusationId && state.hostDeviceId === this.engine?.deviceId) {
        const generation = this.executingGeneration ?? this.generation;
        this.saboteurVoteTimer = setTimeout(() => this.enqueue(async () => {
          const current = this.engine?.state.saboteur;
          if (current?.gameId === accusationId && current.accusation && this.isHost()) {
            this.enqueueApplication({ type: "saboteur", action: "close", gameId: accusationId }, `sab-timeout:${accusationId}`, true);
          }
        }, generation), SABOTEUR_VOTE_DURATION_MS);
      }
    }
    const entropyPhase = state.saboteur &&
      (state.saboteur.phase === "committing" || state.saboteur.phase === "revealing")
      ? `${state.saboteur.gameId}:${state.saboteur.phase}`
      : null;
    if (entropyPhase !== this.saboteurEntropyTimerPhase) {
      if (this.saboteurEntropyTimer) clearTimeout(this.saboteurEntropyTimer);
      this.saboteurEntropyTimer = null;
      this.saboteurEntropyTimerPhase = entropyPhase;
      if (entropyPhase && state.saboteur && state.hostDeviceId === this.engine?.deviceId) {
        const gameId = state.saboteur.gameId;
        const phase = state.saboteur.phase;
        const generation = this.executingGeneration ?? this.generation;
        this.saboteurEntropyTimer = setTimeout(() => this.enqueue(async () => {
          const current = this.engine?.state.saboteur;
          if (current?.gameId === gameId && current.phase === phase && this.isHost()) {
            this.enqueueApplication({ type: "saboteur", action: "close", gameId }, `sab-entropy-timeout:${entropyPhase}`, true);
          }
        }, generation), SABOTEUR_ENTROPY_DURATION_MS);
      }
    }
  }

  private initializeUi(resumed: boolean): void {
    if (this.uiInitialized) {
      applySecureRoomUiV4(this.requireEngine().state, [], this.requireEngine().deviceId);
      return;
    }
    const engine = this.requireEngine();
    initializeSecureRoomUiV4({
      roomId: this.config!.roomId,
      ownDeviceId: engine.deviceId,
      state: engine.state,
      resumed,
    });
    this.uiInitialized = true;
  }

  private isHost(): boolean {
    return !!this.engine && this.engine.state.hostDeviceId === this.engine.deviceId;
  }

  private installLeaseAbort(lease: RoomCryptoLockLease): void {
    const generation = this.executingGeneration ?? this.generation;
    lease.signal.addEventListener("abort", () => {
      if (this.lease !== lease) return;
      // A takeover revokes this tab's single-writer authority immediately.
      // Gate the socket and UI synchronously; serialized disposal can wait for
      // the currently executing crypto operation to unwind behind its lease
      // checks, but it must not remain externally reachable in the meantime.
      this.pendingHandshake?.settle({ status: "failed", reason: "aborted" });
      this.pendingHandshake = null;
      this.stopped = true;
      this.authenticated = false;
      this.config = null;
      this.closeSocket("secure room ownership transferred");
      this.enqueue(async () => {
        this.engine?.dispose();
        this.engine = null;
        this.discardEngineOnAuthenticationFailure = false;
        this.authenticationMayHaveCommitted = false;
        this.nextAuthenticationMode = null;
        this.lease = null;
        this.clearTimers();
        this.resetUiSession();
        const store = useGameStore.getState();
        store.showError("This secure room moved to another tab.");
        store.cleanup();
        useGameStore.getState().setScreen("home");
      }, generation);
    }, { once: true });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || this.terminal || !this.config || !this.lease?.isActive()) return;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    const store = useGameStore.getState();
    store.setReconnecting(true);
    store.setReconnectAttempts(this.reconnectAttempts);
    const generation = this.generation;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reconnect only after every frame from the closed socket has drained.
      // This prevents an async handler for socket A from mutating socket B's
      // controller session even when crypto/storage work exceeds the backoff.
      this.enqueue(async () => {
        if (generation === this.generation && !this.stopped && !this.terminal && !this.socket &&
            this.lease?.isActive()) {
          this.openSocket(generation, this.pendingHandshake ?? undefined);
        }
      }, generation);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    if (this.voteTimer) clearTimeout(this.voteTimer);
    if (this.saboteurVoteTimer) clearTimeout(this.saboteurVoteTimer);
    if (this.saboteurEntropyTimer) clearTimeout(this.saboteurEntropyTimer);
    if (this.pcsTimer) clearTimeout(this.pcsTimer);
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.voteTimer = null;
    this.saboteurVoteTimer = null;
    this.saboteurEntropyTimer = null;
    this.pcsTimer = null;
    this.drawTimer = null;
    this.pendingDrawing = null;
    this.voteTimerGameId = null;
    this.saboteurVoteTimerGameId = null;
    this.saboteurEntropyTimerPhase = null;
    this.pcsDue = false;
    this.clearPendingHostAdmissions();
    this.grantQueue.splice(0, this.grantQueue.length);
    this.pendingGrant = null;
    this.intentKeys.clear();
    this.messageIntentKeys.clear();
    this.outboundUi.clear();
    this.transientControlIds.clear();
    this.sentDurableControls.clear();
    this.retirementBarriers.clear();
    this.resumeCompleteRequestId = null;
    this.replayingBacklog = false;
    this.roomStateSnapshotReceived = false;
    this.localMemberBinding = null;
    this.founderBinding = null;
    this.publishPendingJoinFingerprint(null);
    useGameStore.getState().setRoomSafetyCode(null);
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.socketEpoch += 1;
    if (socket) socket.onclose = null;
    try { socket?.close(1000, reason); } catch {}
  }

  private releaseLease(): void {
    const lease = this.lease;
    this.lease = null;
    lease?.release();
  }

  private disposeCurrentEngine(): void {
    const engine = this.engine;
    this.engine = null;
    engine?.dispose();
  }

  private rememberRecoveryContext(config: SessionConfig | null = this.config): void {
    if (!config || canonicalBase64UrlByteLength(config.roomInstance) !== SECURE_ROOM_ID_BYTES) return;
    this.recoveryContext = {
      v: 1,
      mode: config.initialMode,
      roomId: config.roomId,
      displayName: config.displayName,
      roomInstance: config.roomInstance!,
      savedAt: Date.now(),
    };
    if (config?.initialMode === "setup" && config.setupRoomInstance) {
      this.recoverySetup = {
        roomId: config.roomId,
        roomInstance: config.setupRoomInstance,
      };
    }
    persistRecoveryContext(this.recoveryContext);
  }

  private clearRecoveryForCurrentConfig(config: SessionConfig | null = this.config): void {
    if (!config) return;
    if (this.recoveryContext?.mode === config.initialMode &&
        this.recoveryContext.roomId === config.roomId &&
        this.recoveryContext.displayName === config.displayName) {
      this.recoveryContext = null;
      persistRecoveryContext(null);
    }
    if (config.initialMode === "setup" && this.recoverySetup?.roomId === config.roomId) {
      this.recoverySetup = null;
    }
    this.unresolvedAuthentication = false;
  }

  private async stopPendingConnection(
    handshake: PendingHandshake | undefined,
    result: Extract<SecureRoomConnectResult, { status: "failed" }>,
    preserveRecovery: boolean,
  ): Promise<void> {
    const config = this.config;
    const ownedHandshake = handshake ?? this.pendingHandshake;
    const engine = this.engine;
    const lease = this.lease;
    this.pendingHandshake = null;
    this.generation += 1;
    this.stopped = true;
    this.terminal = false;
    this.authenticated = false;
    this.authenticatedMode = null;
    this.discardEngineOnAuthenticationFailure = false;
    this.authenticationMayHaveCommitted = false;
    this.nextAuthenticationMode = null;
    this.unresolvedAuthentication = preserveRecovery;
    this.config = null;
    this.closeSocket("secure room connection stopped");
    this.engine = null;
    this.lease = null;
    this.clearTimers();
    let finalResult = result;
    let finalPreserveRecovery = preserveRecovery;
    try {
      // A provisional identity is proven unsent. Remove it before releasing
      // the room lock so retries cannot orphan or accumulate stale records.
      if (engine?.isProvisional && !preserveRecovery) {
        try {
          await engine.retire();
        } catch (error) {
          if (!(error instanceof SecureRoomEngineError && error.code === "retired")) {
            finalPreserveRecovery = true;
            finalResult = { status: "failed", reason: "recovery-required" };
          }
        }
      }
      if (finalPreserveRecovery) this.rememberRecoveryContext(config);
      else this.clearRecoveryForCurrentConfig(config);
      this.unresolvedAuthentication = finalPreserveRecovery;
    } finally {
      // Settle after durable cleanup but before best-effort object teardown;
      // an implementation-specific dispose/release exception must not leave
      // the UI awaiting this handshake forever.
      ownedHandshake?.settle(finalResult);
      try { engine?.dispose(); } catch {}
      try { lease?.release(); } catch {}
      this.resetUiSession();
      if (finalPreserveRecovery && config) useGameStore.getState().setScreen(config.initialMode);
    }
  }

  private async retryPendingAuthentication(
    handshake: PendingHandshake | undefined,
    nextMode: "join" | "resume" | null = null,
  ): Promise<boolean> {
    if (this.stopped || this.terminal || !this.config || !this.lease?.isActive()) return false;
    if (this.reconnectAttempts >= 3) {
      await this.stopPendingConnection(
        handshake,
        { status: "failed", reason: "recovery-required" },
        true,
      );
      return true;
    }
    this.nextAuthenticationMode = nextMode;
    this.authenticated = false;
    this.authenticatedMode = null;
    this.closeSocket("retrying secure authentication");
    this.scheduleReconnect();
    return true;
  }

  private resetUiSession(): void {
    this.uiInitialized = false;
    this.reconnectAttempts = 0;
    const store = useGameStore.getState();
    store.setReconnecting(false);
    store.setReconnectAttempts(0);
    resetSecureRoomUiV4();
  }

  private async protocolClose(_reason: string, userMessage = "The secure connection failed closed."): Promise<void> {
    if (this.unresolvedAuthentication || this.authenticationMayHaveCommitted ||
        !!this.engine?.isAuthenticationAmbiguous) {
      await this.stopPendingConnection(
        this.pendingHandshake ?? undefined,
        { status: "failed", reason: "recovery-required" },
        true,
      );
      useGameStore.getState().showError(userMessage);
      return;
    }
    if (this.pendingHandshake || (!this.authenticated && this.engine?.isProvisional)) {
      await this.stopPendingConnection(
        this.pendingHandshake ?? undefined,
        { status: "failed", reason: "authentication-failed" },
        false,
      );
      useGameStore.getState().showError(userMessage);
      return;
    }
    this.pendingHandshake = null;
    this.terminal = true;
    this.stopped = true;
    this.authenticated = false;
    this.discardEngineOnAuthenticationFailure = false;
    this.authenticationMayHaveCommitted = false;
    this.nextAuthenticationMode = null;
    this.unresolvedAuthentication = false;
    this.clearRecoveryForCurrentConfig();
    this.config = null;
    this.closeSocket("secure protocol error");
    this.engine?.dispose();
    this.engine = null;
    this.releaseLease();
    this.clearTimers();
    const store = useGameStore.getState();
    store.showError(userMessage);
    store.cleanup();
    useGameStore.getState().setScreen("home");
    this.resetUiSession();
  }

  private async finishTerminal(message: string, erase = true): Promise<void> {
    const engine = this.engine;
    const config = this.config;
    const handshake = this.pendingHandshake;
    // Gate every producer before durable erasure yields. Otherwise a terminal
    // relay error can return to the queue while retire() is still pending and
    // later frames/UI work can race deletion of the same cryptographic state.
    this.pendingHandshake = null;
    this.terminal = true;
    this.stopped = true;
    this.authenticated = false;
    this.discardEngineOnAuthenticationFailure = false;
    this.authenticationMayHaveCommitted = false;
    this.nextAuthenticationMode = null;
    this.unresolvedAuthentication = false;
    this.config = null;
    this.closeSocket("secure room ended");
    this.clearTimers();
    try {
      if (erase && engine) {
        try { await engine.retire(); } catch (error) {
          if (!(error instanceof SecureRoomEngineError) || error.code !== "retired") throw error;
        }
      }
    } catch {
      // Durable erasure is part of the terminal transition. If it is
      // unavailable, keep the exact recovery pointer and identity so a later
      // retry can finish cleanup instead of silently orphaning ciphertext.
      this.rememberRecoveryContext(config);
      await this.stopPendingConnection(
        handshake ?? undefined,
        { status: "failed", reason: "recovery-required" },
        true,
      );
      if (config) useGameStore.getState().setScreen(config.initialMode);
      useGameStore.getState().showError("Secure room cleanup could not finish. Retry with the same password.");
      return;
    }
    this.clearRecoveryForCurrentConfig(config);
    handshake?.settle({ status: "failed", reason: "authentication-failed" });
    try { engine?.dispose(); } catch {}
    if (this.engine === engine) this.engine = null;
    this.releaseLease();
    this.resetUiSession();
    const left = message.startsWith("You left");
    const store = useGameStore.getState();
    store.cleanup();
    useGameStore.getState().setScreen(left ? "home" : "knocked");
    useGameStore.getState().addSystemMessage(message);
  }

  private async handleServerError(
    frame: Extract<SecureServerFrameV4, { type: "error" }>,
    handshake?: PendingHandshake,
  ): Promise<void> {
    if (!this.authenticated) {
      if (frame.code === "room-retired" && this.config?.recoveryOnly &&
          this.config.roomInstance && !this.engine) {
        await this.resolveUnavailableRecoveryRoom(this.config.roomInstance, handshake);
        return;
      }
      const engine = this.engine;
      const retainedJoin = engine ? this.retainedJoinAuthEntry() : null;
      // A crash can make MLS locally active while the relay still has the
      // exact idempotent Join pending. Try device resume first; an authoritative
      // lifecycle miss switches one attempt back to the retained Join frame.
      if (engine?.isAuthenticationAmbiguous && retainedJoin && engine.isActive() &&
          this.authenticatedMode === "resume" &&
          (frame.code === "invalid-lifecycle" || frame.code === "unknown-device")) {
        if (await this.retryPendingAuthentication(handshake, "join")) return;
      }
      // Conversely, the relay may have activated that Join just before its
      // response was lost. A replayed Join then collides, so prove the durable
      // device identity with resume instead of creating another admission.
      if (engine?.isAuthenticationAmbiguous && retainedJoin && engine.isActive() &&
          this.authenticatedMode === "join" &&
          (frame.code === "duplicate-id" || frame.code === "device-exists")) {
        if (await this.retryPendingAuthentication(handshake, "resume")) return;
      }
      if (frame.code === "persistence-failed" || frame.code === "internal-error" ||
          frame.code === "room-state-invalid") {
        if (await this.retryPendingAuthentication(handshake)) return;
      }

      if (frame.code === "room-retired" || frame.code === "fresh-admission-required" ||
          (frame.code === "unknown-device" && this.authenticatedMode === "resume")) {
        let erased = true;
        if (engine) {
          try {
            await engine.retire();
          } catch (error) {
            if (!(error instanceof SecureRoomEngineError && error.code === "retired")) erased = false;
          }
        }
        this.authenticationMayHaveCommitted = false;
        this.discardEngineOnAuthenticationFailure = false;
        await this.stopPendingConnection(
          handshake,
          { status: "failed", reason: erased ? "authentication-failed" : "recovery-required" },
          !erased,
        );
        if (!erased) {
          useGameStore.getState().showError(
            "Secure room cleanup could not finish. Retry with the same password.",
          );
        }
        return;
      }

      // Only state created by this exact attempt may be deleted on a
      // pre-commit rejection. Restored ambiguous state may represent an older
      // accepted attempt even when this newest challenge expires or is rated.
      let retiredFreshState = false;
      if (engine && this.discardEngineOnAuthenticationFailure) {
        try {
          await engine.retire();
          retiredFreshState = true;
        } catch {
          // Credential-scoped records prevent this failed cleanup from
          // shadowing a later correct credential; never surface secret details.
        }
      }
      const preserveRecovery = !retiredFreshState && !!engine?.isAuthenticationAmbiguous;
      this.discardEngineOnAuthenticationFailure = false;
      this.authenticationMayHaveCommitted = false;
      const failure = frame.code === "rate-limited"
        ? {
            reason: "rate-limited" as const,
            message: "Too many secure-room attempts. Wait a minute, then try again.",
          }
        : frame.code === "authentication-expired" || frame.code === "persistence-failed" ||
            frame.code === "internal-error" || frame.code === "room-state-invalid"
          ? {
              reason: "unavailable" as const,
              message: frame.code === "authentication-expired"
                ? "The secure check expired. Try again."
                : "The secure fort is temporarily unavailable. Try again.",
            }
          : {
              reason: "authentication-failed" as const,
              message: "Could not connect. Check the fort flag and password.",
            };
      await this.stopPendingConnection(
        handshake,
        { status: "failed", reason: preserveRecovery ? "recovery-required" : failure.reason },
        preserveRecovery,
      );
      useGameStore.getState().showError(failure.message);
      return;
    }
    if (frame.code === "room-retired" || frame.code === "fresh-admission-required") {
      await this.finishTerminal("This secure fort is no longer available.");
      return;
    }
    if (frame.code === "delivery-pending" || frame.code === "removal-pending" ||
        frame.code === "admission-pending") {
      useGameStore.getState().showError(frame.code === "admission-pending"
        ? "Finishing secure device admission."
        : frame.code === "removal-pending"
          ? "Securing the fort after a member disconnected."
          : "Secure delivery is still catching up.");
      this.pumpGrantQueue();
      return;
    }
    await this.protocolClose("relay rejected secure protocol state");
  }

  private async failClosed(error: unknown): Promise<void> {
    if (this.stopped || this.terminal) return;
    if (this.pendingHandshake || this.unresolvedAuthentication || this.authenticationMayHaveCommitted ||
        !!this.engine?.isAuthenticationAmbiguous || (error instanceof SecureRoomEngineError &&
        (error.code === "transition-invalid" || error.code === "unauthorized" || error.code === "state-invalid" ||
          error.code === "persistence-failed" || error.code === "revision-conflict" || error.code === "lock-required"))) {
      await this.protocolClose("secure engine rejected state");
      return;
    }
    this.showOperationError(error);
  }

  private showOperationError(error: unknown): void {
    const message = error instanceof SecureRoomEngineError && error.code === "pending-saturated"
      ? "Secure delivery is busy. Wait for pending messages to finish."
      : "That secure action could not be completed.";
    useGameStore.getState().showError(message);
  }

  private requireEngine(): SecureRoomEngine {
    if (!this.engine) throw new Error("secure room engine is unavailable");
    return this.engine;
  }
}
