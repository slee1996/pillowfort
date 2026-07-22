import initOpenMls, {
  MlsSession as NativeMlsSession,
  type MlsTransition as NativeMlsTransition,
  type RosterEntry as NativeRosterEntry,
} from "../vendor/openmls/pillowfort_openmls.js";

const ROOM_SECRET_RE = /^pf2_([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const ROOM_BINDING_BYTES = 16;
const IDENTITY_BYTES = 16;
const WRAP_SALT_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const WRAP_MAGIC = new TextEncoder().encode("PFMLSWR1");
const WRAP_VERSION = 1;
const PROTOCOL_VERSION = 4;
const CIPHERSUITE = 1;
const WRAP_HEADER_BYTES = 8 + 2 + 2 + 2 + ROOM_BINDING_BYTES + WRAP_SALT_BYTES + WRAP_NONCE_BYTES + 4;
const MAX_PERSISTED_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_RAW_SNAPSHOT_BYTES = MAX_PERSISTED_SNAPSHOT_BYTES - WRAP_HEADER_BYTES - AES_GCM_TAG_BYTES;
const MAX_MLS_MESSAGE_BYTES = 64 * 1024;
const MAX_KEY_PACKAGE_BYTES = 16 * 1024;
const MAX_APPLICATION_BYTES = 60 * 1024;
const NO_SENDER = 0xffff_ffff;
const WRAP_DOMAIN = new TextEncoder().encode("pillowfort:mls-snapshot-wrap:v1");
const RAW_SNAPSHOT_MAGIC = new Uint8Array([0x50, 0x46, 0x4d, 0x4c, 0x53, 0x00, 0x00, 0x01]);
const RAW_SNAPSHOT_VERSION = 1;
const ED25519_PUBLIC_KEY_BYTES = 32;

let openMlsInitialization: Promise<unknown> | null = null;

export type MlsCryptoErrorCode =
  | "invalid-input"
  | "unavailable"
  | "state-invalid"
  | "transition-failed"
  | "session-closed";

export class MlsCryptoError extends Error {
  readonly code: MlsCryptoErrorCode;
  readonly cause?: unknown;

  constructor(code: MlsCryptoErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MlsCryptoError";
    this.code = code;
    this.cause = cause;
  }
}

export interface CreateMlsSessionOptions {
  roomBinding: Uint8Array;
  identity: Uint8Array;
  roomSecret: string;
  founder?: boolean;
}

export interface RestoreMlsSessionOptions {
  roomBinding: Uint8Array;
  roomSecret: string;
  snapshot: Uint8Array;
}

export interface CreatedMlsSession {
  session: MlsCryptoSession;
  snapshot: Uint8Array;
}

export type MlsTransitionKind =
  | "key-package"
  | "add"
  | "join"
  | "remove"
  | "self-update"
  | "outbound-application"
  | "inbound-application"
  | "inbound-proposal"
  | "inbound-commit";

export interface MlsTransition {
  kind: MlsTransitionKind;
  epoch: bigint;
  snapshot: Uint8Array;
  outbound?: Uint8Array;
  welcome?: Uint8Array;
  ratchetTree?: Uint8Array;
  plaintext?: Uint8Array;
  senderIdentity?: Uint8Array;
  senderLeafIndex?: number;
  commitSummary?: MlsCommitSummary;
}

export interface MlsCommitSummary {
  addCount: number;
  removeCount: number;
  updateCount: number;
  otherCount: number;
  hasUpdatePath: boolean;
}

export interface MlsRosterEntry {
  index: number;
  identity: Uint8Array;
  signatureKey: Uint8Array;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output;
}

function concatenate(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function encodeU16(value: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
}

function encodeU32(value: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function decodeRoomSecret(roomSecret: string): Uint8Array {
  if (typeof roomSecret !== "string") {
    throw new MlsCryptoError("invalid-input", "room secret must be a string");
  }
  const match = ROOM_SECRET_RE.exec(roomSecret);
  if (!match) {
    throw new MlsCryptoError("invalid-input", "room secret is not a canonical 32-byte Pillowfort secret");
  }
  try {
    const padded = match[1].replace(/-/g, "+").replace(/_/g, "/") + "=";
    const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== 32) throw new Error("wrong decoded length");
    return decoded;
  } catch (error) {
    throw new MlsCryptoError("invalid-input", "room secret could not be decoded", error);
  }
}

function fixedBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new MlsCryptoError("invalid-input", `${label} must be exactly ${length} bytes`);
  }
  return copyBytes(value);
}

function boundedBytes(value: Uint8Array, maximum: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new MlsCryptoError("invalid-input", `${label} must contain between 1 and ${maximum} bytes`);
  }
  return value;
}

function signaturePublicKeyFromRawSnapshot(snapshot: Uint8Array): Uint8Array {
  boundedBytes(snapshot, MAX_RAW_SNAPSHOT_BYTES, "raw MLS snapshot");
  let offset = 0;
  const take = (length: number, label: string): Uint8Array => {
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > snapshot.byteLength) {
      throw new MlsCryptoError("state-invalid", `raw MLS snapshot ended while reading ${label}`);
    }
    const value = snapshot.subarray(offset, end);
    offset = end;
    return value;
  };
  const readU16 = (label: string): number => {
    const value = take(2, label);
    return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint16(0, false);
  };
  const readBytes = (expectedLength: number, label: string): Uint8Array => {
    const lengthBytes = take(4, `${label} length`);
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, false);
    if (length !== expectedLength) {
      throw new MlsCryptoError("state-invalid", `raw MLS snapshot ${label} has an invalid length`);
    }
    return take(length, label);
  };
  const magic = take(RAW_SNAPSHOT_MAGIC.byteLength, "magic");
  if (!magic.every((byte, index) => byte === RAW_SNAPSHOT_MAGIC[index]) ||
      readU16("version") !== RAW_SNAPSHOT_VERSION || readU16("ciphersuite") !== CIPHERSUITE) {
    throw new MlsCryptoError("state-invalid", "raw MLS snapshot header is invalid");
  }
  readBytes(ROOM_BINDING_BYTES, "room binding");
  readBytes(IDENTITY_BYTES, "identity");
  return readBytes(ED25519_PUBLIC_KEY_BYTES, "signature public key").slice();
}

function browserCrypto(): Crypto {
  const candidate = globalThis.crypto;
  if (!candidate?.subtle || typeof candidate.getRandomValues !== "function") {
    throw new MlsCryptoError("unavailable", "WebCrypto is required for MLS state protection");
  }
  return candidate;
}

async function initializeOpenMls(): Promise<void> {
  if (!openMlsInitialization) {
    openMlsInitialization = initOpenMls().catch((error) => {
      openMlsInitialization = null;
      throw new MlsCryptoError("unavailable", "OpenMLS WASM could not be initialized", error);
    });
  }
  await openMlsInitialization;
}

function wrapSalt(roomBinding: Uint8Array, randomSalt: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatenate(
    WRAP_DOMAIN,
    encodeU16(PROTOCOL_VERSION),
    encodeU16(CIPHERSUITE),
    roomBinding,
    randomSalt,
  );
}

function wrapInfo(roomBinding: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatenate(
    WRAP_DOMAIN,
    WRAP_MAGIC,
    encodeU16(WRAP_VERSION),
    encodeU16(PROTOCOL_VERSION),
    encodeU16(CIPHERSUITE),
    roomBinding,
  );
}

async function deriveWrappingKey(
  secretBytes: Uint8Array,
  roomBinding: Uint8Array,
  randomSalt: Uint8Array,
): Promise<CryptoKey> {
  const subtle = browserCrypto().subtle;
  // Keep references to every adapter-created WebCrypto input until the
  // operation settles so the room-secret copy can be explicitly erased. An
  // inline `.buffer` helper would create an unreachable plaintext copy that
  // could only be reclaimed later by the JavaScript garbage collector.
  const secretInput = copyBytes(secretBytes);
  const saltInput = wrapSalt(roomBinding, randomSalt);
  const infoInput = wrapInfo(roomBinding);
  try {
    const inputKey = await subtle.importKey("raw", secretInput, "HKDF", false, ["deriveKey"]);
    return await subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltInput,
        info: infoInput,
      },
      inputKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    secretInput.fill(0);
    saltInput.fill(0);
    infoInput.fill(0);
  }
}

function makeWrapHeader(
  roomBinding: Uint8Array,
  randomSalt: Uint8Array,
  nonce: Uint8Array,
  ciphertextLength: number,
): Uint8Array<ArrayBuffer> {
  const header = concatenate(
    WRAP_MAGIC,
    encodeU16(WRAP_VERSION),
    encodeU16(PROTOCOL_VERSION),
    encodeU16(CIPHERSUITE),
    roomBinding,
    randomSalt,
    nonce,
    encodeU32(ciphertextLength),
  );
  if (header.byteLength !== WRAP_HEADER_BYTES) {
    throw new MlsCryptoError("state-invalid", "MLS snapshot header length is inconsistent");
  }
  return header;
}

async function protectSnapshot(
  rawSnapshot: Uint8Array,
  roomBinding: Uint8Array,
  secretBytes: Uint8Array,
): Promise<Uint8Array> {
  boundedBytes(rawSnapshot, MAX_RAW_SNAPSHOT_BYTES, "raw MLS snapshot");
  const crypto = browserCrypto();
  const randomSalt: Uint8Array<ArrayBuffer> = new Uint8Array(WRAP_SALT_BYTES);
  const nonce: Uint8Array<ArrayBuffer> = new Uint8Array(WRAP_NONCE_BYTES);
  crypto.getRandomValues(randomSalt);
  crypto.getRandomValues(nonce);
  const ciphertextLength = rawSnapshot.byteLength + AES_GCM_TAG_BYTES;
  const header = makeWrapHeader(roomBinding, randomSalt, nonce, ciphertextLength);
  const plaintextInput = copyBytes(rawSnapshot);
  try {
    const key = await deriveWrappingKey(secretBytes, roomBinding, randomSalt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: header,
        tagLength: 128,
      },
      key,
      plaintextInput,
    ));
    if (ciphertext.byteLength !== ciphertextLength) {
      throw new MlsCryptoError("state-invalid", "MLS snapshot ciphertext length is inconsistent");
    }
    const wrapped = concatenate(header, ciphertext);
    if (wrapped.byteLength > MAX_PERSISTED_SNAPSHOT_BYTES) {
      throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot exceeds the persistence limit");
    }
    return wrapped;
  } finally {
    plaintextInput.fill(0);
    randomSalt.fill(0);
    nonce.fill(0);
  }
}

interface ParsedWrapEnvelope {
  header: Uint8Array<ArrayBuffer>;
  randomSalt: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

function parseWrapEnvelope(snapshot: Uint8Array, expectedRoomBinding: Uint8Array): ParsedWrapEnvelope {
  boundedBytes(snapshot, MAX_PERSISTED_SNAPSHOT_BYTES, "wrapped MLS snapshot");
  if (snapshot.byteLength < WRAP_HEADER_BYTES + AES_GCM_TAG_BYTES) {
    throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot is truncated");
  }
  let offset = 0;
  const take = (length: number): Uint8Array<ArrayBuffer> => {
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > snapshot.byteLength) {
      throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot is truncated");
    }
    const value = copyBytes(snapshot.subarray(offset, end));
    offset = end;
    return value;
  };
  const magic = take(WRAP_MAGIC.byteLength);
  if (!magic.every((byte, index) => byte === WRAP_MAGIC[index])) {
    throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot magic is invalid");
  }
  const readU16 = (): number => new DataView(take(2).buffer).getUint16(0, false);
  if (readU16() !== WRAP_VERSION || readU16() !== PROTOCOL_VERSION || readU16() !== CIPHERSUITE) {
    throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot version or suite is unsupported");
  }
  const roomBinding = take(ROOM_BINDING_BYTES);
  if (!roomBinding.every((byte, index) => byte === expectedRoomBinding[index])) {
    throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot belongs to a different room");
  }
  const randomSalt = take(WRAP_SALT_BYTES);
  const nonce = take(WRAP_NONCE_BYTES);
  const ciphertextLength = new DataView(take(4).buffer).getUint32(0, false);
  if (ciphertextLength < AES_GCM_TAG_BYTES + 1 || ciphertextLength !== snapshot.byteLength - offset) {
    throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot ciphertext length is invalid");
  }
  const header = snapshot.slice(0, offset);
  const ciphertext = take(ciphertextLength);
  if (offset !== snapshot.byteLength) {
    throw new MlsCryptoError("state-invalid", "wrapped MLS snapshot contains trailing bytes");
  }
  return { header, randomSalt, nonce, ciphertext };
}

async function unprotectSnapshot(
  snapshot: Uint8Array,
  roomBinding: Uint8Array,
  secretBytes: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseWrapEnvelope(snapshot, roomBinding);
  try {
    const key = await deriveWrappingKey(secretBytes, roomBinding, envelope.randomSalt);
    const plaintext = new Uint8Array(await browserCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: envelope.nonce,
        additionalData: envelope.header,
        tagLength: 128,
      },
      key,
      envelope.ciphertext,
    ));
    boundedBytes(plaintext, MAX_RAW_SNAPSHOT_BYTES, "decrypted MLS snapshot");
    return plaintext;
  } catch (error) {
    if (error instanceof MlsCryptoError) throw error;
    throw new MlsCryptoError(
      "state-invalid",
      "wrapped MLS snapshot authentication failed",
      error,
    );
  } finally {
    envelope.randomSalt.fill(0);
    envelope.nonce.fill(0);
  }
}

function transitionKind(kind: number): MlsTransitionKind {
  switch (kind) {
    case 1: return "key-package";
    case 2: return "add";
    case 3: return "join";
    case 4: return "remove";
    case 5: return "self-update";
    case 6: return "outbound-application";
    case 7: return "inbound-application";
    case 8: return "inbound-proposal";
    case 9: return "inbound-commit";
    default: throw new MlsCryptoError("transition-failed", "OpenMLS returned an unknown transition kind");
  }
}

function optionalBytes(bytes: Uint8Array): Uint8Array | undefined {
  return bytes.byteLength > 0 ? bytes : undefined;
}

export class MlsCryptoSession {
  private native: NativeMlsSession | null;
  private readonly roomBinding: Uint8Array;
  private readonly roomSecretBytes: Uint8Array;
  private readonly ownSignaturePublicKey: Uint8Array;

  private constructor(
    native: NativeMlsSession,
    roomBinding: Uint8Array,
    roomSecretBytes: Uint8Array,
    ownSignaturePublicKey: Uint8Array,
  ) {
    this.native = native;
    this.roomBinding = roomBinding;
    this.roomSecretBytes = roomSecretBytes;
    this.ownSignaturePublicKey = ownSignaturePublicKey;
  }

  static async create(options: CreateMlsSessionOptions): Promise<CreatedMlsSession> {
    const roomBinding = fixedBytes(options?.roomBinding, ROOM_BINDING_BYTES, "room binding");
    const identity = fixedBytes(options?.identity, IDENTITY_BYTES, "identity");
    const roomSecretBytes = decodeRoomSecret(options?.roomSecret);
    await initializeOpenMls();
    let native: NativeMlsSession | null = null;
    let rawSnapshot: Uint8Array | null = null;
    let signaturePublicKey: Uint8Array | null = null;
    try {
      native = new NativeMlsSession(roomBinding, identity, options.founder === true);
      rawSnapshot = native.snapshot();
      signaturePublicKey = signaturePublicKeyFromRawSnapshot(rawSnapshot);
      const snapshot = await protectSnapshot(rawSnapshot, roomBinding, roomSecretBytes);
      const session = new MlsCryptoSession(native, roomBinding, roomSecretBytes, signaturePublicKey);
      native = null;
      signaturePublicKey = null;
      return { session, snapshot };
    } catch (error) {
      native?.free();
      signaturePublicKey?.fill(0);
      roomSecretBytes.fill(0);
      if (error instanceof MlsCryptoError) throw error;
      throw new MlsCryptoError("transition-failed", "MLS session creation failed", error);
    } finally {
      rawSnapshot?.fill(0);
      identity.fill(0);
    }
  }

  static async restore(options: RestoreMlsSessionOptions): Promise<MlsCryptoSession> {
    const roomBinding = fixedBytes(options?.roomBinding, ROOM_BINDING_BYTES, "room binding");
    const roomSecretBytes = decodeRoomSecret(options?.roomSecret);
    await initializeOpenMls();
    let rawSnapshot: Uint8Array | null = null;
    let signaturePublicKey: Uint8Array | null = null;
    try {
      rawSnapshot = await unprotectSnapshot(options.snapshot, roomBinding, roomSecretBytes);
      signaturePublicKey = signaturePublicKeyFromRawSnapshot(rawSnapshot);
      const native = NativeMlsSession.restore(roomBinding, rawSnapshot);
      const session = new MlsCryptoSession(native, roomBinding, roomSecretBytes, signaturePublicKey);
      signaturePublicKey = null;
      return session;
    } catch (error) {
      signaturePublicKey?.fill(0);
      roomSecretBytes.fill(0);
      if (error instanceof MlsCryptoError) throw error;
      throw new MlsCryptoError("state-invalid", "MLS snapshot restore failed", error);
    } finally {
      rawSnapshot?.fill(0);
    }
  }

  async keyPackage(): Promise<MlsTransition> {
    return this.mutate(() => this.requireNative().key_package());
  }

  async add(keyPackage: Uint8Array): Promise<MlsTransition> {
    boundedBytes(keyPackage, MAX_KEY_PACKAGE_BYTES, "key package");
    return this.mutate(() => this.requireNative().add(keyPackage));
  }

  async join(welcome: Uint8Array, ratchetTree: Uint8Array): Promise<MlsTransition> {
    boundedBytes(welcome, MAX_MLS_MESSAGE_BYTES, "Welcome");
    boundedBytes(ratchetTree, MAX_MLS_MESSAGE_BYTES, "ratchet tree");
    return this.mutate(() => this.requireNative().join(welcome, ratchetTree));
  }

  async remove(leafIndex: number): Promise<MlsTransition> {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xffff_ffff) {
      throw new MlsCryptoError("invalid-input", "member leaf index is invalid");
    }
    return this.mutate(() => this.requireNative().remove(leafIndex));
  }

  async selfUpdate(): Promise<MlsTransition> {
    return this.mutate(() => this.requireNative().self_update());
  }

  async encrypt(plaintext: Uint8Array): Promise<MlsTransition> {
    boundedBytes(plaintext, MAX_APPLICATION_BYTES, "application plaintext");
    return this.mutate(() => this.requireNative().encrypt(plaintext));
  }

  async receive(message: Uint8Array): Promise<MlsTransition> {
    boundedBytes(message, MAX_MLS_MESSAGE_BYTES, "MLS message");
    return this.mutate(() => this.requireNative().receive(message));
  }

  async snapshot(): Promise<Uint8Array> {
    let rawSnapshot: Uint8Array | null = null;
    try {
      rawSnapshot = this.requireNative().snapshot();
      return await protectSnapshot(rawSnapshot, this.roomBinding, this.roomSecretBytes);
    } catch (error) {
      this.dispose();
      if (error instanceof MlsCryptoError) throw error;
      throw new MlsCryptoError("transition-failed", "MLS snapshot export failed", error);
    } finally {
      rawSnapshot?.fill(0);
    }
  }

  isActive(): boolean {
    return this.requireNative().is_active();
  }

  signaturePublicKey(): Uint8Array {
    this.requireNative();
    return this.ownSignaturePublicKey.slice();
  }

  roster(): MlsRosterEntry[] {
    const nativeEntries = this.requireNative().roster() as NativeRosterEntry[];
    const roster: MlsRosterEntry[] = [];
    for (const entry of nativeEntries) {
      try {
        roster.push({
          index: entry.index,
          identity: entry.identity,
          signatureKey: entry.signature_key,
        });
      } finally {
        entry.free();
      }
    }
    return roster;
  }

  sign(data: Uint8Array): Uint8Array {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_MLS_MESSAGE_BYTES) {
      throw new MlsCryptoError(
        "invalid-input",
        `signature payload must contain at most ${MAX_MLS_MESSAGE_BYTES} bytes`,
      );
    }
    try {
      return this.requireNative().sign(data);
    } catch (error) {
      if (error instanceof MlsCryptoError) throw error;
      throw new MlsCryptoError("transition-failed", "MLS credential signing failed", error);
    }
  }

  dispose(): void {
    if (this.native) {
      this.native.free();
      this.native = null;
    }
    this.roomSecretBytes.fill(0);
    this.roomBinding.fill(0);
    this.ownSignaturePublicKey.fill(0);
  }

  private requireNative(): NativeMlsSession {
    if (!this.native) {
      throw new MlsCryptoError("session-closed", "MLS session is closed and must be restored");
    }
    return this.native;
  }

  private async mutate(operation: () => NativeMlsTransition): Promise<MlsTransition> {
    let nativeTransition: NativeMlsTransition | null = null;
    let rawSnapshot: Uint8Array | null = null;
    try {
      nativeTransition = operation();
      rawSnapshot = nativeTransition.snapshot;
      const snapshot = await protectSnapshot(rawSnapshot, this.roomBinding, this.roomSecretBytes);
      const outbound = optionalBytes(nativeTransition.outbound);
      const welcome = optionalBytes(nativeTransition.welcome);
      const ratchetTree = optionalBytes(nativeTransition.ratchet_tree);
      const plaintext = optionalBytes(nativeTransition.plaintext);
      const senderIdentity = optionalBytes(nativeTransition.sender_identity);
      const senderLeafIndex = nativeTransition.sender_leaf_index;
      const nativeKind = nativeTransition.kind;
      const commitSummary = nativeKind === 9 ? {
        addCount: nativeTransition.commit_add_count,
        removeCount: nativeTransition.commit_remove_count,
        updateCount: nativeTransition.commit_update_count,
        otherCount: nativeTransition.commit_other_count,
        hasUpdatePath: nativeTransition.commit_has_update_path,
      } satisfies MlsCommitSummary : undefined;
      return {
        kind: transitionKind(nativeKind),
        epoch: nativeTransition.epoch,
        snapshot,
        ...(outbound && { outbound }),
        ...(welcome && { welcome }),
        ...(ratchetTree && { ratchetTree }),
        ...(plaintext && { plaintext }),
        ...(senderIdentity && { senderIdentity }),
        ...(senderLeafIndex !== NO_SENDER && { senderLeafIndex }),
        ...(commitSummary && { commitSummary }),
      };
    } catch (error) {
      this.dispose();
      if (error instanceof MlsCryptoError) throw error;
      throw new MlsCryptoError(
        "transition-failed",
        "MLS transition failed; restore the last durable snapshot",
        error,
      );
    } finally {
      rawSnapshot?.fill(0);
      nativeTransition?.free();
    }
  }
}

export async function create(options: CreateMlsSessionOptions): Promise<CreatedMlsSession> {
  return MlsCryptoSession.create(options);
}

export async function restore(options: RestoreMlsSessionOptions): Promise<MlsCryptoSession> {
  return MlsCryptoSession.restore(options);
}
