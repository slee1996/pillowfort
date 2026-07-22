import {
  MAX_SECURE_APPLICATION_EVENT_BYTES,
  MAX_SECURE_MEMBERS,
  canonicalJsonV4,
  isSecureApplicationEventV4,
  isSecureRoomStateSnapshotV4,
  parseSecureApplicationEventV4,
  signSecureApplicationEventV4,
  type SecureApplicationContentV4,
  type SecureApplicationEventV4,
  type SecureRoomStateSnapshotV4,
} from "../../../src/applicationEventsV4";
import { encodeSecureAdmissionBundleV4 } from "../../../src/admissionBundleV4";
import {
  createEmptySecureRoomStateV4,
  createSecureRoomStateV4,
  computeRpsCommitmentV4,
  computeSaboteurCommitmentV4,
  reconcileSecureRoomMembershipV4,
  reduceSecureRoomEventV4,
  type SecureMemberCredentialV4,
  type SecureReducerEffectV4,
} from "../../../src/secureGameReducer";
import {
  SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES,
} from "../../../src/applicationEventsV4";
import {
  parseRoomInvitationMemberBindingV4,
  secureKeyPackageDigestV4,
  type RoomInvitationMemberBindingV4,
} from "../../../src/roomInvitationMemberBindingV4";
import {
  signSecureDeviceResumeProofV4,
  type SecureDeviceResumeContextV4,
} from "../../../src/deviceAuthV4";
import {
  MAX_SECURE_ZOMBIE_REMOVALS_V4,
  type SecureLogicalOrderGrantV4,
} from "../../../src/secureRelayV4";
import {
  MAX_MLS_RELAY_PAYLOAD_BYTES,
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  canonicalBase64UrlByteLength,
} from "../../../src/protocolV4";
import {
  CryptoStateStore,
  type OpaqueCryptoStateSnapshot,
} from "./cryptoStateStore";
import {
  MlsCryptoSession,
  type MlsRosterEntry,
  type MlsTransition,
  type MlsTransitionKind,
} from "./mlsCrypto";
import type { RoomCryptoLockLease } from "./roomCryptoLock";
import { verifyRoomInvitationMemberBindingWithSecretV4 } from "./secureInvitationAuth";
import {
  MAX_SECURE_ROOM_PENDING_OUTBOX_BYTES,
  MAX_SECURE_ROOM_PENDING_OUTBOX_ENTRIES,
  MAX_SECURE_ROOM_PENDING_RELAY_CONTROLS,
  MAX_SECURE_ROOM_PROCESSED_DELIVERIES,
  cloneSecureRoomProcessedDeliveriesV1,
  cloneSecureRoomPendingRelayControlsV1,
  cloneSecureRoomPendingOutboxV1,
  cloneSecureRoomDurableStateV1,
  decodeCanonicalBase64UrlV4,
  protectSecureRoomStateV1,
  randomSecureRoomIdV4,
  secureRoomCredentialStoreKey,
  secureRoomOpaqueStoreKey,
  unprotectSecureRoomStateV1,
  type SecureRoomDurableStateV1,
  type SecureRoomApplicationRelayContextV1,
  type SecureRoomPendingCommitSecretV4,
  type SecureRoomPendingOutboxEntryV1,
  type SecureRoomPendingRelayControlV1,
} from "./secureRoomState";

const UTF8 = new TextEncoder();
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type SecureRoomEngineErrorCode =
  | "invalid-input"
  | "lock-required"
  | "state-not-found"
  | "state-exists"
  | "state-invalid"
  | "transition-invalid"
  | "revision-conflict"
  | "unauthorized"
  | "pending-saturated"
  | "retired"
  | "persistence-failed";

export class SecureRoomEngineError extends Error {
  readonly code: SecureRoomEngineErrorCode;
  readonly cause?: unknown;

  constructor(code: SecureRoomEngineErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SecureRoomEngineError";
    this.code = code;
    this.cause = cause;
  }
}

interface CommonEngineOptions {
  roomInstance: string;
  roomSecret: string;
  lease: RoomCryptoLockLease;
  store?: CryptoStateStore;
}

export interface CreateSecureRoomFounderOptions extends CommonEngineOptions {
  displayName: string;
  deviceId?: string;
}

export interface CreateSecureRoomJoinerOptions extends CommonEngineOptions {
  deviceId?: string;
}

export type RestoreSecureRoomEngineOptions = CommonEngineOptions;

export interface SecureRoomRosterEntry {
  leafIndex: number;
  deviceId: string;
  signaturePublicKey: string;
}

export interface SecureRoomKeyPackageResult {
  kind: "key-package";
  epoch: bigint;
  /** Use as the setup/join request id; ack after authenticated acceptance. */
  messageId: string;
  keyPackage: Uint8Array;
}

export interface SecureRoomAddResult {
  kind: "add";
  epoch: bigint;
  admissionId: string;
  messageId: string;
  /** Stable replay id for the Welcome stage after the commit is accepted. */
  welcomeMessageId: string;
  addedDeviceId: string;
  outbound: Uint8Array;
  welcome: Uint8Array;
  ratchetTree: Uint8Array;
}

export interface SecureRoomJoinResult {
  kind: "join";
  epoch: bigint;
  relayMessageId: string | null;
  roster: SecureRoomRosterEntry[];
}

interface ExpectedJoinFounderV4 {
  deviceId: string;
  signaturePublicKey: string;
}

export interface SecureRoomAlreadyProcessedResult {
  kind: "already-processed";
  relayMessageId: string;
}

export type SecureRoomInboundRelayContext =
  | {
      kind: "commit";
      /** Exact pending admission for an Add commit. */
      admissionId?: string;
      /** Exact relay removal barrier; both fields are present together. */
      retirementDeviceId?: string;
      retirementAdmissionCommitMessageId?: string;
    }
  | { kind: "application" }
  | { kind: "bootstrap"; admissionId: string; welcomeMessageId: string }
  | { kind: "join-proof"; admissionId: string; welcomeMessageId: string }
  | { kind: "host-transfer-accept"; authorizationId: string };

export interface SecureRoomRelayDeliveryContext {
  messageId: string;
  fromDeviceId: string;
  /** Application/bootstrap/join-proof order; commits are explicitly unordered. */
  logicalOrder: number | null;
  /** Exact authenticated outer relay variant and its capability bindings. */
  relayContext: SecureRoomInboundRelayContext;
}

export interface SecureRoomCommitResult {
  kind: "remove" | "self-update";
  epoch: bigint;
  messageId: string;
  outbound: Uint8Array;
  removedDeviceId?: string;
  relayRequestId?: string;
  effects: SecureReducerEffectV4[];
}

export interface SecureRoomRetirementBarrierV4 {
  deviceId: string;
  /** Legacy wire name: the immutable invitation-signed membership admission id. */
  admissionCommitMessageId: string;
}

export interface SecureRoomOutboundApplicationResult {
  kind: "outbound-application";
  epoch: bigint;
  messageId: string;
  event: SecureApplicationEventV4;
  outbound: Uint8Array;
  state: SecureRoomStateSnapshotV4;
  effects: SecureReducerEffectV4[];
  /** Relay capability for an offered or accepted atomic host transfer. */
  hostTransferAuthorizationId?: string;
}

export interface SecureRoomPendingUiResult {
  state: SecureRoomStateSnapshotV4;
  effects: SecureReducerEffectV4[];
}

export type SecureRoomReceiveResult =
  | {
    kind: "inbound-application";
    epoch: bigint;
    relayMessageId: string | null;
    senderDeviceId: string;
    event: SecureApplicationEventV4;
    state: SecureRoomStateSnapshotV4;
    effects: SecureReducerEffectV4[];
  }
  | {
    kind: "inbound-commit";
    epoch: bigint;
    relayMessageId: string | null;
    senderDeviceId: string;
    state: SecureRoomStateSnapshotV4;
    effects: SecureReducerEffectV4[];
    retired: boolean;
  }
  | SecureRoomAlreadyProcessedResult;

export interface SecureRoomInboundApplicationInspection {
  kind: "inbound-application";
  epoch: bigint;
  senderDeviceId: string;
  eventId: string;
  logicalOrder: number;
}

export interface SecureRoomInboundCommitInspection {
  kind: "inbound-commit";
  epoch: bigint;
  senderDeviceId: string;
}

export type SecureRoomRelayControlCompletionV1 =
  | { kind: "member-lifecycle"; deviceId: string; status: "retired" }
  | { kind: "host-changed"; deviceId: string }
  | { kind: "host-transfer-expired"; authorizationId: string }
  | { kind: "room-retired" };

interface NormalizedRosterEntry extends SecureRoomRosterEntry {
  identity: Uint8Array;
  signatureKey: Uint8Array;
}

interface MutationPlan<T> {
  durable: SecureRoomDurableStateV1;
  result: () => T;
  retireAfterCommit?: boolean;
}

interface RelayDeliveryDigest {
  messageId: string;
  digest: string;
  alreadyProcessed: boolean;
}

function engineError(
  error: unknown,
  fallbackCode: SecureRoomEngineErrorCode,
  fallbackMessage: string,
): SecureRoomEngineError {
  if (error instanceof SecureRoomEngineError) return error;
  return new SecureRoomEngineError(fallbackCode, fallbackMessage, error);
}

function copyBytes(value: Uint8Array | undefined, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new SecureRoomEngineError("transition-invalid", `MLS transition omitted ${label}`);
  }
  return value.slice();
}

function cloneApplicationState(state: SecureRoomStateSnapshotV4): SecureRoomStateSnapshotV4 {
  return JSON.parse(canonicalJsonV4(state)) as SecureRoomStateSnapshotV4;
}

function bindMembershipAdmission(
  stateValue: SecureRoomStateSnapshotV4,
  deviceId: string,
  admissionId: string,
): SecureRoomStateSnapshotV4 {
  if (canonicalBase64UrlByteLength(deviceId) !== SECURE_DEVICE_ID_BYTES ||
      canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES) {
    throw new SecureRoomEngineError("invalid-input", "invalid MLS membership-admission binding");
  }
  const state = cloneApplicationState(stateValue);
  const existing = state.membershipAdmissionBindings.find((binding) => binding.deviceId === deviceId);
  if (existing) {
    if (existing.admissionId !== null && existing.admissionId !== admissionId) {
      throw new SecureRoomEngineError("unauthorized", "MLS member was rebound to another invitation admission");
    }
    existing.admissionId = admissionId;
  } else {
    if (state.membershipAdmissionBindings.length >= MAX_SECURE_MEMBERS) {
      throw new SecureRoomEngineError("pending-saturated", "MLS membership-admission ledger is full");
    }
    state.membershipAdmissionBindings.push({ deviceId, admissionId });
  }
  if (state.membershipAdmissionBindings.some((binding) =>
    binding.deviceId !== deviceId && binding.admissionId === admissionId)) {
    throw new SecureRoomEngineError("unauthorized", "invitation admission was rebound to another MLS member");
  }
  state.membershipAdmissionBindings.sort((left, right) =>
    left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0);
  if (!isSecureRoomStateSnapshotV4(state)) {
    throw new SecureRoomEngineError("state-invalid", "MLS membership-admission ledger invalidated application state");
  }
  return state;
}

/** Transcript content is live-only and must never enter room-secret-wrapped state. */
function cloneDurableApplicationState(state: SecureRoomStateSnapshotV4): SecureRoomStateSnapshotV4 {
  const clone = cloneApplicationState(state);
  clone.messages = [];
  clone.drawings = [];
  return clone;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function isSecureInboundRelayContext(value: unknown): value is SecureRoomInboundRelayContext {
  if (!isPlainDataRecord(value) || typeof value.kind !== "string") return false;
  const keys = Reflect.ownKeys(value);
  if (value.kind === "application") {
    return keys.length === 1 && keys[0] === "kind";
  }
  if (value.kind === "commit") {
    if (keys.length === 1 && keys[0] === "kind") return true;
    if (keys.length === 2 && Object.prototype.hasOwnProperty.call(value, "admissionId")) {
      return canonicalBase64UrlByteLength(value.admissionId) === SECURE_MESSAGE_ID_BYTES;
    }
    return keys.length === 3 &&
      ["kind", "retirementDeviceId", "retirementAdmissionCommitMessageId"].every((key) =>
        Object.prototype.hasOwnProperty.call(value, key)) &&
      canonicalBase64UrlByteLength(value.retirementDeviceId) === SECURE_DEVICE_ID_BYTES &&
      canonicalBase64UrlByteLength(value.retirementAdmissionCommitMessageId) === SECURE_MESSAGE_ID_BYTES;
  }
  if (value.kind === "bootstrap" || value.kind === "join-proof") {
    return keys.length === 3 && ["kind", "admissionId", "welcomeMessageId"].every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)) &&
      canonicalBase64UrlByteLength(value.admissionId) === SECURE_MESSAGE_ID_BYTES &&
      canonicalBase64UrlByteLength(value.welcomeMessageId) === SECURE_MESSAGE_ID_BYTES &&
      value.admissionId !== value.welcomeMessageId;
  }
  return value.kind === "host-transfer-accept" && keys.length === 2 &&
    Object.prototype.hasOwnProperty.call(value, "authorizationId") &&
    canonicalBase64UrlByteLength(value.authorizationId) === SECURE_MESSAGE_ID_BYTES;
}

function assertTransitionKind(transition: MlsTransition, expected: MlsTransitionKind): void {
  if (transition.kind !== expected) {
    throw new SecureRoomEngineError(
      "transition-invalid",
      `expected MLS ${expected} transition but received ${transition.kind}`,
    );
  }
}

function validateRoomAndDevice(roomInstance: string, deviceId?: string): void {
  if (canonicalBase64UrlByteLength(roomInstance) !== SECURE_ROOM_ID_BYTES) {
    throw new SecureRoomEngineError("invalid-input", "invalid protocol-v4 room instance");
  }
  if (deviceId !== undefined && canonicalBase64UrlByteLength(deviceId) !== SECURE_DEVICE_ID_BYTES) {
    throw new SecureRoomEngineError("invalid-input", "invalid protocol-v4 device id");
  }
}

function messageEventFromPlaintext(plaintext: Uint8Array, roomInstance: string): SecureApplicationEventV4 {
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_SECURE_APPLICATION_EVENT_BYTES) {
    throw new SecureRoomEngineError("transition-invalid", "decrypted application event has an invalid size");
  }
  let text: string;
  try {
    text = FATAL_UTF8.decode(plaintext);
  } catch (error) {
    throw new SecureRoomEngineError("transition-invalid", "decrypted application event is not valid UTF-8", error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SecureRoomEngineError("transition-invalid", "decrypted application event is not JSON", error);
  }
  if (canonicalJsonV4(value) !== text) {
    throw new SecureRoomEngineError("transition-invalid", "decrypted application event is not canonical JSON");
  }
  const event = parseSecureApplicationEventV4(value, { expectedRoomInstance: roomInstance });
  if (!event) throw new SecureRoomEngineError("transition-invalid", "decrypted application event schema is invalid");
  return event;
}

export class SecureRoomEngine {
  private session: MlsCryptoSession | null;
  private durable: SecureRoomDurableStateV1;
  private revision: number;
  private readonly roomSecret: string;
  private readonly store: CryptoStateStore;
  private readonly lease: RoomCryptoLockLease;
  private readonly lockKey: string;
  private readonly storeKey: string;
  private provisional: boolean;
  private authenticationAmbiguous: boolean;
  private unavailable = false;
  private retired = false;
  /** Re-established from the server-forwarded invitation binding on every pending-join connection. */
  private expectedJoinFounder: ExpectedJoinFounderV4 | null = null;
  /**
   * Zombie-expiration hints are transient, but each device/id pair must match
   * the durable invitation-signed membership admission ledger. The server
   * replays the exact pair before its contextual Remove; insertion order is
   * the protocol's retirement order.
   */
  private readonly retirementBarriers = new Map<string, string>();

  private constructor(options: {
    session: MlsCryptoSession;
    durable: SecureRoomDurableStateV1;
    revision: number;
    roomSecret: string;
    store: CryptoStateStore;
    lease: RoomCryptoLockLease;
    lockKey: string;
    storeKey: string;
    provisional: boolean;
    authenticationAmbiguous: boolean;
  }) {
    this.session = options.session;
    this.durable = cloneSecureRoomDurableStateV1(options.durable);
    this.revision = options.revision;
    this.roomSecret = options.roomSecret;
    this.store = options.store;
    this.lease = options.lease;
    this.lockKey = options.lockKey;
    this.storeKey = options.storeKey;
    this.provisional = options.provisional;
    this.authenticationAmbiguous = options.authenticationAmbiguous;
  }

  static async createFounder(options: CreateSecureRoomFounderOptions): Promise<SecureRoomEngine> {
    return this.createNew(options, true);
  }

  static async createJoiner(options: CreateSecureRoomJoinerOptions): Promise<SecureRoomEngine> {
    return this.createNew(options, false);
  }

  private static async createNew(
    options: CreateSecureRoomFounderOptions | CreateSecureRoomJoinerOptions,
    founder: boolean,
  ): Promise<SecureRoomEngine> {
    validateRoomAndDevice(options?.roomInstance, options?.deviceId);
    const store = options.store ?? new CryptoStateStore();
    const lockKey = await secureRoomOpaqueStoreKey(options.roomInstance);
    const storeKey = await secureRoomCredentialStoreKey(options.roomInstance, options.roomSecret);
    this.assertLease(options.lease, lockKey);
    const deviceId = options.deviceId ?? randomSecureRoomIdV4(16);
    const roomBinding = decodeCanonicalBase64UrlV4(options.roomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES)!;
    const identity = decodeCanonicalBase64UrlV4(deviceId, SECURE_DEVICE_ID_BYTES, SECURE_DEVICE_ID_BYTES)!;
    let session: MlsCryptoSession | null = null;
    try {
      const created = await MlsCryptoSession.create({
        roomBinding,
        identity,
        roomSecret: options.roomSecret,
        founder,
      });
      session = created.session;
      let applicationState: SecureRoomStateSnapshotV4;
      if (founder) {
        const displayName = (options as CreateSecureRoomFounderOptions).displayName;
        const own = this.normalizeRoster(session.roster()).find((entry) => entry.deviceId === deviceId);
        if (!own) throw new SecureRoomEngineError("state-invalid", "founder credential is absent from the MLS roster");
        applicationState = createSecureRoomStateV4(
          options.roomInstance,
          [{ deviceId, displayName, signaturePublicKey: own.signaturePublicKey }],
          deviceId,
        );
      } else {
        applicationState = createEmptySecureRoomStateV4(options.roomInstance);
      }
      const durable: SecureRoomDurableStateV1 = {
        roomInstance: options.roomInstance,
        deviceId,
        mlsSnapshot: created.snapshot.slice(),
        applicationState,
        nextDeviceSequence: 1,
        lastEpoch: "0",
        pendingOutbox: [],
        pendingRelayControls: [],
        processedDeliveries: [],
        pendingCommitSecrets: {},
        pendingApplicationRollback: null,
        pendingCommitRollback: null,
      };
      const wrapped = await protectSecureRoomStateV1(durable, options.roomSecret);
      this.assertLease(options.lease, lockKey);
      const committed = await store.createProvisionalOpaqueState(storeKey, lockKey, wrapped);
      if (!committed.committed) {
        throw new SecureRoomEngineError(
          committed.reason === "provisional-saturated" ? "persistence-failed" : "state-exists",
          committed.reason === "provisional-saturated"
            ? "too many unresolved provisional secure room identities"
            : "secure room state already exists for this room",
        );
      }
      this.assertLease(options.lease, lockKey);
      const engine = new SecureRoomEngine({
        session,
        durable,
        revision: committed.revision,
        roomSecret: options.roomSecret,
        store,
        lease: options.lease,
        lockKey,
        storeKey,
        provisional: true,
        authenticationAmbiguous: false,
      });
      session = null;
      return engine;
    } catch (error) {
      session?.dispose();
      throw engineError(error, "persistence-failed", "could not create durable secure room state");
    } finally {
      roomBinding.fill(0);
      identity.fill(0);
    }
  }

  static async restore(options: RestoreSecureRoomEngineOptions): Promise<SecureRoomEngine> {
    validateRoomAndDevice(options?.roomInstance);
    const store = options.store ?? new CryptoStateStore();
    const lockKey = await secureRoomOpaqueStoreKey(options.roomInstance);
    const storeKey = await secureRoomCredentialStoreKey(options.roomInstance, options.roomSecret);
    this.assertLease(options.lease, lockKey);
    let record = await store.loadOpaqueState(storeKey);
    let legacyStoreKey: string | null = null;
    if (!record) {
      const legacy = await store.loadOpaqueState(lockKey);
      if (legacy) {
        record = legacy;
        legacyStoreKey = lockKey;
      }
    }
    if (!record) throw new SecureRoomEngineError("state-not-found", "no durable secure room state exists");
    let session: MlsCryptoSession | null = null;
    let legacyAuthenticated = false;
    try {
      const durable = await unprotectSecureRoomStateV1(record.state, options.roomInstance, options.roomSecret);
      const roomBinding = decodeCanonicalBase64UrlV4(options.roomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES)!;
      try {
        session = await MlsCryptoSession.restore({ roomBinding, roomSecret: options.roomSecret, snapshot: durable.mlsSnapshot });
      } finally {
        roomBinding.fill(0);
      }
      const roster = this.normalizeRoster(session.roster());
      if (session.isActive() && !roster.some((entry) => entry.deviceId === durable.deviceId)) {
        throw new SecureRoomEngineError("state-invalid", "durable device identity is absent from its MLS roster");
      }
      const rosterIds = new Set(roster.map((entry) => entry.deviceId));
      if (durable.applicationState.members.some((member) => !rosterIds.has(member.deviceId))) {
        throw new SecureRoomEngineError("state-invalid", "application membership is not a subset of the MLS roster");
      }
      legacyAuthenticated = legacyStoreKey !== null;
      this.assertLease(options.lease, lockKey);
      let revision = record.revision;
      if (legacyStoreKey) {
        const moved = await store.compareAndMoveOpaqueState(legacyStoreKey, record.revision, storeKey, lockKey);
        if (!moved.moved) {
          throw new SecureRoomEngineError(
            moved.reason === "destination-exists" ? "state-exists" : "revision-conflict",
            "legacy secure room state migration conflicted",
          );
        }
        revision = moved.revision;
        this.assertLease(options.lease, lockKey);
      }
      const engine = new SecureRoomEngine({
        session,
        durable,
        revision,
        roomSecret: options.roomSecret,
        store,
        lease: options.lease,
        lockKey,
        storeKey,
        provisional: record.lifecycle === "provisional",
        authenticationAmbiguous: record.lifecycle === "authentication-ambiguous",
      });
      session = null;
      return engine;
    } catch (error) {
      session?.dispose();
      if (legacyStoreKey && !legacyAuthenticated) {
        // A legacy room-only key cannot identify which credential produced its
        // ciphertext. Preserve it for a future matching credential, but make a
        // non-matching attempt behave like an empty credential-scoped slot so
        // it cannot shadow a correct retry after this upgrade.
        throw new SecureRoomEngineError(
          "state-not-found",
          "no durable secure room state exists for this credential",
        );
      }
      throw engineError(error, "state-invalid", "durable secure room state could not be restored");
    }
  }

  private static assertLease(lease: RoomCryptoLockLease | undefined, lockKey: string): void {
    if (!lease || lease.roomInstance !== lockKey || !lease.isActive() || lease.signal.aborted) {
      throw new SecureRoomEngineError("lock-required", "an active matching secure-room Web Lock lease is required");
    }
  }

  get roomInstance(): string {
    return this.durable.roomInstance;
  }

  get deviceId(): string {
    return this.durable.deviceId;
  }

  get state(): SecureRoomStateSnapshotV4 {
    this.assertUsable();
    return cloneApplicationState(this.durable.applicationState);
  }

  get durableRevision(): number {
    this.assertUsable();
    return this.revision;
  }

  get epoch(): bigint {
    this.assertUsable();
    return BigInt(this.durable.lastEpoch);
  }

  get isProvisional(): boolean {
    return this.provisional;
  }

  get isAuthenticationAmbiguous(): boolean {
    return this.authenticationAmbiguous;
  }

  /** Makes crash recovery conservative before any authentication frame is sent. */
  async markAuthenticationAttempted(): Promise<void> {
    this.assertUsable();
    this.assertLease();
    try {
      const result = await this.store.markOpaqueStateAuthenticationAmbiguous(this.storeKey, this.revision);
      if (!result.committed) {
        await this.recoverFromAuthoritativeState();
        throw new SecureRoomEngineError(
          "revision-conflict",
          "secure room authentication-attempt marker lost its revision race",
        );
      }
      this.assertLease();
      this.revision = result.revision;
      if (this.provisional) {
        this.provisional = false;
        this.authenticationAmbiguous = true;
      }
    } catch (error) {
      if (!(error instanceof SecureRoomEngineError && error.code === "revision-conflict") && !this.unavailable) {
        await this.recoverFromAuthoritativeState();
      }
      throw engineError(error, "persistence-failed", "secure room authentication-attempt marker could not be persisted");
    }
  }

  /** Protects a relay-accepted identity from bounded provisional-state GC. */
  async markAuthenticated(): Promise<void> {
    this.assertUsable();
    this.assertLease();
    try {
      const result = await this.store.markOpaqueStateEstablished(this.storeKey, this.revision);
      if (!result.committed) {
        await this.recoverFromAuthoritativeState();
        throw new SecureRoomEngineError(
          "revision-conflict",
          "secure room authentication marker lost its revision race",
        );
      }
      this.assertLease();
      this.revision = result.revision;
      this.provisional = false;
      this.authenticationAmbiguous = false;
    } catch (error) {
      if (!(error instanceof SecureRoomEngineError && error.code === "revision-conflict") && !this.unavailable) {
        await this.recoverFromAuthoritativeState();
      }
      throw engineError(error, "persistence-failed", "secure room authentication marker could not be persisted");
    }
  }

  get pendingOutboundMessageIds(): readonly string[] {
    this.assertUsable();
    return this.pendingOutboxIds(this.durable.pendingOutbox);
  }

  get pendingOutbox(): readonly SecureRoomPendingOutboxEntryV1[] {
    this.assertUsable();
    return cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox);
  }

  get pendingRelayControls(): readonly SecureRoomPendingRelayControlV1[] {
    this.assertUsable();
    return cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
  }

  get pendingAdmissionBarrier(): { admissionId: string; deviceId: string } | null {
    this.assertUsable();
    const barrier = this.durable.pendingRelayControls.find((control) => control.kind === "admission-barrier");
    return barrier?.kind === "admission-barrier"
      ? { admissionId: barrier.admissionId, deviceId: barrier.deviceId }
      : null;
  }

  get pendingSignedRemovalDeviceId(): string | null {
    this.assertUsable();
    return this.durable.applicationState.pendingRemovalDeviceIds[0] ?? null;
  }

  /**
   * Identifies the one durable application ciphertext whose tentative state
   * introduced the current signed-removal barrier. The controller must relay
   * this exact message before it can block all later application traffic at
   * that barrier. The persisted rollback boundary makes the exception causal:
   * a pre-existing barrier, an unrelated outbox entry, or an acknowledged
   * application can never match it.
   */
  get pendingRemovalAuthorizationMessageId(): string | null {
    this.assertUsable();
    const rollback = this.durable.pendingApplicationRollback;
    if (!rollback || rollback.applicationState.pendingRemovalDeviceIds.length !== 0 ||
        this.durable.applicationState.pendingRemovalDeviceIds.length !== 1) return null;
    const removalDeviceId = this.durable.applicationState.pendingRemovalDeviceIds[0];
    if (!this.durable.applicationState.members.some((member) => member.deviceId === removalDeviceId)) return null;
    const entry = this.durable.pendingOutbox.find((candidate) => candidate.messageId === rollback.messageId);
    return entry?.kind === "application" && entry.relayContext.kind === "application"
      ? entry.messageId
      : null;
  }

  /**
   * Reconstructs the exact tentative UI result after a controller restart.
   * The signed event and non-key rollback state are retained only while the
   * corresponding ciphertext awaits a relay decision; ACK removes both.
   */
  async pendingOutboundUiResult(messageId: string): Promise<SecureRoomPendingUiResult> {
    this.assertUsable();
    if (canonicalBase64UrlByteLength(messageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid pending UI message id");
    }
    const entry = this.durable.pendingOutbox.find((candidate) => candidate.messageId === messageId);
    if (!entry) throw new SecureRoomEngineError("invalid-input", "pending UI message is absent");
    const rollback = this.durable.pendingApplicationRollback;
    if (entry.kind === "application") {
      if (rollback?.messageId !== messageId) {
        throw new SecureRoomEngineError("state-invalid", "pending application UI rollback is absent");
      }
      const roster = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
      const membership = this.membershipForEvent(entry.event, roster);
      const reduced = await reduceSecureRoomEventV4(rollback.applicationState, entry.event, membership);
      if (!reduced.ok || canonicalJsonV4(reduced.state) !== canonicalJsonV4(this.durable.applicationState)) {
        throw new SecureRoomEngineError("state-invalid", "pending application UI result diverges from durable state");
      }
      return { state: cloneApplicationState(reduced.state), effects: [...reduced.effects] };
    }
    const commitRollback = this.durable.pendingCommitRollback;
    if (commitRollback?.messageId !== messageId) {
      throw new SecureRoomEngineError("invalid-input", "pending commit UI rollback is absent");
    }
    const rollbackApplicationState = entry.kind === "admission" && entry.addedDeviceId !== null
      ? bindMembershipAdmission(commitRollback.applicationState, entry.addedDeviceId, entry.admissionId)
      : commitRollback.applicationState;
    const reconciled = reconcileSecureRoomMembershipV4(
      rollbackApplicationState,
      this.knownMembership(SecureRoomEngine.normalizeRoster(this.requireSession().roster())),
    );
    if (!reconciled.ok || canonicalJsonV4(reconciled.state) !== canonicalJsonV4(this.durable.applicationState)) {
      throw new SecureRoomEngineError("state-invalid", "pending commit UI result diverges from durable state");
    }
    return { state: cloneApplicationState(reconciled.state), effects: [...reconciled.effects] };
  }

  hasProcessedRelayMessage(messageId: string): boolean {
    this.assertUsable();
    if (canonicalBase64UrlByteLength(messageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid relay message id");
    }
    return this.durable.processedDeliveries.some((delivery) => delivery.messageId === messageId);
  }

  get signaturePublicKey(): string {
    this.assertUsable();
    const keyBytes = this.requireSession().signaturePublicKey();
    let signaturePublicKey: string;
    try {
      if (keyBytes.byteLength !== SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES) {
        throw new SecureRoomEngineError("state-invalid", "durable MLS credential key has an invalid length");
      }
      signaturePublicKey = this.encodeBase64Url(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
    if (!this.requireSession().isActive()) return signaturePublicKey;
    const own = SecureRoomEngine.normalizeRoster(this.requireSession().roster())
      .filter((entry) => entry.deviceId === this.deviceId);
    if (own.length !== 1 || own[0].signaturePublicKey !== signaturePublicKey) {
      throw new SecureRoomEngineError("state-invalid", "durable device credential is absent or duplicated in the MLS roster");
    }
    return signaturePublicKey;
  }

  isActive(): boolean {
    this.assertUsable();
    return this.requireSession().isActive();
  }

  roster(): SecureRoomRosterEntry[] {
    this.assertUsable();
    return SecureRoomEngine.normalizeRoster(this.requireSession().roster()).map(({ leafIndex, deviceId, signaturePublicKey }) => ({
      leafIndex,
      deviceId,
      signaturePublicKey,
    }));
  }

  get currentRetirementBarrier(): SecureRoomRetirementBarrierV4 | null {
    this.assertUsable();
    const current = this.retirementBarriers.entries().next().value as [string, string] | undefined;
    return current
      ? { deviceId: current[0], admissionCommitMessageId: current[1] }
      : null;
  }

  /**
   * Installs an exact invitation-signed membership admission id before any
   * later MLS traffic is processed. Duplicate delivery is idempotent;
   * rebinding the host-authenticated device/id pair fails closed.
   */
  registerRetirementBarrier(barrierValue: SecureRoomRetirementBarrierV4): boolean {
    this.assertUsable();
    this.assertLease();
    const barrier = this.parseRetirementBarrier(barrierValue);
    const existing = this.retirementBarriers.get(barrier.deviceId);
    if (existing !== undefined) {
      if (existing !== barrier.admissionCommitMessageId) {
        throw new SecureRoomEngineError("unauthorized", "relay rebound a pending retirement device to another admission");
      }
      return true;
    }
    if ([...this.retirementBarriers.values()].includes(barrier.admissionCommitMessageId)) {
      throw new SecureRoomEngineError("unauthorized", "relay rebound a pending retirement admission to another device");
    }
    if (this.retirementBarriers.size >= MAX_SECURE_ZOMBIE_REMOVALS_V4) {
      throw new SecureRoomEngineError("pending-saturated", "pending retirement barrier limit reached");
    }
    const rosterContainsTarget = SecureRoomEngine.normalizeRoster(this.requireSession().roster())
      .some((entry) => entry.deviceId === barrier.deviceId);
    if (rosterContainsTarget) {
      const admissionBinding = this.durable.applicationState.membershipAdmissionBindings
        .find((binding) => binding.deviceId === barrier.deviceId);
      if (!admissionBinding || admissionBinding.admissionId === null ||
          admissionBinding.admissionId !== barrier.admissionCommitMessageId) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "relay retirement marker does not match the host-authenticated membership admission",
        );
      }
    } else {
      const pendingRemoval = this.durable.pendingRelayControls.find((control) =>
        control.kind === "retire-member" && control.deviceId === barrier.deviceId &&
        control.retirementAdmissionCommitMessageId === barrier.admissionCommitMessageId);
      // A peer may see the marker again after it already processed the Remove.
      // With no leaf and no exact local removal retry, the marker has no work to
      // authorize and is safely ignored rather than becoming a relay-controlled
      // denial-of-service barrier.
      if (!pendingRemoval) return false;
    }
    // A crash can occur after the Remove transition is durably committed but
    // before its relay ACK or retire-member control is observed. The relay
    // replays the exact marker on resume, while the restored roster already
    // proves that the target has been erased. Retaining the marker is
    // idempotent and lets the controller bind a pending commit retry (or wait
    // for the authoritative retired lifecycle) without resurrecting the leaf.
    this.retirementBarriers.set(barrier.deviceId, barrier.admissionCommitMessageId);
    return true;
  }

  /** Clears only the FIFO barrier that an acknowledged local remove consumed. */
  resolveRetirementBarrier(barrierValue: SecureRoomRetirementBarrierV4): void {
    this.assertUsable();
    this.assertLease();
    const barrier = this.parseRetirementBarrier(barrierValue);
    this.assertCurrentRetirementBarrier(barrier);
    if (SecureRoomEngine.normalizeRoster(this.requireSession().roster())
      .some((entry) => entry.deviceId === barrier.deviceId)) {
      throw new SecureRoomEngineError("transition-invalid", "cannot resolve retirement before the MLS target is removed");
    }
    this.retirementBarriers.delete(barrier.deviceId);
  }

  async signDeviceResumeProof(context: SecureDeviceResumeContextV4): Promise<string> {
    this.assertUsable();
    this.assertLease();
    if (
      !context || typeof context !== "object" ||
      context.roomInstance !== this.roomInstance || context.deviceId !== this.deviceId
    ) throw new SecureRoomEngineError("invalid-input", "secure-device resume context is not bound to this room and device");
    try {
      return await signSecureDeviceResumeProofV4(context, (bytes) => this.requireSession().sign(bytes));
    } catch (error) {
      throw engineError(error, "invalid-input", "secure-device resume proof could not be signed");
    }
  }

  async createKeyPackage(): Promise<SecureRoomKeyPackageResult> {
    const messageId = this.allocatePendingMessageId();
    return this.runMlsMutation(
      () => this.requireSession().keyPackage(),
      async (transition) => {
        assertTransitionKind(transition, "key-package");
        const keyPackage = copyBytes(transition.outbound, "key package");
        const pendingOutbox = this.appendPendingOutbox({
          kind: "admission",
          admissionId: messageId,
          messageId,
          outbound: keyPackage,
          welcomeMessageId: null,
          welcome: null,
          ratchetTree: null,
          addedDeviceId: null,
          bootstrapMessageId: null,
          joinWelcomeMessageId: null,
          grant: null,
          commitAcknowledged: false,
          welcomeAcknowledged: false,
        });
        const applicationState = this.durable.applicationState.hostDeviceId === this.deviceId &&
          this.durable.applicationState.members.some((member) => member.deviceId === this.deviceId)
          ? bindMembershipAdmission(this.durable.applicationState, this.deviceId, messageId)
          : this.durable.applicationState;
        const durable = this.nextDurable(transition, { applicationState, pendingOutbox });
        return {
          durable,
          result: () => ({ kind: "key-package", epoch: transition.epoch, messageId, keyPackage }),
        };
      },
    );
  }

  async addMember(
    keyPackage: Uint8Array,
    admissionId: string,
    grant: SecureLogicalOrderGrantV4,
    roomId: string,
    memberBindingValue: RoomInvitationMemberBindingV4,
  ): Promise<SecureRoomAddResult> {
    this.assertHost();
    this.assertNoMembershipBarrier();
    if (this.admissionBlockedByApplicationState()) {
      throw new SecureRoomEngineError(
        "transition-invalid",
        "new members cannot be admitted during a game or pending host transfer",
      );
    }
    if (canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid admission id");
    }
    const memberBinding = parseRoomInvitationMemberBindingV4(memberBindingValue);
    const keyPackageDigest = await secureKeyPackageDigestV4(keyPackage);
    if (!memberBinding || memberBinding.mode !== "admission" ||
        memberBinding.roomId !== roomId || memberBinding.roomInstance !== this.roomInstance ||
        memberBinding.admissionId !== admissionId || memberBinding.deviceId === this.deviceId ||
        memberBinding.keyPackageDigest !== keyPackageDigest ||
        !await verifyRoomInvitationMemberBindingWithSecretV4({
          binding: memberBinding,
          expected: memberBinding,
          roomSecret: this.roomSecret,
        })) {
      throw new SecureRoomEngineError("unauthorized", "MLS admission is not bound to the exact invitation-authorized member");
    }
    const validatedGrant = this.validateOutboundGrant(grant);
    const messageId = this.allocatePendingMessageId([admissionId, validatedGrant.requestId, validatedGrant.tokenId]);
    const welcomeMessageId = this.allocatePendingMessageId([
      admissionId, messageId, validatedGrant.requestId, validatedGrant.tokenId,
    ]);
    const before = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
    return this.runMlsMutation(
      () => this.requireSession().add(keyPackage),
      async (transition) => {
        assertTransitionKind(transition, "add");
        const after = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
        this.assertStableRoster(before, after, { added: 1, removed: 0 });
        const added = after.find((candidate) => !before.some((entry) => entry.deviceId === candidate.deviceId));
        if (!added || added.deviceId !== memberBinding.deviceId ||
            added.signaturePublicKey !== memberBinding.signaturePublicKey) {
          throw new SecureRoomEngineError(
            "unauthorized",
            "MLS add credential does not match the invitation-authorized member binding",
          );
        }
        const outbound = copyBytes(transition.outbound, "add commit");
        const welcome = copyBytes(transition.welcome, "Welcome");
        const ratchetTree = copyBytes(transition.ratchetTree, "ratchet tree");
        // Validate the exact canonical aggregate before the mutated MLS state
        // can cross the CAS boundary. Individual artifact limits are not enough.
        const admissionBundle = encodeSecureAdmissionBundleV4(welcome, ratchetTree);
        admissionBundle.fill(0);
        const pendingOutbox = this.appendPendingOutbox({
          kind: "admission",
          admissionId,
          messageId,
          outbound,
          welcomeMessageId,
          welcome,
          ratchetTree,
          addedDeviceId: added.deviceId,
          bootstrapMessageId: null,
          joinWelcomeMessageId: null,
          grant: validatedGrant,
          commitAcknowledged: false,
          welcomeAcknowledged: false,
        });
        const pendingRelayControls = this.appendPendingRelayControl({
          kind: "admission-barrier",
          admissionId,
          deviceId: added.deviceId,
        });
        const applicationState = bindMembershipAdmission(
          this.durable.applicationState,
          added.deviceId,
          admissionId,
        );
        const durable = this.nextDurable(transition, {
          applicationState,
          pendingOutbox,
          pendingRelayControls,
          pendingCommitRollback: this.createPendingCommitRollback(messageId),
        });
        return {
          durable,
          result: () => ({
            kind: "add",
            epoch: transition.epoch,
            admissionId,
            messageId,
            welcomeMessageId,
            addedDeviceId: added.deviceId,
            outbound,
            welcome,
            ratchetTree,
          }),
        };
      },
    );
  }

  async join(
    welcome: Uint8Array,
    ratchetTree: Uint8Array,
    relayMessageId: string,
    admissionId: string,
  ): Promise<SecureRoomJoinResult | SecureRoomAlreadyProcessedResult> {
    this.assertUsable();
    this.assertLease();
    if (canonicalBase64UrlByteLength(relayMessageId) !== SECURE_MESSAGE_ID_BYTES ||
        canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES ||
        relayMessageId === admissionId) {
      throw new SecureRoomEngineError("invalid-input", "Welcome requires exact authenticated relay and admission ids");
    }
    const retained = this.durable.pendingOutbox.find((entry) => entry.kind === "admission" &&
      entry.welcomeMessageId === null && entry.admissionId === admissionId &&
      entry.messageId === admissionId && entry.commitAcknowledged);
    if (!retained || retained.kind !== "admission" ||
        (retained.joinWelcomeMessageId !== null && retained.joinWelcomeMessageId !== relayMessageId)) {
      throw new SecureRoomEngineError("transition-invalid", "Welcome does not match the retained authenticated admission");
    }
    if (!this.expectedJoinFounder) {
      throw new SecureRoomEngineError("unauthorized", "Welcome arrived before an invitation-authorized founder binding");
    }
    const deliveryDigest = await this.digestRelayDelivery(
      relayMessageId,
      encodeSecureAdmissionBundleV4(welcome, ratchetTree),
    );
    if (deliveryDigest.alreadyProcessed) {
      this.assertExpectedFounderInRoster(SecureRoomEngine.normalizeRoster(this.requireSession().roster()));
      return { kind: "already-processed", relayMessageId: deliveryDigest.messageId };
    }
    if (this.requireSession().isActive()) {
      throw new SecureRoomEngineError("transition-invalid", "an active MLS member cannot consume another Welcome");
    }
    return this.runMlsMutation(
      () => this.requireSession().join(welcome, ratchetTree),
      async (transition) => {
        assertTransitionKind(transition, "join");
        const roster = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
        if (!this.requireSession().isActive() || !roster.some((entry) => entry.deviceId === this.deviceId)) {
          throw new SecureRoomEngineError("transition-invalid", "MLS join did not activate the durable device identity");
        }
        this.assertExpectedFounderInRoster(roster);
        const pendingOutbox = cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox);
        const retainedIndex = pendingOutbox.findIndex((entry) => entry.kind === "admission" &&
          entry.admissionId === admissionId && entry.welcomeMessageId === null);
        const retainedEntry = retainedIndex < 0 ? null : pendingOutbox[retainedIndex];
        if (!retainedEntry || retainedEntry.kind !== "admission") {
          throw new SecureRoomEngineError("state-invalid", "retained admission disappeared during Welcome processing");
        }
        retainedEntry.joinWelcomeMessageId = relayMessageId;
        const pendingRelayControls = this.appendPendingRelayControl({
          kind: "admission-barrier",
          admissionId,
          deviceId: this.deviceId,
        });
        const durable = this.nextDurable(transition, {
          pendingOutbox,
          pendingRelayControls,
          processedDeliveries: this.appendProcessedDelivery(deliveryDigest.messageId, deliveryDigest.digest),
        });
        return {
          durable,
          result: () => ({
            kind: "join",
            epoch: transition.epoch,
            relayMessageId,
            roster: roster.map(({ leafIndex, deviceId, signaturePublicKey }) => ({ leafIndex, deviceId, signaturePublicKey })),
          }),
        };
      },
    );
  }

  async authorizeJoinFounder(roomId: string, bindingValue: RoomInvitationMemberBindingV4): Promise<void> {
    this.assertUsable();
    this.assertLease();
    const binding = parseRoomInvitationMemberBindingV4(bindingValue);
    if (!binding || binding.mode !== "founder" || binding.roomId !== roomId ||
        binding.roomInstance !== this.roomInstance || binding.deviceId === this.deviceId ||
        !await verifyRoomInvitationMemberBindingWithSecretV4({
          binding,
          expected: binding,
          roomSecret: this.roomSecret,
        })) {
      throw new SecureRoomEngineError("unauthorized", "founder binding is not authorized by this room invitation");
    }
    this.expectedJoinFounder = {
      deviceId: binding.deviceId,
      signaturePublicKey: binding.signaturePublicKey,
    };
    if (this.requireSession().isActive()) {
      this.assertExpectedFounderInRoster(SecureRoomEngine.normalizeRoster(this.requireSession().roster()));
    }
  }

  async removeMember(
    leafIndex: number,
    grant: SecureLogicalOrderGrantV4,
    retirementBarrier?: SecureRoomRetirementBarrierV4,
  ): Promise<SecureRoomCommitResult> {
    this.assertHost();
    const validatedGrant = this.validateOutboundGrant(grant);
    const before = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
    const target = before.find((entry) => entry.leafIndex === leafIndex);
    if (!target) throw new SecureRoomEngineError("invalid-input", "member leaf index is absent from the MLS roster");
    if (target.deviceId === this.deviceId) {
      throw new SecureRoomEngineError("unauthorized", "the active host cannot remove its own MLS identity");
    }
    const exactRetirementBarrier = retirementBarrier === undefined
      ? null
      : this.parseRetirementBarrier(retirementBarrier);
    if (this.retirementBarriers.size !== 0) {
      if (!exactRetirementBarrier || exactRetirementBarrier.deviceId !== target.deviceId) {
        throw new SecureRoomEngineError("unauthorized", "MLS removal does not match the current relay retirement target");
      }
      this.assertCurrentRetirementBarrier(exactRetirementBarrier);
    } else if (exactRetirementBarrier !== null) {
      throw new SecureRoomEngineError("unauthorized", "MLS removal supplied an unregistered relay retirement barrier");
    } else if (this.pendingAdmissionBarrier !== null ||
        this.durable.applicationState.pendingRemovalDeviceIds[0] !== target.deviceId) {
      throw new SecureRoomEngineError("unauthorized", "MLS removal has no signed application request or relay retirement barrier");
    }
    const messageId = this.allocatePendingMessageId([validatedGrant.requestId, validatedGrant.tokenId]);
    const relayRequestId = this.allocateRelayRequestId([messageId]);
    return this.runMlsMutation(
      () => this.requireSession().remove(leafIndex),
      async (transition) => {
        assertTransitionKind(transition, "remove");
        const after = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
        this.assertStableRoster(before, after, { added: 0, removed: 1 });
        if (after.some((entry) => entry.deviceId === target.deviceId)) {
          throw new SecureRoomEngineError("transition-invalid", "MLS remove transition retained the target identity");
        }
        const reconciled = reconcileSecureRoomMembershipV4(
          this.durable.applicationState,
          this.knownMembership(after),
        );
        if (!reconciled.ok) {
          throw new SecureRoomEngineError("transition-invalid", `application membership reconciliation failed: ${reconciled.code}`);
        }
        const outbound = copyBytes(transition.outbound, "remove commit");
        const pendingOutbox = this.appendPendingOutbox({
          kind: "commit", messageId, outbound, grant: validatedGrant,
        }, this.durable.pendingOutbox.filter((entry) =>
          entry.kind !== "admission" || entry.addedDeviceId !== target.deviceId));
        const pendingRelayControls = this.appendPendingRelayControl({
          kind: "retire-member",
          requestId: relayRequestId,
          deviceId: target.deviceId,
          commitMessageId: messageId,
          retirementAdmissionCommitMessageId: exactRetirementBarrier?.admissionCommitMessageId ?? null,
        }, this.durable.pendingRelayControls.filter((control) =>
          control.kind !== "admission-barrier" || control.deviceId !== target.deviceId));
        const durable = this.nextDurable(transition, {
          applicationState: reconciled.state,
          pendingOutbox,
          pendingRelayControls,
          pendingCommitRollback: this.createPendingCommitRollback(messageId),
        });
        return {
          durable,
          result: () => ({
            kind: "remove",
            epoch: transition.epoch,
            messageId,
            outbound,
            removedDeviceId: target.deviceId,
            relayRequestId,
            effects: [...reconciled.effects],
          }),
        };
      },
    );
  }

  async selfUpdate(grant: SecureLogicalOrderGrantV4): Promise<SecureRoomCommitResult> {
    this.assertNoMembershipBarrier();
    if (!this.requireSession().isActive()) throw new SecureRoomEngineError("transition-invalid", "inactive MLS session cannot update");
    const validatedGrant = this.validateOutboundGrant(grant);
    const before = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
    const messageId = this.allocatePendingMessageId([validatedGrant.requestId, validatedGrant.tokenId]);
    return this.runMlsMutation(
      () => this.requireSession().selfUpdate(),
      async (transition) => {
        assertTransitionKind(transition, "self-update");
        const after = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
        this.assertStableRoster(before, after, { added: 0, removed: 0 });
        const outbound = copyBytes(transition.outbound, "self-update commit");
        const pendingOutbox = this.appendPendingOutbox({
          kind: "commit", messageId, outbound, grant: validatedGrant,
        });
        const durable = this.nextDurable(transition, {
          pendingOutbox,
          pendingCommitRollback: this.createPendingCommitRollback(messageId),
        });
        return {
          durable,
          result: () => ({ kind: "self-update", epoch: transition.epoch, messageId, outbound, effects: [] }),
        };
      },
    );
  }

  async putPendingCommitSecret(secret: SecureRoomPendingCommitSecretV4): Promise<void> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    await this.validateCommitSecret(secret);
    const prior = this.durable.pendingCommitSecrets[secret.gameId];
    if (prior) {
      if (canonicalJsonV4(prior) === canonicalJsonV4(secret)) return;
      throw new SecureRoomEngineError("invalid-input", "a different secret is already committed for this game");
    }
    const pendingCommitSecrets = this.cloneCommitSecrets(this.durable.pendingCommitSecrets);
    pendingCommitSecrets[secret.gameId] = { ...secret };
    await this.persistDurable(this.nextDurable(undefined, { pendingCommitSecrets }));
  }

  pendingCommitSecret(gameId: string): SecureRoomPendingCommitSecretV4 | null {
    this.assertUsable();
    if (canonicalBase64UrlByteLength(gameId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid committed-secret game id");
    }
    const secret = this.durable.pendingCommitSecrets[gameId];
    return secret ? { ...secret } : null;
  }

  async deletePendingCommitSecret(gameId: string): Promise<void> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (canonicalBase64UrlByteLength(gameId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid committed-secret game id");
    }
    if (!Object.prototype.hasOwnProperty.call(this.durable.pendingCommitSecrets, gameId)) {
      throw new SecureRoomEngineError("invalid-input", "no committed secret exists for this game");
    }
    const pendingCommitSecrets = this.cloneCommitSecrets(this.durable.pendingCommitSecrets);
    delete pendingCommitSecrets[gameId];
    await this.persistDurable(this.nextDurable(undefined, { pendingCommitSecrets }));
  }

  async encryptCommitEvent(
    content: SecureApplicationContentV4,
    secret: SecureRoomPendingCommitSecretV4,
    grant: SecureLogicalOrderGrantV4,
  ): Promise<SecureRoomOutboundApplicationResult> {
    this.assertNoMembershipBarrier();
    const matches = secret.kind === "rps"
      ? content.type === "rps" && content.action === "commit" &&
        content.gameId === secret.gameId && content.commitment === secret.commitment
      : content.type === "saboteur" && content.action === "entropy-commit" &&
        content.gameId === secret.gameId && content.commitment === secret.commitment;
    if (!matches) throw new SecureRoomEngineError("invalid-input", "commit event does not match its durable secret");
    await this.putPendingCommitSecret(secret);
    return this.encryptEvent(content, grant);
  }

  async encryptEvent(
    content: SecureApplicationContentV4,
    grant: SecureLogicalOrderGrantV4,
  ): Promise<SecureRoomOutboundApplicationResult> {
    if (content.type === "member-profile" &&
      !this.durable.applicationState.members.some((member) => member.deviceId === this.deviceId)) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "an unprofiled joiner must use the admission-bound join-proof API",
      );
    }
    return this.encryptEventInternal(content, grant);
  }

  async encryptJoinProof(
    displayName: string,
    admissionId: string,
    welcomeMessageId: string,
    grant: SecureLogicalOrderGrantV4,
  ): Promise<SecureRoomOutboundApplicationResult> {
    this.assertUsable();
    const retainedJoinAuth = this.durable.pendingOutbox.find(
      (entry): entry is Extract<SecureRoomPendingOutboxEntryV1, { kind: "admission" }> =>
        entry.kind === "admission" && entry.welcomeMessageId === null &&
        entry.admissionId === admissionId && entry.messageId === admissionId && entry.commitAcknowledged,
    );
    if (
      canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES ||
      canonicalBase64UrlByteLength(welcomeMessageId) !== SECURE_MESSAGE_ID_BYTES ||
      admissionId === welcomeMessageId || !this.hasProcessedRelayMessage(welcomeMessageId) ||
      !retainedJoinAuth || retainedJoinAuth.joinWelcomeMessageId !== welcomeMessageId ||
      this.durable.applicationState.hostDeviceId === null ||
      this.durable.applicationState.members.some((member) => member.deviceId === this.deviceId) ||
      !SecureRoomEngine.normalizeRoster(this.requireSession().roster())
        .some((member) => member.deviceId === this.deviceId)
    ) {
      throw new SecureRoomEngineError(
        "transition-invalid",
        "join proof is not bound to a processed Welcome and bootstrapped unprofiled MLS member",
      );
    }
    return this.encryptEventInternal(
      { type: "member-profile", displayName },
      grant,
      undefined,
      { kind: "join-proof", admissionId, welcomeMessageId },
    );
  }

  async encryptStateSnapshot(
    admissionId: string,
    grant: SecureLogicalOrderGrantV4,
  ): Promise<SecureRoomOutboundApplicationResult> {
    this.assertHost();
    this.assertNoPendingApplication();
    const candidates = this.durable.pendingOutbox.filter(
      (entry): entry is Extract<SecureRoomPendingOutboxEntryV1, { kind: "admission" }> =>
        entry.kind === "admission" && entry.welcomeMessageId !== null &&
        entry.commitAcknowledged && entry.welcomeAcknowledged && entry.bootstrapMessageId === null &&
        (admissionId === undefined || entry.admissionId === admissionId),
    );
    if (admissionId !== undefined && canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid bootstrap admission id");
    }
    if (candidates.length !== 1) {
      throw new SecureRoomEngineError("transition-invalid", "exactly one acknowledged admission must await bootstrap");
    }
    const bootstrapAdmissionId = candidates[0].admissionId;
    const welcomeMessageId = candidates[0].welcomeMessageId!;
    const eventId = this.allocateEventId();
    const deviceSequence = this.durable.nextDeviceSequence;
    const logicalOrder = this.durable.applicationState.logicalOrder + 1;
    const snapshot = cloneApplicationState(this.durable.applicationState);
    snapshot.messages = [];
    snapshot.drawings = [];
    const own = snapshot.members.find((member) => member.deviceId === this.deviceId);
    if (!own) throw new SecureRoomEngineError("state-invalid", "host profile is absent from application state");
    own.lastSequence = deviceSequence;
    snapshot.logicalOrder = logicalOrder;
    snapshot.revision = Math.max(snapshot.revision + 1, logicalOrder);
    snapshot.seenEventIds.push(eventId);
    if (snapshot.seenEventIds.length > 1_024) snapshot.seenEventIds.shift();
    return this.encryptEventInternal(
      { type: "state-snapshot", state: snapshot },
      grant,
      eventId,
      {
        kind: "bootstrap",
        admissionId: bootstrapAdmissionId,
        welcomeMessageId,
      },
    );
  }

  private async encryptEventInternal(
    content: SecureApplicationContentV4,
    grant: SecureLogicalOrderGrantV4,
    fixedEventId?: string,
    relayContext?: SecureRoomApplicationRelayContextV1,
  ): Promise<SecureRoomOutboundApplicationResult> {
    const intendedRelayContext: SecureRoomApplicationRelayContextV1 = relayContext ??
      (content.type === "host-transfer" && content.action === "accept"
        ? { kind: "host-transfer-accept", authorizationId: content.authorizationId }
        : { kind: "application" });
    this.assertOutboundApplicationAllowedDuringBarriers(intendedRelayContext);
    if (!this.requireSession().isActive()) throw new SecureRoomEngineError("transition-invalid", "inactive MLS session cannot encrypt events");
    const retainedJoinAdmissionId = relayContext?.kind === "join-proof"
      ? relayContext.admissionId
      : undefined;
    const validatedGrant = this.validateOutboundGrant(grant, retainedJoinAdmissionId);
    const deleteCommitSecretOnAccept = this.validateEventCommitSecret(content);
    const messageId = this.allocatePendingMessageId([validatedGrant.requestId, validatedGrant.tokenId]);
    const eventId = fixedEventId ?? this.allocateEventId();
    const unsigned = {
      v: 4 as const,
      roomInstance: this.roomInstance,
      eventId,
      deviceId: this.deviceId,
      deviceSequence: this.durable.nextDeviceSequence,
      logicalOrder: this.durable.applicationState.logicalOrder + 1,
      content,
    };
    let event: SecureApplicationEventV4;
    try {
      event = await signSecureApplicationEventV4(unsigned, async (bytes) => this.requireSession().sign(bytes));
    } catch (error) {
      throw engineError(error, "invalid-input", "application event could not be signed");
    }
    const membership = this.membershipForEvent(event, SecureRoomEngine.normalizeRoster(this.requireSession().roster()));
    const reduced = await reduceSecureRoomEventV4(this.durable.applicationState, event, membership);
    if (!reduced.ok) {
      throw new SecureRoomEngineError("transition-invalid", `outbound application event was rejected: ${reduced.code}`);
    }
    const pendingRelayControls = this.planOutboundRelayControls(content, messageId, reduced.effects);
    const plaintext = UTF8.encode(canonicalJsonV4(event));
    try {
      return await this.runMlsMutation(
        () => this.requireSession().encrypt(plaintext),
        async (transition) => {
        assertTransitionKind(transition, "outbound-application");
        const outbound = copyBytes(transition.outbound, "application ciphertext");
        const pendingApplicationRollback = {
          messageId,
          applicationState: cloneApplicationState(this.durable.applicationState),
          nextDeviceSequence: this.durable.nextDeviceSequence,
          lastEpoch: this.durable.lastEpoch,
          pendingOutbox: cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox),
          pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls),
          processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(this.durable.processedDeliveries),
          pendingCommitSecrets: this.cloneCommitSecrets(this.durable.pendingCommitSecrets),
          deleteCommitSecretOnAccept,
        };
        const exactRelayContext = intendedRelayContext;
        const pendingOutbox = this.appendPendingOutbox({
          kind: "application",
          messageId,
          outbound,
          event: JSON.parse(canonicalJsonV4(event)) as SecureApplicationEventV4,
          grant: validatedGrant,
          relayContext: exactRelayContext,
        });
        if (exactRelayContext.kind === "bootstrap") {
          const admission = pendingOutbox.find((entry) => entry.kind === "admission" &&
            entry.admissionId === exactRelayContext.admissionId);
          if (!admission || admission.kind !== "admission" || admission.bootstrapMessageId !== null) {
            throw new SecureRoomEngineError("state-invalid", "bootstrap admission context disappeared during encryption");
          }
          admission.bootstrapMessageId = messageId;
        }
        const hostTransferControl = pendingRelayControls.find((control) =>
          control.kind === "transfer-host" &&
          (control.offerMessageId === messageId || control.acceptMessageId === messageId)
        );
        const hostTransferAuthorizationId = hostTransferControl?.kind === "transfer-host"
          ? hostTransferControl.authorizationId ?? undefined
          : undefined;
        const durable = this.nextDurable(transition, {
          applicationState: reduced.state,
          nextDeviceSequence: event.deviceSequence + 1,
          pendingOutbox,
          pendingRelayControls,
          pendingApplicationRollback,
        });
        return {
          durable,
          result: () => ({
            kind: "outbound-application",
            epoch: transition.epoch,
            messageId,
            event: JSON.parse(canonicalJsonV4(event)) as SecureApplicationEventV4,
            outbound,
            state: cloneApplicationState(reduced.state),
            effects: [...reduced.effects],
            ...(hostTransferAuthorizationId !== undefined && { hostTransferAuthorizationId }),
          }),
        };
        },
      );
    } finally {
      plaintext.fill(0);
    }
  }

  async receive(
    message: Uint8Array,
    delivery: SecureRoomRelayDeliveryContext,
  ): Promise<SecureRoomReceiveResult> {
    this.assertUsable();
    this.assertLease();
    const relayContext = delivery?.relayContext;
    if (
      !isPlainDataRecord(delivery) ||
      Reflect.ownKeys(delivery).length !== 4 ||
      !["messageId", "fromDeviceId", "logicalOrder", "relayContext"].every((key) =>
        Object.prototype.hasOwnProperty.call(delivery, key)) ||
      Reflect.ownKeys(delivery).some((key) => typeof key !== "string" ||
        !["messageId", "fromDeviceId", "logicalOrder", "relayContext"].includes(key)) ||
      canonicalBase64UrlByteLength(delivery.messageId) !== SECURE_MESSAGE_ID_BYTES ||
      canonicalBase64UrlByteLength(delivery.fromDeviceId) !== SECURE_DEVICE_ID_BYTES ||
      !isSecureInboundRelayContext(relayContext) ||
      !(delivery.logicalOrder === null ||
        Number.isSafeInteger(delivery.logicalOrder) && delivery.logicalOrder >= 1) ||
      (relayContext?.kind === "commit") !== (delivery.logicalOrder === null)
    ) throw new SecureRoomEngineError("invalid-input", "invalid authenticated relay delivery context");
    const deliveryDigest = await this.digestRelayDelivery(delivery.messageId, message, delivery);
    if (deliveryDigest.alreadyProcessed) {
      return { kind: "already-processed", relayMessageId: deliveryDigest.messageId };
    }
    this.assertInboundAllowedDuringMembershipBarrier(relayContext, delivery.fromDeviceId);
    if (!this.requireSession().isActive()) throw new SecureRoomEngineError("transition-invalid", "inactive MLS session cannot receive group messages");
    const before = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
    return this.runMlsMutation(
      () => this.requireSession().receive(message),
      async (transition) => {
        if (transition.kind === "inbound-proposal") {
          // Pillowfort emits atomic commits for its supported membership and
          // update operations. Standalone proposals have no authorization
          // context in the application protocol and therefore fail closed.
          throw new SecureRoomEngineError("transition-invalid", "standalone MLS proposals are unsupported");
        }
        if (transition.kind === "inbound-application") {
          return this.planInboundApplication(transition, delivery, deliveryDigest);
        }
        if (transition.kind === "inbound-commit") {
          return this.planInboundCommit(transition, before, delivery, deliveryDigest);
        }
        throw new SecureRoomEngineError("transition-invalid", `unexpected inbound MLS transition kind: ${transition.kind}`);
      },
    );
  }

  /**
   * Host-side admission oracle. It processes the ciphertext against an
   * isolated restore of the last durable MLS state, runs the full authenticated
   * reducer, and discards the mutation. No plaintext event, reducer state, or
   * effects escape this boundary; normal receive() remains able to consume the
   * exact same ciphertext after the relay records approval.
   */
  async inspectInboundApplication(
    message: Uint8Array,
    expectedSenderDeviceId: string,
    expectedLogicalOrder: number,
    expectedRelayContext: Exclude<SecureRoomInboundRelayContext, { kind: "commit" }>,
  ): Promise<SecureRoomInboundApplicationInspection> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (
      !(message instanceof Uint8Array) || message.byteLength < 1 ||
      message.byteLength > MAX_MLS_RELAY_PAYLOAD_BYTES ||
      canonicalBase64UrlByteLength(expectedSenderDeviceId) !== SECURE_DEVICE_ID_BYTES ||
      !Number.isSafeInteger(expectedLogicalOrder) || expectedLogicalOrder < 1 ||
      !isSecureInboundRelayContext(expectedRelayContext)
    ) throw new SecureRoomEngineError("invalid-input", "invalid bounded application preview or relay attribution");
    this.assertInboundApplicationAllowedDuringMembershipBarrier(expectedRelayContext, expectedSenderDeviceId);
    const binding = decodeCanonicalBase64UrlV4(this.roomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES)!;
    let temporary: MlsCryptoSession | null = null;
    let transition: MlsTransition | null = null;
    try {
      temporary = await MlsCryptoSession.restore({
        roomBinding: binding,
        roomSecret: this.roomSecret,
        snapshot: this.durable.mlsSnapshot,
      });
      transition = await temporary.receive(message);
      assertTransitionKind(transition, "inbound-application");
      const validated = await this.validateInboundApplication(
        transition,
        SecureRoomEngine.normalizeRoster(temporary.roster()),
        expectedRelayContext.kind === "host-transfer-accept" ? expectedRelayContext.authorizationId : undefined,
      );
      if (validated.senderDeviceId !== expectedSenderDeviceId) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "application preview MLS sender does not match its relay sender",
        );
      }
      if (validated.event.logicalOrder !== expectedLogicalOrder) {
        throw new SecureRoomEngineError(
          "transition-invalid",
          "application preview signed order does not match its relay order",
        );
      }
      this.assertInboundApplicationRelayMatch(validated.event, validated.senderDeviceId, expectedRelayContext);
      this.assertLease();
      return {
        kind: "inbound-application",
        epoch: transition.epoch,
        senderDeviceId: validated.senderDeviceId,
        eventId: validated.event.eventId,
        logicalOrder: validated.event.logicalOrder,
      };
    } catch (error) {
      throw engineError(error, "transition-invalid", "inbound application inspection rejected the ciphertext");
    } finally {
      transition?.plaintext?.fill(0);
      transition?.senderIdentity?.fill(0);
      binding.fill(0);
      temporary?.dispose();
    }
  }

  /**
   * Host-side oracle for a relay commit preview. The ciphertext is processed
   * only in an isolated restore of the last durable MLS state. Relay previews
   * are intentionally restricted to authenticated, same-roster update-path
   * commits; membership changes remain host-originated operations.
   */
  async inspectInboundCommit(
    message: Uint8Array,
    expectedSenderDeviceId: string,
  ): Promise<SecureRoomInboundCommitInspection> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (
      !(message instanceof Uint8Array) || message.byteLength < 1 ||
      message.byteLength > MAX_MLS_RELAY_PAYLOAD_BYTES ||
      canonicalBase64UrlByteLength(expectedSenderDeviceId) !== SECURE_DEVICE_ID_BYTES
    ) throw new SecureRoomEngineError("invalid-input", "invalid bounded commit preview or outer sender identity");
    this.assertNoMembershipBarrier();
    const binding = decodeCanonicalBase64UrlV4(
      this.roomInstance,
      SECURE_ROOM_ID_BYTES,
      SECURE_ROOM_ID_BYTES,
    )!;
    let temporary: MlsCryptoSession | null = null;
    let transition: MlsTransition | null = null;
    try {
      temporary = await MlsCryptoSession.restore({
        roomBinding: binding,
        roomSecret: this.roomSecret,
        snapshot: this.durable.mlsSnapshot,
      });
      const before = SecureRoomEngine.normalizeRoster(temporary.roster());
      transition = await temporary.receive(message);
      assertTransitionKind(transition, "inbound-commit");
      const senderDeviceId = this.authenticatedCommitSender(transition, before);
      if (senderDeviceId !== expectedSenderDeviceId) {
        throw new SecureRoomEngineError("unauthorized", "commit preview MLS sender does not match its relay sender");
      }
      const after = SecureRoomEngine.normalizeRoster(temporary.roster());
      this.assertStableRoster(before, after, { added: 0, removed: 0 });
      const summary = transition.commitSummary;
      if (
        !summary || summary.addCount !== 0 || summary.removeCount !== 0 ||
        summary.updateCount !== 0 || summary.otherCount !== 0 || !summary.hasUpdatePath
      ) {
        throw new SecureRoomEngineError(
          "transition-invalid",
          "commit preview is not an isolated same-roster update-path commit",
        );
      }
      if (!temporary.isActive() || !after.some((entry) => entry.deviceId === this.deviceId) ||
        transition.epoch !== BigInt(this.durable.lastEpoch) + 1n) {
        throw new SecureRoomEngineError("transition-invalid", "commit preview produced an invalid MLS epoch or lifecycle");
      }
      this.assertLease();
      return { kind: "inbound-commit", epoch: transition.epoch, senderDeviceId };
    } catch (error) {
      throw engineError(error, "transition-invalid", "inbound commit inspection rejected the ciphertext");
    } finally {
      transition?.plaintext?.fill(0);
      transition?.senderIdentity?.fill(0);
      binding.fill(0);
      temporary?.dispose();
    }
  }

  async acknowledgeOutbound(messageId: string): Promise<void> {
    this.assertUsable();
    this.assertLease();
    if (canonicalBase64UrlByteLength(messageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid outbound message id");
    }
    const clearsApplicationRollback = this.durable.pendingApplicationRollback?.messageId === messageId;
    const clearsCommitRollback = this.durable.pendingCommitRollback?.messageId === messageId;
    const pendingCommitSecrets = this.cloneCommitSecrets(this.durable.pendingCommitSecrets);
    const acknowledged = this.acknowledgeOutboxId(this.durable.pendingOutbox, messageId);
    if (!acknowledged.found) throw new SecureRoomEngineError("invalid-input", "outbound message id is not pending");
    if (!acknowledged.changed) return;
    let pendingApplicationRollback = this.durable.pendingApplicationRollback;
    let pendingCommitRollback = this.durable.pendingCommitRollback;
    if (clearsApplicationRollback) {
      const acceptedSecretId = pendingApplicationRollback?.deleteCommitSecretOnAccept ?? null;
      if (acceptedSecretId !== null) delete pendingCommitSecrets[acceptedSecretId];
      pendingApplicationRollback = null;
    } else if (pendingApplicationRollback !== null) {
      const rollbackAcknowledged = this.acknowledgeOutboxId(pendingApplicationRollback.pendingOutbox, messageId);
      if (!rollbackAcknowledged.found) {
        throw new SecureRoomEngineError("state-invalid", "pending application rollback outbox diverged");
      }
      pendingApplicationRollback = {
        ...pendingApplicationRollback,
        applicationState: cloneApplicationState(pendingApplicationRollback.applicationState),
        pendingOutbox: rollbackAcknowledged.outbox,
        pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
          pendingApplicationRollback.pendingRelayControls,
        ),
        processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
          pendingApplicationRollback.processedDeliveries,
        ),
        pendingCommitSecrets: this.cloneCommitSecrets(pendingApplicationRollback.pendingCommitSecrets),
      };
    }
    if (clearsCommitRollback) {
      pendingCommitRollback = null;
    } else if (pendingCommitRollback !== null) {
      const rollbackAcknowledged = this.acknowledgeOutboxId(pendingCommitRollback.pendingOutbox, messageId);
      if (!rollbackAcknowledged.found) {
        throw new SecureRoomEngineError("state-invalid", "pending commit rollback outbox diverged");
      }
      pendingCommitRollback = {
        ...pendingCommitRollback,
        applicationState: cloneApplicationState(pendingCommitRollback.applicationState),
        pendingOutbox: rollbackAcknowledged.outbox,
        pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(pendingCommitRollback.pendingRelayControls),
        processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(pendingCommitRollback.processedDeliveries),
        pendingCommitSecrets: this.cloneCommitSecrets(pendingCommitRollback.pendingCommitSecrets),
      };
    }
    await this.persistDurable(this.nextDurable(undefined, {
      pendingOutbox: acknowledged.outbox,
      pendingCommitSecrets,
      pendingApplicationRollback,
      pendingCommitRollback,
    }));
  }

  async completeAdmission(admissionId: string): Promise<void> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid admission id");
    }
    const pendingOutbox = cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox);
    const index = pendingOutbox.findIndex((entry) => entry.kind === "admission" &&
      entry.admissionId === admissionId && entry.welcomeMessageId !== null);
    const entry = index < 0 ? null : pendingOutbox[index];
    if (
      !entry || entry.kind !== "admission" || !entry.commitAcknowledged || !entry.welcomeAcknowledged ||
      entry.bootstrapMessageId === null ||
      pendingOutbox.some((candidate) => candidate.kind === "application" &&
        candidate.messageId === entry.bootstrapMessageId)
    ) throw new SecureRoomEngineError("transition-invalid", "admission bootstrap has not been acknowledged");
    const barrier = this.durable.pendingRelayControls.find((control) =>
      control.kind === "admission-barrier" && control.admissionId === admissionId &&
      control.deviceId === entry.addedDeviceId);
    if (!barrier) throw new SecureRoomEngineError("state-invalid", "acknowledged bootstrap lost its admission barrier");
    // Keep both the compact admission record and barrier until the relay
    // broadcasts activation. This survives a crash between bootstrap and proof.
  }

  async completeAdmissionLifecycle(
    deviceId: string,
    status: "active" | "retired",
  ): Promise<boolean> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (canonicalBase64UrlByteLength(deviceId) !== SECURE_DEVICE_ID_BYTES ||
        (status !== "active" && status !== "retired")) {
      throw new SecureRoomEngineError("invalid-input", "invalid admission lifecycle completion");
    }
    const pendingRelayControls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    const controlIndex = pendingRelayControls.findIndex((control) =>
      control.kind === "admission-barrier" && control.deviceId === deviceId);
    if (controlIndex < 0) return false;
    const rosterContainsDevice = SecureRoomEngine.normalizeRoster(this.requireSession().roster())
      .some((entry) => entry.deviceId === deviceId);
    if (status === "active") {
      if (!rosterContainsDevice ||
          !this.durable.applicationState.members.some((member) => member.deviceId === deviceId)) {
        throw new SecureRoomEngineError("unauthorized", "relay activated a device before its MLS profile was accepted");
      }
    } else if (rosterContainsDevice) {
      // Relay retirement is not an E2EE boundary. Keep blocking until the exact
      // MLS Remove commit actually erases this leaf.
      return false;
    }
    const barrier = pendingRelayControls[controlIndex];
    if (barrier.kind !== "admission-barrier") throw new SecureRoomEngineError("state-invalid", "admission barrier changed kind");
    pendingRelayControls.splice(controlIndex, 1);
    const pendingOutbox = this.durable.pendingOutbox.filter((entry) => entry.kind !== "admission" || !(
      entry.admissionId === barrier.admissionId &&
      (entry.addedDeviceId === deviceId || entry.welcomeMessageId === null && deviceId === this.deviceId)
    ));
    await this.persistDurable(this.nextDurable(undefined, { pendingOutbox, pendingRelayControls }));
    return true;
  }

  async completeJoinAdmission(admissionId: string): Promise<void> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (canonicalBase64UrlByteLength(admissionId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid join admission id");
    }
    const pendingOutbox = cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox);
    const index = pendingOutbox.findIndex((entry) => entry.kind === "admission" &&
      entry.welcomeMessageId === null && entry.admissionId === admissionId &&
      entry.messageId === admissionId && entry.commitAcknowledged);
    if (index < 0 || !this.durable.applicationState.members.some((member) => member.deviceId === this.deviceId)) {
      throw new SecureRoomEngineError("transition-invalid", "join admission has not completed activation");
    }
    pendingOutbox.splice(index, 1);
    await this.persistDurable(this.nextDurable(undefined, { pendingOutbox }));
  }

  async recordHostTransferAuthorization(offerMessageId: string, authorizationId: string): Promise<void> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (
      canonicalBase64UrlByteLength(offerMessageId) !== SECURE_MESSAGE_ID_BYTES ||
      canonicalBase64UrlByteLength(authorizationId) !== SECURE_MESSAGE_ID_BYTES ||
      offerMessageId === authorizationId
    ) throw new SecureRoomEngineError("invalid-input", "invalid host-transfer authorization binding");
    const pendingRelayControls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    const control = pendingRelayControls.find((candidate) => candidate.kind === "transfer-host" &&
      candidate.targetDeviceId === this.deviceId && candidate.offerMessageId === offerMessageId &&
      candidate.acceptMessageId === null);
    if (!control || control.kind !== "transfer-host") {
      throw new SecureRoomEngineError("transition-invalid", "host-transfer offer context is not pending for this device");
    }
    if (control.authorizationId === authorizationId) return;
    if (control.authorizationId !== null || this.relayControlIds(pendingRelayControls).includes(authorizationId) ||
      this.allOutboxIds(this.durable.pendingOutbox).includes(authorizationId)) {
      throw new SecureRoomEngineError("transition-invalid", "host-transfer authorization id conflicts with durable state");
    }
    control.authorizationId = authorizationId;
    await this.persistDurable(this.nextDurable(undefined, { pendingRelayControls }));
  }

  async renewHostTransferAuthorization(offerMessageId: string): Promise<string> {
    this.assertHost();
    this.assertLease();
    this.assertNoPendingApplication();
    if (canonicalBase64UrlByteLength(offerMessageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid host-transfer offer id");
    }
    const pendingRelayControls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    const control = pendingRelayControls.find((candidate) => candidate.kind === "transfer-host" &&
      candidate.offerMessageId === offerMessageId && candidate.targetDeviceId !== this.deviceId &&
      candidate.authorizationId === null && candidate.acceptMessageId === null);
    if (!control || control.kind !== "transfer-host") {
      throw new SecureRoomEngineError("transition-invalid", "host-transfer offer is not awaiting reauthorization");
    }
    const authorizationId = this.allocateRelayRequestId([offerMessageId]);
    control.authorizationId = authorizationId;
    await this.persistDurable(this.nextDurable(undefined, { pendingRelayControls }));
    return authorizationId;
  }

  async completeRelayControl(completion: SecureRoomRelayControlCompletionV1): Promise<void> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    if (!completion || typeof completion !== "object") {
      throw new SecureRoomEngineError("invalid-input", "invalid relay-control completion");
    }
    if (completion.kind === "room-retired") {
      if (!this.durable.pendingRelayControls.some((control) => control.kind === "close-room")) {
        throw new SecureRoomEngineError("invalid-input", "no room-close control is pending");
      }
      await this.retire();
      return;
    }
    if (completion.kind === "host-transfer-expired") {
      if (canonicalBase64UrlByteLength(completion.authorizationId) !== SECURE_MESSAGE_ID_BYTES) {
        throw new SecureRoomEngineError("invalid-input", "invalid expired host-transfer authorization id");
      }
      const pendingRelayControls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
      const index = pendingRelayControls.findIndex((control) => control.kind === "transfer-host" &&
        control.authorizationId === completion.authorizationId);
      if (index < 0) throw new SecureRoomEngineError("invalid-input", "expired host-transfer authorization is not pending");
      const control = pendingRelayControls[index];
      if (control.kind !== "transfer-host" || control.acceptMessageId !== null) {
        throw new SecureRoomEngineError(
          "transition-invalid",
          "a pending host-transfer acceptance must be rejected before expiring its authorization",
        );
      }
      control.authorizationId = null;
      await this.persistDurable(this.nextDurable(undefined, { pendingRelayControls }));
      return;
    }
    if (canonicalBase64UrlByteLength(completion.deviceId) !== SECURE_DEVICE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid relay-control completion device");
    }
    const pendingRelayControls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    const index = pendingRelayControls.findIndex((control) => completion.kind === "member-lifecycle"
      ? control.kind === "retire-member" && control.deviceId === completion.deviceId
      : control.kind === "transfer-host" && control.targetDeviceId === completion.deviceId);
    if (index < 0) throw new SecureRoomEngineError("invalid-input", "matching relay control is not pending");
    pendingRelayControls.splice(index, 1);
    await this.persistDurable(this.nextDurable(undefined, { pendingRelayControls }));
  }

  async rejectOutbound(messageId: string): Promise<"reverted" | "retired"> {
    this.assertUsable();
    this.assertLease();
    if (canonicalBase64UrlByteLength(messageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid outbound message id");
    }
    const applicationRollback = this.durable.pendingApplicationRollback;
    const commitRollback = this.durable.pendingCommitRollback;
    if (commitRollback?.messageId === messageId) {
      // A membership/update commit advances the MLS epoch. Restoring its prior
      // snapshot would resurrect consumed epoch secrets, so relay rejection is
      // terminal for this local identity. Recovery requires a fresh admission
      // (or recreating the room when this was the host).
      await this.retire();
      return "retired";
    }
    if (applicationRollback?.messageId !== messageId) {
      throw new SecureRoomEngineError("invalid-input", "outbound MLS mutation is not pending or was already accepted");
    }
    const restored: SecureRoomDurableStateV1 = {
      roomInstance: this.roomInstance,
      deviceId: this.deviceId,
      // Keep the post-encryption MLS snapshot/generation. Only deterministic
      // application metadata is reverted, so no sender generation can repeat.
      mlsSnapshot: this.durable.mlsSnapshot.slice(),
      applicationState: cloneApplicationState(applicationRollback.applicationState),
      nextDeviceSequence: applicationRollback.nextDeviceSequence,
      lastEpoch: this.durable.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(applicationRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(applicationRollback.pendingRelayControls),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(applicationRollback.processedDeliveries),
      pendingCommitSecrets: this.cloneCommitSecrets(applicationRollback.pendingCommitSecrets),
      pendingApplicationRollback: null,
      pendingCommitRollback: null,
    };
    await this.persistDurable(restored);
    return "reverted";
  }

  async retire(): Promise<void> {
    this.assertUsable();
    this.assertLease();
    let erased;
    try {
      erased = await this.store.compareAndDeleteOpaqueState(this.storeKey, this.revision);
    } catch (error) {
      await this.recoverFromAuthoritativeState();
      throw engineError(error, "persistence-failed", "terminal secure room state erasure failed");
    }
    if (!erased.erased) {
      await this.recoverFromAuthoritativeState();
      throw new SecureRoomEngineError("revision-conflict", "terminal secure room erasure lost its revision race");
    }
    this.session?.dispose();
    this.session = null;
    this.expectedJoinFounder = null;
    this.retirementBarriers.clear();
    this.retired = true;
  }

  dispose(): void {
    this.session?.dispose();
    this.session = null;
    this.expectedJoinFounder = null;
    this.retirementBarriers.clear();
    this.unavailable = true;
  }

  private async planInboundApplication(
    transition: MlsTransition,
    delivery: SecureRoomRelayDeliveryContext,
    deliveryDigest?: RelayDeliveryDigest | null,
  ): Promise<MutationPlan<SecureRoomReceiveResult>> {
    if (delivery.relayContext.kind === "commit") {
      throw new SecureRoomEngineError("transition-invalid", "application ciphertext was labeled as an MLS commit");
    }
    const expectedAuthorizationId = delivery.relayContext.kind === "host-transfer-accept"
      ? delivery.relayContext.authorizationId
      : undefined;
    const validated = await this.validateInboundApplication(
      transition,
      SecureRoomEngine.normalizeRoster(this.requireSession().roster()),
      expectedAuthorizationId,
    );
    const { senderDeviceId, event, state, effects } = validated;
    if (delivery.fromDeviceId !== senderDeviceId || delivery.logicalOrder !== event.logicalOrder) {
      throw new SecureRoomEngineError(
        delivery.fromDeviceId !== senderDeviceId ? "unauthorized" : "transition-invalid",
        "relay application attribution does not match its authenticated MLS event",
      );
    }
    this.assertInboundApplicationRelayMatch(event, senderDeviceId, delivery.relayContext);
    const pendingRelayControls = this.planInboundRelayControls(
      event,
      senderDeviceId,
      delivery.messageId,
      effects,
    );
    const durable = this.nextDurable(transition, {
      applicationState: state,
      pendingRelayControls,
      ...(deliveryDigest && {
        processedDeliveries: this.appendProcessedDelivery(deliveryDigest.messageId, deliveryDigest.digest),
      }),
    });
    return {
      durable,
      result: () => ({
        kind: "inbound-application",
        epoch: transition.epoch,
        relayMessageId: delivery.messageId,
        senderDeviceId,
        event: JSON.parse(canonicalJsonV4(event)) as SecureApplicationEventV4,
        state: cloneApplicationState(state),
        effects: [...effects],
      }),
    };
  }

  private async validateInboundApplication(
    transition: MlsTransition,
    roster: NormalizedRosterEntry[],
    expectedHostTransferAuthorizationId?: string,
  ): Promise<{
    senderDeviceId: string;
    event: SecureApplicationEventV4;
    state: SecureRoomStateSnapshotV4;
    effects: SecureReducerEffectV4[];
  }> {
    let plaintext: Uint8Array | null = null;
    let senderIdentity: Uint8Array | null = null;
    try {
      plaintext = copyBytes(transition.plaintext, "decrypted application plaintext");
      senderIdentity = copyBytes(transition.senderIdentity, "application sender identity");
      if (senderIdentity.byteLength !== SECURE_DEVICE_ID_BYTES) {
        throw new SecureRoomEngineError("transition-invalid", "MLS application sender identity has an invalid length");
      }
      const senderDeviceId = this.encodeCanonicalId(senderIdentity);
      const sender = roster.find((entry) => entry.deviceId === senderDeviceId);
      if (!sender || (transition.senderLeafIndex !== undefined && sender.leafIndex !== transition.senderLeafIndex)) {
        throw new SecureRoomEngineError("transition-invalid", "MLS application sender is absent from the authenticated roster");
      }
      const event = messageEventFromPlaintext(plaintext, this.roomInstance);
      if (event.deviceId !== senderDeviceId) {
        throw new SecureRoomEngineError("transition-invalid", "signed event device does not match the MLS sender identity");
      }
      const membership = this.membershipForEvent(event, roster);
      const signer = membership.find((entry) => entry.deviceId === senderDeviceId);
      if (!signer || signer.signaturePublicKey !== sender.signaturePublicKey) {
        throw new SecureRoomEngineError("transition-invalid", "signed event key does not match the MLS credential");
      }
      const signedAuthorizationId = event.content.type === "host-transfer" &&
        event.content.action === "accept" ? event.content.authorizationId : undefined;
      if (signedAuthorizationId !== expectedHostTransferAuthorizationId) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "signed host-transfer authorization does not match the relay capability",
        );
      }
      const reduced = await reduceSecureRoomEventV4(this.durable.applicationState, event, membership);
      if (!reduced.ok) {
        throw new SecureRoomEngineError("transition-invalid", `inbound application event was rejected: ${reduced.code}`);
      }
      return { senderDeviceId, event, state: reduced.state, effects: [...reduced.effects] };
    } finally {
      plaintext?.fill(0);
      senderIdentity?.fill(0);
    }
  }

  private assertInboundApplicationRelayMatch(
    event: SecureApplicationEventV4,
    senderDeviceId: string,
    relayContext: Exclude<SecureRoomInboundRelayContext, { kind: "commit" }>,
  ): void {
    const content = event.content;
    const currentMember = this.durable.applicationState.members.some((member) => member.deviceId === senderDeviceId);
    const contextMatches = relayContext.kind === "bootstrap"
      ? content.type === "state-snapshot"
      : relayContext.kind === "join-proof"
        ? content.type === "member-profile" && !currentMember
        : relayContext.kind === "host-transfer-accept"
          ? content.type === "host-transfer" && content.action === "accept" &&
            content.authorizationId === relayContext.authorizationId
          : content.type !== "state-snapshot" &&
            !(content.type === "member-profile" && !currentMember) &&
            !(content.type === "host-transfer" && content.action === "accept");
    if (!contextMatches) {
      throw new SecureRoomEngineError("unauthorized", "signed application does not match its authenticated relay variant");
    }
    if (relayContext.kind === "bootstrap" &&
        this.durable.applicationState.hostDeviceId === null && this.durable.applicationState.members.length === 0) {
      const expectedFounder = this.expectedJoinFounder;
      if (!expectedFounder || senderDeviceId !== expectedFounder.deviceId) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "bootstrap signer is not the invitation-authorized founder",
        );
      }
      this.assertExpectedFounderInRoster(SecureRoomEngine.normalizeRoster(this.requireSession().roster()));
      const retained = this.durable.pendingOutbox.find((entry) => entry.kind === "admission" &&
        entry.welcomeMessageId === null && entry.admissionId === relayContext.admissionId);
      if (!retained || retained.kind !== "admission" ||
          retained.joinWelcomeMessageId !== relayContext.welcomeMessageId) {
        throw new SecureRoomEngineError("unauthorized", "bootstrap does not match the Welcome consumed by this admission");
      }
    }
  }

  private async planInboundCommit(
    transition: MlsTransition,
    before: NormalizedRosterEntry[],
    delivery: SecureRoomRelayDeliveryContext,
    deliveryDigest?: RelayDeliveryDigest | null,
  ): Promise<MutationPlan<SecureRoomReceiveResult>> {
    const senderDeviceId = this.authenticatedCommitSender(transition, before);
    if (delivery.relayContext.kind !== "commit" || delivery.fromDeviceId !== senderDeviceId || delivery.logicalOrder !== null) {
      throw new SecureRoomEngineError(
        delivery.fromDeviceId !== senderDeviceId ? "unauthorized" : "transition-invalid",
        "relay commit attribution does not match its authenticated MLS commit",
      );
    }
    const after = SecureRoomEngine.normalizeRoster(this.requireSession().roster());
    this.assertCommonCredentialKeysStable(before, after);
    const summary = transition.commitSummary;
    if (!summary || [summary.addCount, summary.removeCount, summary.updateCount, summary.otherCount].some(
      (count) => !Number.isInteger(count) || count < 0,
    )) {
      throw new SecureRoomEngineError("transition-invalid", "MLS commit omitted its authenticated proposal summary");
    }
    if (summary.updateCount !== 0 || summary.otherCount !== 0 || !summary.hasUpdatePath) {
      throw new SecureRoomEngineError("transition-invalid", "MLS commit contains unsupported proposals or no update path");
    }
    const beforeIds = new Set(before.map((entry) => entry.deviceId));
    const afterIds = new Set(after.map((entry) => entry.deviceId));
    const addedDeviceIds = [...afterIds].filter((deviceId) => !beforeIds.has(deviceId));
    const removedDeviceIds = [...beforeIds].filter((deviceId) => !afterIds.has(deviceId));
    const membershipChanged = beforeIds.size !== afterIds.size ||
      [...beforeIds].some((deviceId) => !afterIds.has(deviceId));
    if (!membershipChanged && this.durable.applicationState.pendingRemovalDeviceIds.length !== 0) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "same-roster MLS commits are blocked until the signed member removal completes",
      );
    }
    let applicationState = this.durable.applicationState;
    let effects: SecureReducerEffectV4[] = [];
    let pendingOutbox = cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox);
    let pendingRelayControls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    if (membershipChanged) {
      const exactlyOneAdd = summary.addCount === 1 && summary.removeCount === 0 &&
        after.length === before.length + 1;
      const exactlyOneRemove = summary.addCount === 0 && summary.removeCount === 1 &&
        after.length === before.length - 1;
      if (!exactlyOneAdd && !exactlyOneRemove) {
        throw new SecureRoomEngineError("transition-invalid", "MLS membership commit does not match one authorized roster delta");
      }
      if (exactlyOneAdd && (delivery.relayContext.admissionId === undefined ||
          delivery.relayContext.retirementDeviceId !== undefined)) {
        throw new SecureRoomEngineError("unauthorized", "MLS Add commit omitted or conflicted with its admission binding");
      }
      if (exactlyOneAdd) {
        const addedDeviceId = addedDeviceIds[0];
        if (!addedDeviceId) {
          throw new SecureRoomEngineError("transition-invalid", "MLS Add commit omitted its exact roster addition");
        }
        pendingRelayControls = this.appendPendingRelayControl({
          kind: "admission-barrier",
          admissionId: delivery.relayContext.admissionId!,
          deviceId: addedDeviceId,
        }, pendingRelayControls);
        applicationState = bindMembershipAdmission(
          applicationState,
          addedDeviceId,
          delivery.relayContext.admissionId!,
        );
      }
      if (exactlyOneRemove) {
        const removedDeviceId = removedDeviceIds[0];
        const retirementDeviceId = delivery.relayContext.retirementDeviceId;
        const hasRetirementBarrier = retirementDeviceId !== undefined;
        if (hasRetirementBarrier
          ? retirementDeviceId !== removedDeviceId ||
            delivery.relayContext.retirementAdmissionCommitMessageId === undefined
          : delivery.relayContext.admissionId !== undefined ||
            this.durable.applicationState.pendingRemovalDeviceIds[0] !== removedDeviceId) {
          throw new SecureRoomEngineError(
            "unauthorized",
            "MLS Remove commit does not match its signed request or exact relay retirement target",
          );
        }
        if (hasRetirementBarrier) {
          this.assertCurrentRetirementBarrier({
            deviceId: retirementDeviceId,
            admissionCommitMessageId: delivery.relayContext.retirementAdmissionCommitMessageId!,
          });
        } else if (this.retirementBarriers.size !== 0) {
          throw new SecureRoomEngineError(
            "unauthorized",
            "signed member removal cannot bypass a pending relay retirement barrier",
          );
        }
        pendingRelayControls = pendingRelayControls.filter((control) =>
          control.kind !== "admission-barrier" || control.deviceId !== removedDeviceId);
        pendingOutbox = pendingOutbox.filter((entry) =>
          entry.kind !== "admission" || entry.addedDeviceId !== removedDeviceId);
      }
      if (exactlyOneAdd && this.admissionBlockedByApplicationState()) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "MLS add commit arrived during a game or pending host transfer",
        );
      }
      if (senderDeviceId !== this.durable.applicationState.hostDeviceId) {
        throw new SecureRoomEngineError("unauthorized", "only the current host may commit MLS roster changes");
      }
      const reconciled = reconcileSecureRoomMembershipV4(applicationState, this.knownMembership(after));
      if (!reconciled.ok) {
        throw new SecureRoomEngineError("transition-invalid", `application membership reconciliation failed: ${reconciled.code}`);
      }
      applicationState = reconciled.state;
      effects = [...reconciled.effects];
    } else if (summary.addCount !== 0 || summary.removeCount !== 0) {
      throw new SecureRoomEngineError("transition-invalid", "MLS commit proposal summary does not match its roster");
    } else if (delivery.relayContext.admissionId !== undefined ||
        delivery.relayContext.retirementDeviceId !== undefined) {
      throw new SecureRoomEngineError("unauthorized", "self-update commit carried a membership-change binding");
    }
    const ownWasRemoved = !afterIds.has(this.deviceId) || !this.requireSession().isActive();
    const consumedRetirementBarrier = delivery.relayContext.kind === "commit" &&
      delivery.relayContext.retirementDeviceId !== undefined
      ? {
          deviceId: delivery.relayContext.retirementDeviceId,
          admissionCommitMessageId: delivery.relayContext.retirementAdmissionCommitMessageId!,
        }
      : null;
    const durable = this.nextDurable(transition, {
      applicationState,
      pendingOutbox,
      pendingRelayControls,
      ...(deliveryDigest && {
        processedDeliveries: this.appendProcessedDelivery(deliveryDigest.messageId, deliveryDigest.digest),
      }),
      ...(ownWasRemoved && { nextDeviceSequence: 1 }),
    });
    return {
      durable,
      retireAfterCommit: ownWasRemoved,
      result: () => {
        if (consumedRetirementBarrier) {
          this.retirementBarriers.delete(consumedRetirementBarrier.deviceId);
        }
        return {
          kind: "inbound-commit",
          epoch: transition.epoch,
          relayMessageId: delivery.messageId,
          senderDeviceId,
          state: cloneApplicationState(applicationState),
          effects,
          retired: ownWasRemoved,
        };
      },
    };
  }

  private async runMlsMutation<T>(
    operation: () => Promise<MlsTransition>,
    plan: (transition: MlsTransition) => Promise<MutationPlan<T>>,
  ): Promise<T> {
    this.assertUsable();
    this.assertLease();
    this.assertNoPendingApplication();
    const priorEpoch = BigInt(this.durable.lastEpoch);
    let transition: MlsTransition;
    try {
      transition = await operation();
    } catch (error) {
      await this.recoverFromAuthoritativeState();
      throw engineError(error, "transition-invalid", "MLS transition failed and was rolled back");
    }
    try {
      let prepared: MutationPlan<T>;
      try {
        this.assertLease();
        prepared = await plan(transition);
        this.assertTransitionEpoch(transition, priorEpoch);
      } catch (error) {
        await this.recoverFromAuthoritativeState();
        throw engineError(error, "transition-invalid", "MLS transition validation failed and was rolled back");
      }
      if (prepared.retireAfterCommit) {
        // Terminal self-removal must not persist a secret-bearing intermediate
        // snapshot. The CAS delete is the commit boundary, so a crash can leave
        // either the prior usable state or no state, never a removed zombie.
        await this.retire();
      } else {
        await this.persistDurable(prepared.durable);
      }
      return prepared.result();
    } finally {
      transition.plaintext?.fill(0);
      transition.senderIdentity?.fill(0);
      transition.snapshot.fill(0);
      transition.outbound?.fill(0);
      transition.welcome?.fill(0);
      transition.ratchetTree?.fill(0);
    }
  }

  private async persistDurable(next: SecureRoomDurableStateV1): Promise<void> {
    this.assertLease();
    let wrapped: Uint8Array;
    try {
      wrapped = await protectSecureRoomStateV1(next, this.roomSecret);
      this.assertLease();
    } catch (error) {
      await this.recoverFromAuthoritativeState();
      throw engineError(error, "state-invalid", "secure room state serialization failed");
    }
    try {
      const result = await this.store.compareAndSetOpaqueState(this.storeKey, this.revision, wrapped);
      if (!result.committed) {
        await this.recoverFromAuthoritativeState();
        throw new SecureRoomEngineError("revision-conflict", "secure room state revision changed unexpectedly");
      }
      if (!this.lease.isActive() || this.lease.signal.aborted) {
        this.session?.dispose();
        this.session = null;
        this.unavailable = true;
        throw new SecureRoomEngineError("lock-required", "secure room lock was lost during persistence");
      }
      this.durable = cloneSecureRoomDurableStateV1(next);
      this.revision = result.revision;
    } catch (error) {
      if (!(error instanceof SecureRoomEngineError && error.code === "lock-required") && !this.unavailable) {
        await this.recoverFromAuthoritativeState();
      }
      throw engineError(error, "persistence-failed", "secure room state persistence failed");
    }
  }

  private async recoverFromAuthoritativeState(): Promise<void> {
    this.session?.dispose();
    this.session = null;
    try {
      if (!this.lease.isActive() || this.lease.signal.aborted) throw new Error("room lock is no longer active");
      const record: OpaqueCryptoStateSnapshot | null = await this.store.loadOpaqueState(this.storeKey);
      if (!record) throw new Error("durable secure room state is absent");
      const durable = await unprotectSecureRoomStateV1(record.state, this.roomInstance, this.roomSecret);
      const binding = decodeCanonicalBase64UrlV4(this.roomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES)!;
      let session: MlsCryptoSession;
      try {
        session = await MlsCryptoSession.restore({ roomBinding: binding, roomSecret: this.roomSecret, snapshot: durable.mlsSnapshot });
      } finally {
        binding.fill(0);
      }
      this.session = session;
      this.durable = durable;
      this.revision = record.revision;
      this.provisional = record.lifecycle === "provisional";
      this.authenticationAmbiguous = record.lifecycle === "authentication-ambiguous";
      this.unavailable = false;
    } catch {
      this.unavailable = true;
    }
  }

  private nextDurable(
    transition?: MlsTransition,
    changes: Partial<Omit<SecureRoomDurableStateV1, "roomInstance" | "deviceId">> = {},
  ): SecureRoomDurableStateV1 {
    const changedRollback = Object.prototype.hasOwnProperty.call(changes, "pendingApplicationRollback")
      ? changes.pendingApplicationRollback ?? null
      : this.durable.pendingApplicationRollback;
    const changedCommitRollback = Object.prototype.hasOwnProperty.call(changes, "pendingCommitRollback")
      ? changes.pendingCommitRollback ?? null
      : this.durable.pendingCommitRollback;
    const applicationState = cloneDurableApplicationState(changes.applicationState ?? this.durable.applicationState);
    const pendingApplicationRollback = changedRollback === null ? null : {
      messageId: changedRollback.messageId,
      applicationState: cloneDurableApplicationState(changedRollback.applicationState),
      nextDeviceSequence: changedRollback.nextDeviceSequence,
      lastEpoch: changedRollback.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(changedRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(changedRollback.pendingRelayControls),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(changedRollback.processedDeliveries),
      pendingCommitSecrets: this.cloneCommitSecrets(changedRollback.pendingCommitSecrets),
      deleteCommitSecretOnAccept: changedRollback.deleteCommitSecretOnAccept,
    };
    const pendingCommitRollback = changedCommitRollback === null ? null : {
      messageId: changedCommitRollback.messageId,
      applicationState: cloneDurableApplicationState(changedCommitRollback.applicationState),
      nextDeviceSequence: changedCommitRollback.nextDeviceSequence,
      lastEpoch: changedCommitRollback.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(changedCommitRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(changedCommitRollback.pendingRelayControls),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(changedCommitRollback.processedDeliveries),
      pendingCommitSecrets: this.cloneCommitSecrets(changedCommitRollback.pendingCommitSecrets),
    };
    const pendingCommitSecrets = this.cloneCommitSecrets(
      changes.pendingCommitSecrets ?? this.durable.pendingCommitSecrets,
    );
    for (const [gameId, secret] of Object.entries(pendingCommitSecrets)) {
      if (
        !this.commitSecretMatchesApplication(secret, applicationState) &&
        (!pendingApplicationRollback ||
          !this.commitSecretMatchesApplication(secret, pendingApplicationRollback.applicationState))
      ) delete pendingCommitSecrets[gameId];
    }
    return {
      roomInstance: this.durable.roomInstance,
      deviceId: this.durable.deviceId,
      mlsSnapshot: changes.mlsSnapshot?.slice() ?? transition?.snapshot.slice() ?? this.durable.mlsSnapshot.slice(),
      applicationState,
      nextDeviceSequence: changes.nextDeviceSequence ?? this.durable.nextDeviceSequence,
      lastEpoch: changes.lastEpoch ?? transition?.epoch.toString(10) ?? this.durable.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(changes.pendingOutbox ?? this.durable.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
        changes.pendingRelayControls ?? this.durable.pendingRelayControls,
      ),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
        changes.processedDeliveries ?? this.durable.processedDeliveries,
      ),
      pendingCommitSecrets,
      pendingApplicationRollback,
      pendingCommitRollback,
    };
  }

  private assertTransitionEpoch(transition: MlsTransition, priorEpoch: bigint): void {
    const sameEpoch = transition.kind === "key-package" ||
      transition.kind === "outbound-application" || transition.kind === "inbound-application" ||
      transition.kind === "inbound-proposal";
    const nextEpoch = transition.kind === "add" || transition.kind === "remove" ||
      transition.kind === "self-update" || transition.kind === "inbound-commit";
    const valid = sameEpoch
      ? transition.epoch === priorEpoch
      : nextEpoch
        ? transition.epoch === priorEpoch + 1n
        : transition.kind === "join" && transition.epoch > priorEpoch;
    if (!valid) {
      throw new SecureRoomEngineError(
        "transition-invalid",
        "MLS transition epoch does not match its authenticated operation boundary",
      );
    }
  }

  private assertHost(): void {
    this.assertUsable();
    if (!this.requireSession().isActive() || this.durable.applicationState.hostDeviceId !== this.deviceId) {
      throw new SecureRoomEngineError("unauthorized", "only the current host may change MLS membership");
    }
  }

  private assertNoPendingApplication(): void {
    if (this.durable.pendingApplicationRollback !== null || this.durable.pendingCommitRollback !== null) {
      throw new SecureRoomEngineError(
        "transition-invalid",
        "the pending outbound MLS mutation must be accepted or rejected before another transition",
      );
    }
  }

  private parseRetirementBarrier(value: SecureRoomRetirementBarrierV4): SecureRoomRetirementBarrierV4 {
    if (!isPlainDataRecord(value) || Reflect.ownKeys(value).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(value, "deviceId") ||
        !Object.prototype.hasOwnProperty.call(value, "admissionCommitMessageId") ||
        canonicalBase64UrlByteLength(value.deviceId) !== SECURE_DEVICE_ID_BYTES ||
        canonicalBase64UrlByteLength(value.admissionCommitMessageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid exact relay retirement barrier");
    }
    return {
      deviceId: value.deviceId,
      admissionCommitMessageId: value.admissionCommitMessageId,
    };
  }

  private assertNoMembershipBarrier(): void {
    if (this.retirementBarriers.size !== 0 || this.pendingAdmissionBarrier !== null ||
        this.durable.applicationState.pendingRemovalDeviceIds.length !== 0) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "only the exact membership transition is allowed while an MLS membership barrier is pending",
      );
    }
  }

  private assertOutboundApplicationAllowedDuringBarriers(
    relayContext: SecureRoomApplicationRelayContextV1,
  ): void {
    if (this.retirementBarriers.size !== 0 ||
        this.durable.applicationState.pendingRemovalDeviceIds.length !== 0) {
      throw new SecureRoomEngineError("unauthorized", "application encryption is blocked until MLS removal completes");
    }
    const admission = this.pendingAdmissionBarrier;
    if (!admission) return;
    const allowed = relayContext.kind === "bootstrap"
      ? relayContext.admissionId === admission.admissionId &&
        this.durable.applicationState.hostDeviceId === this.deviceId && admission.deviceId !== this.deviceId
      : relayContext.kind === "join-proof" && relayContext.admissionId === admission.admissionId &&
        admission.deviceId === this.deviceId;
    if (!allowed) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "only the exact bootstrap or join proof may encrypt while admission is pending",
      );
    }
  }

  private assertCurrentRetirementBarrier(barrierValue: SecureRoomRetirementBarrierV4): void {
    const barrier = this.parseRetirementBarrier(barrierValue);
    const current = this.retirementBarriers.entries().next().value as [string, string] | undefined;
    if (!current || current[0] !== barrier.deviceId || current[1] !== barrier.admissionCommitMessageId) {
      throw new SecureRoomEngineError("unauthorized", "MLS removal does not match the FIFO relay retirement barrier");
    }
  }

  private assertInboundAllowedDuringMembershipBarrier(
    relayContext: SecureRoomInboundRelayContext,
    fromDeviceId: string,
  ): void {
    const current = this.retirementBarriers.entries().next().value as [string, string] | undefined;
    if (current) {
      if (relayContext.kind !== "commit" || relayContext.admissionId !== undefined ||
          relayContext.retirementDeviceId !== current[0] ||
          relayContext.retirementAdmissionCommitMessageId !== current[1]) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "encrypted traffic attempted to bypass the current relay retirement barrier",
        );
      }
      return;
    }
    if (relayContext.kind === "commit" && relayContext.retirementDeviceId !== undefined) {
      throw new SecureRoomEngineError("unauthorized", "relay supplied an unregistered retirement commit binding");
    }
    if (this.durable.applicationState.pendingRemovalDeviceIds.length !== 0) {
      if (relayContext.kind !== "commit" || relayContext.admissionId !== undefined) {
        throw new SecureRoomEngineError(
          "unauthorized",
          "encrypted traffic attempted to bypass a signed MLS removal barrier",
        );
      }
      return;
    }
    this.assertInboundApplicationAllowedDuringMembershipBarrier(relayContext, fromDeviceId);
    if (this.pendingAdmissionBarrier !== null && relayContext.kind === "commit") {
      throw new SecureRoomEngineError(
        "unauthorized",
        "MLS commits are blocked while an admission is pending activation",
      );
    }
  }

  private assertInboundApplicationAllowedDuringMembershipBarrier(
    relayContext: SecureRoomInboundRelayContext,
    fromDeviceId: string,
  ): void {
    if (relayContext.kind === "commit") return;
    if (this.retirementBarriers.size !== 0 ||
        this.durable.applicationState.pendingRemovalDeviceIds.length !== 0) {
      throw new SecureRoomEngineError("unauthorized", "application traffic is blocked until MLS removal completes");
    }
    const admission = this.pendingAdmissionBarrier;
    if (!admission) return;
    const expectedBootstrapSender = this.durable.applicationState.hostDeviceId ??
      this.expectedJoinFounder?.deviceId ?? null;
    const allowed = relayContext.kind === "bootstrap"
      ? relayContext.admissionId === admission.admissionId &&
        fromDeviceId === expectedBootstrapSender
      : relayContext.kind === "join-proof" && relayContext.admissionId === admission.admissionId &&
        fromDeviceId === admission.deviceId;
    if (!allowed) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "ordinary application traffic is blocked while admission is pending activation",
      );
    }
  }

  private createPendingCommitRollback(messageId: string) {
    return {
      messageId,
      applicationState: cloneApplicationState(this.durable.applicationState),
      nextDeviceSequence: this.durable.nextDeviceSequence,
      lastEpoch: this.durable.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(this.durable.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(this.durable.processedDeliveries),
      pendingCommitSecrets: this.cloneCommitSecrets(this.durable.pendingCommitSecrets),
    };
  }

  private async digestRelayDelivery(
    messageId: string,
    bytes: Uint8Array,
    attribution?: Pick<
      SecureRoomRelayDeliveryContext,
      "fromDeviceId" | "logicalOrder" | "relayContext"
    >,
  ): Promise<RelayDeliveryDigest> {
    if (canonicalBase64UrlByteLength(messageId) !== SECURE_MESSAGE_ID_BYTES ||
      !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_MLS_RELAY_PAYLOAD_BYTES) {
      throw new SecureRoomEngineError("invalid-input", "invalid bounded relay delivery");
    }
    const domain = UTF8.encode(`pillowfort:relay-delivery:v4\0${this.roomInstance}\0${canonicalJsonV4(
      attribution === undefined
        ? { kind: "welcome" }
          : {
            kind: "group",
            fromDeviceId: attribution.fromDeviceId,
            logicalOrder: attribution.logicalOrder,
            relayContext: attribution.relayContext,
          },
    )}\0`);
    const material = new Uint8Array(domain.byteLength + bytes.byteLength);
    material.set(domain);
    material.set(bytes, domain.byteLength);
    let digestBytes: Uint8Array;
    try {
      digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
    } catch (error) {
      throw engineError(error, "state-invalid", "relay delivery digest failed");
    } finally {
      material.fill(0);
    }
    const digest = this.encodeBase64Url(digestBytes);
    digestBytes.fill(0);
    const existing = this.durable.processedDeliveries.find((delivery) => delivery.messageId === messageId);
    if (existing && existing.digest !== digest) {
      throw new SecureRoomEngineError("transition-invalid", "relay reused a processed message id for different ciphertext");
    }
    return { messageId, digest, alreadyProcessed: existing !== undefined };
  }

  private appendProcessedDelivery(messageId: string, digest: string) {
    const processed = cloneSecureRoomProcessedDeliveriesV1(this.durable.processedDeliveries);
    const existing = processed.find((delivery) => delivery.messageId === messageId);
    if (existing) {
      if (existing.digest !== digest) throw new SecureRoomEngineError("state-invalid", "processed relay digest diverged");
      return processed;
    }
    processed.push({ messageId, digest });
    if (processed.length > MAX_SECURE_ROOM_PROCESSED_DELIVERIES) processed.shift();
    return processed;
  }

  private allOutboxIds(outbox: readonly SecureRoomPendingOutboxEntryV1[]): string[] {
    return outbox.flatMap((entry) => {
      const grantIds = entry.grant === null || entry.grant === undefined
        ? []
        : [entry.grant.requestId, entry.grant.tokenId];
      if (entry.kind !== "admission") return [entry.messageId, ...grantIds];
      if (entry.welcomeMessageId === null) {
        return [entry.messageId, ...(entry.joinWelcomeMessageId === null ? [] : [entry.joinWelcomeMessageId])];
      }
      return [
        entry.admissionId,
        entry.messageId,
        entry.welcomeMessageId,
        ...(entry.bootstrapMessageId === null ? [] : [entry.bootstrapMessageId]),
        ...grantIds,
      ];
    });
  }

  private pendingOutboxIds(outbox: readonly SecureRoomPendingOutboxEntryV1[]): string[] {
    return outbox.flatMap((entry) => {
      if (entry.kind !== "admission") return [entry.messageId];
      if (entry.welcomeMessageId === null) return entry.commitAcknowledged ? [] : [entry.messageId];
      if (entry.welcomeAcknowledged) return [];
      return entry.commitAcknowledged ? [entry.welcomeMessageId] : [entry.messageId, entry.welcomeMessageId];
    });
  }

  private appendPendingOutbox(
    entry: SecureRoomPendingOutboxEntryV1,
    base: readonly SecureRoomPendingOutboxEntryV1[] = this.durable.pendingOutbox,
  ): SecureRoomPendingOutboxEntryV1[] {
    const pendingOutbox = cloneSecureRoomPendingOutboxV1(base);
    if (pendingOutbox.length >= MAX_SECURE_ROOM_PENDING_OUTBOX_ENTRIES) {
      throw new SecureRoomEngineError("pending-saturated", "outbound acknowledgements are required before sending more data");
    }
    const existingIds = new Set(this.allOutboxIds(pendingOutbox));
    const grantIds = entry.grant === null || entry.grant === undefined
      ? []
      : [entry.grant.requestId, entry.grant.tokenId];
    const newIds = entry.kind === "admission"
      ? entry.welcomeMessageId === null
        ? [entry.messageId]
        : [
            entry.admissionId,
            entry.messageId,
            entry.welcomeMessageId,
            ...(entry.bootstrapMessageId === null ? [] : [entry.bootstrapMessageId]),
            ...grantIds,
          ]
      : [entry.messageId, ...grantIds];
    const joinRelayContext = entry.kind === "application" && entry.relayContext.kind === "join-proof"
      ? entry.relayContext
      : null;
    const retainedJoinAdmissionId = joinRelayContext !== null &&
      entry.kind === "application" && entry.grant.requestId === joinRelayContext.admissionId &&
      pendingOutbox.some((candidate) => candidate.kind === "admission" &&
        candidate.welcomeMessageId === null && candidate.commitAcknowledged &&
        candidate.admissionId === joinRelayContext.admissionId)
      ? joinRelayContext.admissionId
      : null;
    if (new Set(newIds).size !== newIds.length ||
        newIds.some((id) => existingIds.has(id) && id !== retainedJoinAdmissionId)) {
      throw new SecureRoomEngineError("state-invalid", "pending outbox message id collided");
    }
    pendingOutbox.push(...cloneSecureRoomPendingOutboxV1([entry]));
    const totalBytes = pendingOutbox.reduce((total, candidate) => total + candidate.outbound.byteLength +
      (candidate.kind === "admission"
        ? (candidate.welcome?.byteLength ?? 0) + (candidate.ratchetTree?.byteLength ?? 0)
        : 0), 0);
    if (totalBytes > MAX_SECURE_ROOM_PENDING_OUTBOX_BYTES) {
      throw new SecureRoomEngineError("pending-saturated", "pending outbound cryptographic artifacts exceed their byte limit");
    }
    return pendingOutbox;
  }

  private relayControlIds(controls: readonly SecureRoomPendingRelayControlV1[]): string[] {
    return controls.flatMap((control) => {
      if (control.kind === "admission-barrier") return [control.admissionId, control.deviceId];
      if (control.kind === "retire-member") {
        return [control.requestId, control.deviceId, control.commitMessageId];
      }
      if (control.kind === "close-room") return [control.requestId, control.authorizationMessageId];
      return [
        control.targetDeviceId,
        control.offerMessageId,
        ...(control.authorizationId === null ? [] : [control.authorizationId]),
        ...(control.acceptMessageId === null ? [] : [control.acceptMessageId]),
      ];
    });
  }

  private appendPendingRelayControl(
    control: SecureRoomPendingRelayControlV1,
    base: readonly SecureRoomPendingRelayControlV1[] = this.durable.pendingRelayControls,
  ): SecureRoomPendingRelayControlV1[] {
    const controls = cloneSecureRoomPendingRelayControlsV1(base);
    if (controls.length >= MAX_SECURE_ROOM_PENDING_RELAY_CONTROLS) {
      throw new SecureRoomEngineError("pending-saturated", "pending relay-control ledger is saturated");
    }
    if (control.kind === "close-room" && controls.some((candidate) => candidate.kind === "close-room") ||
        control.kind === "admission-barrier" && controls.some((candidate) => candidate.kind === "admission-barrier") ||
        control.kind === "transfer-host" && controls.some((candidate) => candidate.kind === "transfer-host") ||
        control.kind === "retire-member" && controls.some((candidate) =>
          candidate.kind === "retire-member" && candidate.deviceId === control.deviceId)) {
      throw new SecureRoomEngineError("transition-invalid", "equivalent relay control is already pending");
    }
    controls.push({ ...control });
    return controls;
  }

  private planOutboundRelayControls(
    content: SecureApplicationContentV4,
    messageId: string,
    effects: readonly SecureReducerEffectV4[],
  ): SecureRoomPendingRelayControlV1[] {
    let controls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    if (content.type === "room-close") {
      const requestId = this.allocateRelayRequestId([messageId]);
      return this.appendPendingRelayControl({
        kind: "close-room",
        requestId,
        authorizationMessageId: messageId,
      }, controls);
    }
    if (effects.some((effect) => effect.type === "room-closed") &&
        this.durable.applicationState.hostDeviceId === this.deviceId) {
      const requestId = this.allocateRelayRequestId([messageId]);
      return this.appendPendingRelayControl({
        kind: "close-room",
        requestId,
        authorizationMessageId: messageId,
      }, controls);
    }
    if (content.type === "pillow-toss" ||
        (content.type === "host-transfer" && content.action === "offer")) {
      const authorizationId = this.allocateRelayRequestId([messageId]);
      return this.appendPendingRelayControl({
        kind: "transfer-host",
        authorizationId,
        targetDeviceId: content.targetDeviceId,
        offerMessageId: messageId,
        acceptMessageId: null,
      }, controls);
    }
    if (content.type === "host-transfer" && content.action === "accept") {
      const index = controls.findIndex((control) => control.kind === "transfer-host" &&
        control.targetDeviceId === this.deviceId && control.acceptMessageId === null &&
        control.authorizationId === content.authorizationId);
      if (index < 0 || controls[index].kind !== "transfer-host") {
        throw new SecureRoomEngineError(
          "transition-invalid",
          "host-transfer acceptance does not match its durable relay authorization",
        );
      }
      controls[index] = { ...controls[index], acceptMessageId: messageId } as SecureRoomPendingRelayControlV1;
    } else if (content.type === "host-transfer" && content.action === "reject") {
      const index = controls.findIndex((control) => control.kind === "transfer-host" &&
        control.targetDeviceId === this.deviceId && control.acceptMessageId === null);
      if (index < 0) throw new SecureRoomEngineError("transition-invalid", "host-transfer rejection has no durable offer context");
      controls.splice(index, 1);
    }
    return controls;
  }

  private planInboundRelayControls(
    event: SecureApplicationEventV4,
    senderDeviceId: string,
    relayMessageId?: string,
    effects: readonly SecureReducerEffectV4[] = [],
  ): SecureRoomPendingRelayControlV1[] {
    const content = event.content;
    let controls = cloneSecureRoomPendingRelayControlsV1(this.durable.pendingRelayControls);
    if (effects.some((effect) => effect.type === "room-closed") &&
        this.durable.applicationState.hostDeviceId === this.deviceId) {
      if (relayMessageId === undefined) {
        throw new SecureRoomEngineError("transition-invalid", "terminal room event omitted its relay message id");
      }
      const requestId = this.allocateRelayRequestId([relayMessageId]);
      controls = this.appendPendingRelayControl({
        kind: "close-room",
        requestId,
        authorizationMessageId: relayMessageId,
      }, controls);
    }
    const isOffer = content.type === "pillow-toss" ||
      (content.type === "host-transfer" && content.action === "offer");
    if (isOffer && content.targetDeviceId === this.deviceId) {
      if (relayMessageId === undefined) {
        throw new SecureRoomEngineError("transition-invalid", "host-transfer offer omitted its relay message id");
      }
      controls = this.appendPendingRelayControl({
        kind: "transfer-host",
        authorizationId: null,
        targetDeviceId: this.deviceId,
        offerMessageId: relayMessageId,
        acceptMessageId: null,
      }, controls);
    } else if (content.type === "host-transfer" && content.action === "reject" &&
      this.durable.applicationState.hostDeviceId === this.deviceId) {
      const index = controls.findIndex((control) => control.kind === "transfer-host" &&
        control.targetDeviceId === senderDeviceId && control.acceptMessageId === null);
      if (index < 0) throw new SecureRoomEngineError("transition-invalid", "host-transfer rejection has no durable offer context");
      controls.splice(index, 1);
    }
    return controls;
  }

  private admissionBlockedByApplicationState(): boolean {
    const state = this.durable.applicationState;
    return state.vote !== null || state.rps !== null || state.ttt !== null ||
      state.saboteur !== null || state.pendingHostDeviceId !== null ||
      state.pendingRemovalDeviceIds.length !== 0;
  }

  private acknowledgeOutboxId(
    value: readonly SecureRoomPendingOutboxEntryV1[],
    messageId: string,
  ): { outbox: SecureRoomPendingOutboxEntryV1[]; found: boolean; changed: boolean } {
    const outbox = cloneSecureRoomPendingOutboxV1(value);
    for (let index = 0; index < outbox.length; index += 1) {
      const entry = outbox[index];
      if (entry.kind !== "admission") {
        if (entry.messageId !== messageId) continue;
        outbox.splice(index, 1);
        return { outbox, found: true, changed: true };
      }
      if (entry.messageId === messageId) {
        if (entry.welcomeMessageId === null) {
          if (entry.commitAcknowledged) return { outbox, found: true, changed: false };
          entry.commitAcknowledged = true;
          return { outbox, found: true, changed: true };
        }
        if (entry.commitAcknowledged) return { outbox, found: true, changed: false };
        entry.commitAcknowledged = true;
        return { outbox, found: true, changed: true };
      }
      if (entry.welcomeMessageId !== messageId) continue;
      if (!entry.commitAcknowledged) {
        throw new SecureRoomEngineError("transition-invalid", "Welcome cannot be acknowledged before its admission commit");
      }
      if (entry.welcomeAcknowledged) return { outbox, found: true, changed: false };
      entry.welcomeAcknowledged = true;
      return { outbox, found: true, changed: true };
    }
    return { outbox, found: false, changed: false };
  }

  private cloneCommitSecrets(
    secrets: Record<string, SecureRoomPendingCommitSecretV4>,
  ): Record<string, SecureRoomPendingCommitSecretV4> {
    const cloned: Record<string, SecureRoomPendingCommitSecretV4> = {};
    for (const [gameId, secret] of Object.entries(secrets)) cloned[gameId] = { ...secret };
    return cloned;
  }

  private commitSecretMatchesApplication(
    secret: SecureRoomPendingCommitSecretV4,
    state: SecureRoomStateSnapshotV4,
  ): boolean {
    if (secret.kind === "rps") {
      return state.rps?.gameId === secret.gameId &&
        (state.rps.phase === "committing" || state.rps.phase === "revealing");
    }
    return state.saboteur?.gameId === secret.gameId &&
      (state.saboteur.phase === "committing" || state.saboteur.phase === "revealing");
  }

  private async validateCommitSecret(secret: SecureRoomPendingCommitSecretV4): Promise<void> {
    if (
      !secret || typeof secret !== "object" ||
      canonicalBase64UrlByteLength(secret.gameId) !== SECURE_MESSAGE_ID_BYTES ||
      canonicalBase64UrlByteLength(secret.nonce) !== 32 ||
      canonicalBase64UrlByteLength(secret.commitment) !== 32 ||
      !this.commitSecretMatchesApplication(secret, this.durable.applicationState)
    ) throw new SecureRoomEngineError("invalid-input", "committed game secret is invalid or its game is inactive");
    let expected: string;
    if (secret.kind === "rps") {
      if (secret.pick !== "rock" && secret.pick !== "paper" && secret.pick !== "scissors") {
        throw new SecureRoomEngineError("invalid-input", "RPS committed pick is invalid");
      }
      expected = await computeRpsCommitmentV4(secret.gameId, this.deviceId, secret.pick, secret.nonce);
    } else if (secret.kind === "saboteur") {
      expected = await computeSaboteurCommitmentV4(secret.gameId, this.deviceId, secret.nonce);
    } else {
      throw new SecureRoomEngineError("invalid-input", "committed game secret kind is unsupported");
    }
    if (expected !== secret.commitment) {
      throw new SecureRoomEngineError("invalid-input", "committed game secret does not match its public commitment");
    }
  }

  private validateEventCommitSecret(content: SecureApplicationContentV4): string | null {
    if (content.type === "rps" && content.action === "commit") {
      const secret = this.durable.pendingCommitSecrets[content.gameId];
      if (!secret || secret.kind !== "rps" || secret.commitment !== content.commitment) {
        throw new SecureRoomEngineError("invalid-input", "RPS commitment has no matching durable secret");
      }
      return null;
    }
    if (content.type === "saboteur" && content.action === "entropy-commit") {
      const secret = this.durable.pendingCommitSecrets[content.gameId];
      if (!secret || secret.kind !== "saboteur" || secret.commitment !== content.commitment) {
        throw new SecureRoomEngineError("invalid-input", "Saboteur commitment has no matching durable secret");
      }
      return null;
    }
    if (content.type === "rps" && content.action === "reveal") {
      const secret = this.durable.pendingCommitSecrets[content.gameId];
      if (!secret || secret.kind !== "rps" || secret.pick !== content.pick || secret.nonce !== content.nonce) {
        throw new SecureRoomEngineError("invalid-input", "RPS reveal does not match its durable committed secret");
      }
      return content.gameId;
    }
    if (content.type === "saboteur" && content.action === "entropy-reveal") {
      const secret = this.durable.pendingCommitSecrets[content.gameId];
      if (!secret || secret.kind !== "saboteur" || secret.nonce !== content.nonce) {
        throw new SecureRoomEngineError("invalid-input", "Saboteur reveal does not match its durable committed secret");
      }
      return content.gameId;
    }
    return null;
  }

  private validateOutboundGrant(
    value: SecureLogicalOrderGrantV4,
    retainedJoinAdmissionId?: string,
  ): SecureLogicalOrderGrantV4 {
    const keys = [
      "v", "suite", "roomInstance", "requestId", "tokenId", "deviceId", "logicalOrder", "expiresAt",
    ];
    if (
      !isPlainDataRecord(value) || Reflect.ownKeys(value).length !== keys.length ||
      !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) ||
      value.v !== 4 || value.suite !== 1 || value.roomInstance !== this.roomInstance ||
      value.deviceId !== this.deviceId ||
      canonicalBase64UrlByteLength(value.requestId) !== SECURE_MESSAGE_ID_BYTES ||
      canonicalBase64UrlByteLength(value.tokenId) !== SECURE_MESSAGE_ID_BYTES ||
      value.requestId === value.tokenId ||
      !Number.isSafeInteger(value.logicalOrder) ||
      value.logicalOrder !== this.durable.applicationState.logicalOrder + 1 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()
    ) {
      throw new SecureRoomEngineError("invalid-input", "outbound relay grant is malformed, stale, or not bound to the next room order");
    }
    const occupied = new Set([
      ...this.allOutboxIds(this.durable.pendingOutbox),
      ...this.relayControlIds(this.durable.pendingRelayControls),
      ...this.durable.processedDeliveries.map((delivery) => delivery.messageId),
    ]);
    const reusesRetainedJoinAdmission = retainedJoinAdmissionId === value.requestId &&
      this.durable.pendingOutbox.some((entry) => entry.kind === "admission" &&
        entry.welcomeMessageId === null && entry.commitAcknowledged &&
        entry.admissionId === retainedJoinAdmissionId);
    if ((occupied.has(value.requestId) && !reusesRetainedJoinAdmission) || occupied.has(value.tokenId)) {
      throw new SecureRoomEngineError("invalid-input", "outbound relay grant reuses a durable replay id");
    }
    return {
      v: 4,
      suite: 1,
      roomInstance: value.roomInstance,
      requestId: value.requestId,
      tokenId: value.tokenId,
      deviceId: value.deviceId,
      logicalOrder: value.logicalOrder,
      expiresAt: value.expiresAt,
    };
  }

  private assertLease(): void {
    SecureRoomEngine.assertLease(this.lease, this.lockKey);
  }

  private assertUsable(): void {
    if (this.retired) throw new SecureRoomEngineError("retired", "secure room state has been terminally erased");
    if (this.unavailable || !this.session) {
      throw new SecureRoomEngineError("state-invalid", "secure room engine is unavailable and must be restored");
    }
  }

  private requireSession(): MlsCryptoSession {
    if (!this.session) throw new SecureRoomEngineError("state-invalid", "secure room session is unavailable");
    return this.session;
  }

  private allocatePendingMessageId(reserved: readonly string[] = []): string {
    if (this.durable.pendingOutbox.length >= MAX_SECURE_ROOM_PENDING_OUTBOX_ENTRIES) {
      throw new SecureRoomEngineError("pending-saturated", "outbound message acknowledgements are required before sending more data");
    }
    const used = new Set([...this.durableReplayIds(), ...reserved]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const messageId = randomSecureRoomIdV4(16);
      if (!used.has(messageId)) return messageId;
    }
    throw new SecureRoomEngineError("state-invalid", "secure random message id generation collided repeatedly");
  }

  private allocateRelayRequestId(reserved: readonly string[] = []): string {
    if (this.durable.pendingRelayControls.length >= MAX_SECURE_ROOM_PENDING_RELAY_CONTROLS) {
      throw new SecureRoomEngineError("pending-saturated", "pending relay-control ledger is saturated");
    }
    const used = new Set([
      ...this.durableReplayIds(),
      ...reserved,
    ]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const requestId = randomSecureRoomIdV4(16);
      if (!used.has(requestId)) return requestId;
    }
    throw new SecureRoomEngineError("state-invalid", "secure random relay request id generation collided repeatedly");
  }

  private allocateEventId(): string {
    const used = new Set(this.durableReplayIds());
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const eventId = randomSecureRoomIdV4(16);
      if (!used.has(eventId)) return eventId;
    }
    throw new SecureRoomEngineError("state-invalid", "secure random event id generation collided repeatedly");
  }

  private durableReplayIds(): string[] {
    return [
      ...this.allOutboxIds(this.durable.pendingOutbox),
      ...this.relayControlIds(this.durable.pendingRelayControls),
      ...this.durable.processedDeliveries.map((delivery) => delivery.messageId),
      ...this.durable.applicationState.seenEventIds,
    ];
  }

  private encodeCanonicalId(bytes: Uint8Array): string {
    if (bytes.byteLength !== SECURE_DEVICE_ID_BYTES) {
      throw new SecureRoomEngineError("transition-invalid", "MLS identity is not a protocol-v4 device id");
    }
    return this.encodeBase64Url(bytes);
  }

  private encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
  }

  private static normalizeRoster(entries: MlsRosterEntry[]): NormalizedRosterEntry[] {
    if (!Array.isArray(entries) || entries.length > 20) {
      throw new SecureRoomEngineError("transition-invalid", "MLS roster exceeds the application membership limit");
    }
    const normalized = entries.map((entry) => {
      if (
        !Number.isInteger(entry.index) || entry.index < 0 || entry.index > 0xffff_ffff ||
        !(entry.identity instanceof Uint8Array) || entry.identity.byteLength !== SECURE_DEVICE_ID_BYTES ||
        !(entry.signatureKey instanceof Uint8Array) || entry.signatureKey.byteLength !== SECURE_APPLICATION_EVENT_PUBLIC_KEY_BYTES
      ) throw new SecureRoomEngineError("transition-invalid", "MLS roster credential is malformed");
      const identity = entry.identity.slice();
      const signatureKey = entry.signatureKey.slice();
      let identityBinary = "";
      let keyBinary = "";
      for (const byte of identity) identityBinary += String.fromCharCode(byte);
      for (const byte of signatureKey) keyBinary += String.fromCharCode(byte);
      return {
        leafIndex: entry.index,
        deviceId: btoa(identityBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""),
        signaturePublicKey: btoa(keyBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""),
        identity,
        signatureKey,
      };
    });
    if (
      new Set(normalized.map((entry) => entry.leafIndex)).size !== normalized.length ||
      new Set(normalized.map((entry) => entry.deviceId)).size !== normalized.length
    ) throw new SecureRoomEngineError("transition-invalid", "MLS roster contains duplicate identities or leaf indices");
    return normalized.sort((left, right) => left.leafIndex - right.leafIndex);
  }

  private assertCommonCredentialKeysStable(before: NormalizedRosterEntry[], after: NormalizedRosterEntry[]): void {
    for (const prior of before) {
      const current = after.find((entry) => entry.deviceId === prior.deviceId);
      if (current && !sameBytes(prior.signatureKey, current.signatureKey)) {
        throw new SecureRoomEngineError("transition-invalid", "MLS commit replaced an existing member credential key");
      }
    }
  }

  private authenticatedCommitSender(transition: MlsTransition, before: NormalizedRosterEntry[]): string {
    const senderIdentity = copyBytes(transition.senderIdentity, "commit sender identity");
    try {
      if (senderIdentity.byteLength !== SECURE_DEVICE_ID_BYTES) {
        throw new SecureRoomEngineError("transition-invalid", "MLS commit sender identity has an invalid length");
      }
      const senderDeviceId = this.encodeCanonicalId(senderIdentity);
      const senderBefore = before.find((entry) => entry.deviceId === senderDeviceId);
      if (!senderBefore ||
        (transition.senderLeafIndex !== undefined && transition.senderLeafIndex !== senderBefore.leafIndex)) {
        throw new SecureRoomEngineError("transition-invalid", "MLS commit sender is absent from the prior authenticated roster");
      }
      return senderDeviceId;
    } finally {
      senderIdentity.fill(0);
    }
  }

  private assertStableRoster(
    before: NormalizedRosterEntry[],
    after: NormalizedRosterEntry[],
    delta: { added: number; removed: number },
  ): void {
    if (after.length !== before.length + delta.added - delta.removed) {
      throw new SecureRoomEngineError("transition-invalid", "MLS roster changed by an unexpected number of members");
    }
    this.assertCommonCredentialKeysStable(before, after);
    const beforeIds = new Set(before.map((entry) => entry.deviceId));
    const afterIds = new Set(after.map((entry) => entry.deviceId));
    const added = [...afterIds].filter((id) => !beforeIds.has(id)).length;
    const removed = [...beforeIds].filter((id) => !afterIds.has(id)).length;
    if (added !== delta.added || removed !== delta.removed) {
      throw new SecureRoomEngineError("transition-invalid", "MLS roster identity delta is invalid");
    }
  }

  private assertExpectedFounderInRoster(roster: NormalizedRosterEntry[]): void {
    const expected = this.expectedJoinFounder;
    if (!expected) {
      throw new SecureRoomEngineError("unauthorized", "pending join has no invitation-authorized founder");
    }
    const matches = roster.filter((entry) => entry.deviceId === expected.deviceId &&
      entry.signaturePublicKey === expected.signaturePublicKey);
    if (matches.length !== 1) {
      throw new SecureRoomEngineError(
        "unauthorized",
        "Welcome roster does not contain the exact invitation-authorized founder credential",
      );
    }
  }

  private knownMembership(roster: NormalizedRosterEntry[]): SecureMemberCredentialV4[] {
    const names = new Map(this.durable.applicationState.members.map((member) => [member.deviceId, member.displayName]));
    return roster.map((entry) => ({
      deviceId: entry.deviceId,
      displayName: names.get(entry.deviceId) ?? null,
      signaturePublicKey: entry.signaturePublicKey,
    }));
  }

  private membershipForEvent(
    event: SecureApplicationEventV4,
    roster: NormalizedRosterEntry[],
  ): SecureMemberCredentialV4[] {
    const names = new Map(this.durable.applicationState.members.map((member) => [member.deviceId, member.displayName]));
    if (event.content.type === "member-profile") names.set(event.deviceId, event.content.displayName);
    if (event.content.type === "state-snapshot") {
      for (const member of event.content.state.members) names.set(member.deviceId, member.displayName);
    }
    const credentials = roster.map((entry) => ({
      deviceId: entry.deviceId,
      displayName: names.get(entry.deviceId) ?? null,
      signaturePublicKey: entry.signaturePublicKey,
    }));
    if (!credentials.some((entry) => entry.deviceId === event.deviceId)) {
      throw new SecureRoomEngineError("transition-invalid", "event signer has no application membership credential");
    }
    if (this.durable.applicationState.members.some((member) => !credentials.some((entry) => entry.deviceId === member.deviceId))) {
      throw new SecureRoomEngineError("transition-invalid", "application member is absent from the MLS roster");
    }
    return credentials;
  }
}

export async function secureRoomEngineStoreKey(roomInstance: string): Promise<string> {
  return secureRoomOpaqueStoreKey(roomInstance);
}

export async function secureRoomEngineStateKey(roomInstance: string, roomSecret: string): Promise<string> {
  return secureRoomCredentialStoreKey(roomInstance, roomSecret);
}
