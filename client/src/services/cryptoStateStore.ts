const DATABASE_VERSION = 1;
const RECORD_VERSION = 1;
const REPLAY_STORE = "replay-high-water";
const CRYPTO_STATE_STORE = "opaque-crypto-state";
const METADATA_STORE = "metadata";
const ROOM_INDEX = "by-room-instance";
const ROOM_INSTANCE_PREFIX = "pfri1_";
const ROOM_INSTANCE_RE = /^pfri1_[A-Za-z0-9_-]{43}$/;
const SECURE_ROOM_INSTANCE_V4_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_OPAQUE_STATE_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_LEDGER_BYTES = 2_000_000;
const MAX_LEGACY_ENTRIES = 10_000;

export const CRYPTO_STATE_DATABASE_NAME = "pillowfort-crypto-state-v1";
export const CRYPTO_STATE_DATABASE_VERSION = DATABASE_VERSION;

export type CryptoStateStoreErrorCode =
  | "unsupported"
  | "invalid-input"
  | "open-failed"
  | "schema-invalid"
  | "transaction-failed"
  | "corrupt-record"
  | "legacy-invalid"
  | "legacy-saturated";

export class CryptoStateStoreError extends Error {
  readonly code: CryptoStateStoreErrorCode;
  readonly cause?: unknown;

  constructor(code: CryptoStateStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "CryptoStateStoreError";
    this.code = code;
    this.cause = cause;
  }
}

export interface CryptoStateStoreOptions {
  indexedDB?: IDBFactory | null;
  crypto?: Crypto | null;
  databaseName?: string;
  now?: () => number;
}

export interface ReplayPosition {
  roomInstance: string;
  senderId: string;
  sessionId: string;
  sequence: number;
}

export type ReplayAdvanceResult =
  | { accepted: true; previousSequence: number; currentSequence: number }
  | { accepted: false; reason: "replay"; currentSequence: number };

export interface OpaqueCryptoStateSnapshot {
  revision: number;
  state: Uint8Array;
  updatedAt: number;
}

export type OpaqueCryptoStateCommitResult =
  | { committed: true; revision: number }
  | { committed: false; reason: "revision-conflict"; currentRevision: number | null };

export type OpaqueCryptoStateEraseResult =
  | { erased: true; revision: number }
  | { erased: false; reason: "revision-conflict"; currentRevision: number | null };

export interface LegacyReplayMigrationInput {
  roomId: string;
  roomInstance: string;
  rawLedger: string;
}

export type LegacyReplayMigrationResult =
  | { migrated: true; importedEntries: number }
  | { migrated: false; reason: "already-migrated"; importedEntries: number };

interface ReplayRecord {
  recordVersion: 1;
  kind: "replay";
  key: string;
  roomInstance: string;
  maxSequence: number;
  updatedAt: number;
}

interface OpaqueCryptoStateRecord {
  recordVersion: 1;
  kind: "opaque-state";
  roomInstance: string;
  revision: number;
  state: ArrayBuffer;
  updatedAt: number;
}

interface MigrationRecord {
  recordVersion: 1;
  kind: "legacy-replay-migration";
  key: string;
  roomInstance: string;
  sourceVersion: 1;
  importedEntries: number;
  migratedAt: number;
}

interface LegacyReplayEntry {
  senderId: string;
  sessionId: string;
  sequence: number;
}

function defaultIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

function defaultCrypto(): Crypto | null {
  try {
    return typeof crypto === "undefined" ? null : crypto;
  } catch {
    return null;
  }
}

function ownKeysExactly(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateRoomInstance(roomInstance: unknown): asserts roomInstance is string {
  if (typeof roomInstance !== "string" || !ROOM_INSTANCE_RE.test(roomInstance)) {
    throw new CryptoStateStoreError("invalid-input", "invalid cryptographic room instance");
  }
}

function validateReplayIdentity(senderId: unknown, sessionId: unknown): asserts senderId is string {
  if (
    typeof senderId !== "string"
    || senderId.length < 1
    || senderId.length > 128
    || senderId.trim() !== senderId
    || /[\u0000-\u001f\u007f]/u.test(senderId)
  ) {
    throw new CryptoStateStoreError("invalid-input", "invalid replay sender identity");
  }
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new CryptoStateStoreError("invalid-input", "invalid replay session identity");
  }
}

function validateSequence(sequence: unknown): asserts sequence is number {
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new CryptoStateStoreError("invalid-input", "invalid replay sequence");
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => {
      // The abort event is authoritative and supplies the final transaction error.
    };
  });
}

function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // A completed or already-aborted transaction needs no further action.
  }
}

function transactionError(error: unknown): CryptoStateStoreError {
  if (error instanceof CryptoStateStoreError) return error;
  return new CryptoStateStoreError(
    "transaction-failed",
    "cryptographic state transaction failed; state was not accepted",
    error
  );
}

function validateReplayRecord(value: unknown, key: string, roomInstance: string): ReplayRecord {
  if (
    !isPlainRecord(value)
    || !ownKeysExactly(value, ["recordVersion", "kind", "key", "roomInstance", "maxSequence", "updatedAt"])
    || value.recordVersion !== RECORD_VERSION
    || value.kind !== "replay"
    || value.key !== key
    || value.roomInstance !== roomInstance
    || !Number.isSafeInteger(value.maxSequence)
    || (value.maxSequence as number) < 1
    || !validTimestamp(value.updatedAt)
  ) {
    throw new CryptoStateStoreError("corrupt-record", "invalid persisted replay record");
  }
  return value as unknown as ReplayRecord;
}

function validateOpaqueStateRecord(value: unknown, roomInstance: string): OpaqueCryptoStateRecord {
  if (
    !isPlainRecord(value)
    || !ownKeysExactly(value, ["recordVersion", "kind", "roomInstance", "revision", "state", "updatedAt"])
    || value.recordVersion !== RECORD_VERSION
    || value.kind !== "opaque-state"
    || value.roomInstance !== roomInstance
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || !(value.state instanceof ArrayBuffer)
    || value.state.byteLength < 1
    || value.state.byteLength > MAX_OPAQUE_STATE_BYTES
    || !validTimestamp(value.updatedAt)
  ) {
    throw new CryptoStateStoreError("corrupt-record", "invalid persisted cryptographic state record");
  }
  return value as unknown as OpaqueCryptoStateRecord;
}

function migrationKey(roomInstance: string): string {
  return `legacy-replay-v1:${roomInstance}`;
}

function validateMigrationRecord(value: unknown, roomInstance: string): MigrationRecord {
  const key = migrationKey(roomInstance);
  if (
    !isPlainRecord(value)
    || !ownKeysExactly(value, ["recordVersion", "kind", "key", "roomInstance", "sourceVersion", "importedEntries", "migratedAt"])
    || value.recordVersion !== RECORD_VERSION
    || value.kind !== "legacy-replay-migration"
    || value.key !== key
    || value.roomInstance !== roomInstance
    || value.sourceVersion !== 1
    || !Number.isSafeInteger(value.importedEntries)
    || (value.importedEntries as number) < 0
    || (value.importedEntries as number) > MAX_LEGACY_ENTRIES
    || !validTimestamp(value.migratedAt)
  ) {
    throw new CryptoStateStoreError("corrupt-record", "invalid replay migration marker");
  }
  return value as unknown as MigrationRecord;
}

function parseLegacyReplayLedger(rawLedger: string, roomId: string): LegacyReplayEntry[] {
  if (
    typeof rawLedger !== "string"
    || rawLedger.length < 1
    || rawLedger.length > MAX_LEGACY_LEDGER_BYTES
    || typeof roomId !== "string"
    || roomId.length < 1
    || roomId.length > 128
  ) {
    throw new CryptoStateStoreError("legacy-invalid", "invalid legacy replay ledger input");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLedger);
  } catch (error) {
    throw new CryptoStateStoreError("legacy-invalid", "legacy replay ledger is not valid JSON", error);
  }
  if (!isPlainRecord(parsed)) {
    throw new CryptoStateStoreError("legacy-invalid", "legacy replay ledger has an invalid root");
  }
  const rootKeys = parsed.saturated === undefined ? ["v", "entries"] : ["v", "saturated", "entries"];
  if (
    !ownKeysExactly(parsed, rootKeys)
    || parsed.v !== 1
    || !Array.isArray(parsed.entries)
    || parsed.entries.length > MAX_LEGACY_ENTRIES
    || (parsed.saturated !== undefined && typeof parsed.saturated !== "boolean")
  ) {
    throw new CryptoStateStoreError("legacy-invalid", "legacy replay ledger has an invalid schema");
  }
  if (parsed.saturated === true) {
    throw new CryptoStateStoreError("legacy-saturated", "legacy replay ledger was saturated; migration must fail closed");
  }

  const seenKeys = new Set<string>();
  const relevant: LegacyReplayEntry[] = [];
  for (const candidate of parsed.entries) {
    if (
      !isPlainRecord(candidate)
      || !ownKeysExactly(candidate, ["key", "seq", "seenAt"])
      || typeof candidate.key !== "string"
      || candidate.key.length < 1
      || candidate.key.length > 256
      || !Number.isSafeInteger(candidate.seq)
      || (candidate.seq as number) < 1
      || !validTimestamp(candidate.seenAt)
      || seenKeys.has(candidate.key)
    ) {
      throw new CryptoStateStoreError("legacy-invalid", "legacy replay ledger contains an invalid entry");
    }
    seenKeys.add(candidate.key);

    let tuple: unknown;
    try {
      tuple = JSON.parse(candidate.key);
    } catch (error) {
      throw new CryptoStateStoreError("legacy-invalid", "legacy replay entry key is not valid JSON", error);
    }
    if (!Array.isArray(tuple) || tuple.length !== 3 || candidate.key !== JSON.stringify(tuple)) {
      throw new CryptoStateStoreError("legacy-invalid", "legacy replay entry key has an invalid schema");
    }
    const [entryRoomId, senderId, sessionId] = tuple;
    if (typeof entryRoomId !== "string" || entryRoomId.length < 1 || entryRoomId.length > 128) {
      throw new CryptoStateStoreError("legacy-invalid", "legacy replay entry has an invalid room id");
    }
    try {
      validateReplayIdentity(senderId, sessionId);
    } catch (error) {
      throw new CryptoStateStoreError("legacy-invalid", "legacy replay entry has an invalid identity", error);
    }
    if (entryRoomId === roomId) {
      relevant.push({ senderId, sessionId: sessionId as string, sequence: candidate.seq as number });
    }
  }
  return relevant;
}

export function isCryptoRoomInstance(value: unknown): value is string {
  return typeof value === "string" && ROOM_INSTANCE_RE.test(value);
}

export async function deriveCryptoRoomInstance(
  roomId: string,
  authenticationPublicKey: string,
  cryptoProvider: Crypto | null = defaultCrypto()
): Promise<string> {
  if (
    typeof roomId !== "string"
    || roomId.length < 1
    || roomId.length > 128
    || typeof authenticationPublicKey !== "string"
    || !/^[A-Za-z0-9_-]{32,256}$/u.test(authenticationPublicKey)
  ) {
    throw new CryptoStateStoreError("invalid-input", "invalid room-instance derivation input");
  }
  if (!cryptoProvider?.subtle) {
    throw new CryptoStateStoreError("unsupported", "WebCrypto is required for room-instance derivation");
  }
  const material = new TextEncoder().encode(JSON.stringify([
    "pillowfort-room-instance",
    1,
    roomId,
    authenticationPublicKey,
  ]));
  const digest = await cryptoProvider.subtle.digest("SHA-256", material);
  return `${ROOM_INSTANCE_PREFIX}${toBase64Url(new Uint8Array(digest))}`;
}

/**
 * Maps a canonical protocol-v4 16-byte room instance to the opaque IndexedDB
 * key format used by the replay store and Web Lock coordinator. Keeping the
 * public room identifier out of database keys also avoids cross-protocol key
 * aliasing with the legacy derivation above.
 */
export async function deriveCryptoRoomInstanceV4(
  roomInstance: string,
  cryptoProvider: Crypto | null = defaultCrypto()
): Promise<string> {
  if (typeof roomInstance !== "string" || !SECURE_ROOM_INSTANCE_V4_RE.test(roomInstance)) {
    throw new CryptoStateStoreError("invalid-input", "invalid protocol-v4 room instance");
  }
  if (!cryptoProvider?.subtle) {
    throw new CryptoStateStoreError("unsupported", "WebCrypto is required for room-instance derivation");
  }
  const material = new TextEncoder().encode(JSON.stringify([
    "pillowfort-secure-room-instance",
    4,
    roomInstance,
  ]));
  try {
    const digest = await cryptoProvider.subtle.digest("SHA-256", material);
    return `${ROOM_INSTANCE_PREFIX}${toBase64Url(new Uint8Array(digest))}`;
  } catch (error) {
    throw new CryptoStateStoreError("unsupported", "WebCrypto room-instance digest failed", error);
  }
}

export class CryptoStateStore {
  private readonly factory: IDBFactory | null;
  private readonly cryptoProvider: Crypto | null;
  private readonly databaseName: string;
  private readonly now: () => number;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: CryptoStateStoreOptions = {}) {
    this.factory = options.indexedDB === undefined ? defaultIndexedDb() : options.indexedDB;
    this.cryptoProvider = options.crypto === undefined ? defaultCrypto() : options.crypto;
    this.databaseName = options.databaseName || CRYPTO_STATE_DATABASE_NAME;
    this.now = options.now || Date.now;
    if (typeof this.databaseName !== "string" || this.databaseName.length < 1 || this.databaseName.length > 128) {
      throw new CryptoStateStoreError("invalid-input", "invalid cryptographic state database name");
    }
  }

  async open(): Promise<void> {
    await this.database();
  }

  async close(): Promise<void> {
    const pending = this.databasePromise;
    this.databasePromise = null;
    if (!pending) return;
    try {
      (await pending).close();
    } catch {
      // A failed or externally closed database is already unusable.
    }
  }

  async advanceReplay(position: ReplayPosition): Promise<ReplayAdvanceResult> {
    validateRoomInstance(position?.roomInstance);
    validateReplayIdentity(position?.senderId, position?.sessionId);
    validateSequence(position?.sequence);
    const key = await this.replayKey(position.roomInstance, position.senderId, position.sessionId);
    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(REPLAY_STORE, "readwrite", { durability: "strict" });
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);

    try {
      const store = transaction.objectStore(REPLAY_STORE);
      const candidate = await requestResult(store.get(key));
      const prior = candidate === undefined ? null : validateReplayRecord(candidate, key, position.roomInstance);
      if (prior && position.sequence <= prior.maxSequence) {
        await done;
        return { accepted: false, reason: "replay", currentSequence: prior.maxSequence };
      }

      const previousSequence = prior?.maxSequence || 0;
      const record: ReplayRecord = {
        recordVersion: RECORD_VERSION,
        kind: "replay",
        key,
        roomInstance: position.roomInstance,
        maxSequence: position.sequence,
        updatedAt: this.validNow(),
      };
      await requestResult(store.put(record));
      await done;
      return { accepted: true, previousSequence, currentSequence: position.sequence };
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }

  async replayHighWater(position: Omit<ReplayPosition, "sequence">): Promise<number | null> {
    validateRoomInstance(position?.roomInstance);
    validateReplayIdentity(position?.senderId, position?.sessionId);
    const key = await this.replayKey(position.roomInstance, position.senderId, position.sessionId);
    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(REPLAY_STORE, "readonly");
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);
    try {
      const candidate = await requestResult(transaction.objectStore(REPLAY_STORE).get(key));
      const record = candidate === undefined ? null : validateReplayRecord(candidate, key, position.roomInstance);
      await done;
      return record?.maxSequence ?? null;
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }

  async loadOpaqueState(roomInstance: string): Promise<OpaqueCryptoStateSnapshot | null> {
    validateRoomInstance(roomInstance);
    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(CRYPTO_STATE_STORE, "readonly");
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);
    try {
      const candidate = await requestResult(transaction.objectStore(CRYPTO_STATE_STORE).get(roomInstance));
      const record = candidate === undefined ? null : validateOpaqueStateRecord(candidate, roomInstance);
      await done;
      if (!record) return null;
      return {
        revision: record.revision,
        state: new Uint8Array(record.state.slice(0)),
        updatedAt: record.updatedAt,
      };
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }

  /**
   * Atomically replaces a complete, caller-serialized cryptographic snapshot.
   * The caller must hold the matching RoomCryptoLockLease for the full
   * read/transition/commit boundary. A revision conflict is fatal to that
   * transition: reload durable state instead of retrying with last-write-wins.
   * Bytes are opaque to this store and are not encrypted by it; a protocol
   * adapter must version, room-bind, and wrap secret state as its threat model
   * requires.
   */
  async compareAndSetOpaqueState(
    roomInstance: string,
    expectedRevision: number | null,
    state: Uint8Array
  ): Promise<OpaqueCryptoStateCommitResult> {
    validateRoomInstance(roomInstance);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new CryptoStateStoreError("invalid-input", "invalid expected cryptographic state revision");
    }
    if (!(state instanceof Uint8Array) || state.byteLength < 1 || state.byteLength > MAX_OPAQUE_STATE_BYTES) {
      throw new CryptoStateStoreError("invalid-input", "invalid opaque cryptographic state payload");
    }

    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(CRYPTO_STATE_STORE, "readwrite", { durability: "strict" });
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(CRYPTO_STATE_STORE);
      const candidate = await requestResult(store.get(roomInstance));
      const prior = candidate === undefined ? null : validateOpaqueStateRecord(candidate, roomInstance);
      const currentRevision = prior?.revision ?? null;
      if (currentRevision !== expectedRevision) {
        await done;
        return { committed: false, reason: "revision-conflict", currentRevision };
      }

      const revision = (currentRevision || 0) + 1;
      const copiedState = state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength) as ArrayBuffer;
      const record: OpaqueCryptoStateRecord = {
        recordVersion: RECORD_VERSION,
        kind: "opaque-state",
        roomInstance,
        revision,
        state: copiedState,
        updatedAt: this.validNow(),
      };
      await requestResult(store.put(record));
      await done;
      return { committed: true, revision };
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }

  /**
   * Erases only the secret-bearing opaque snapshot. Replay high-water records
   * and migration tombstones intentionally survive terminal room cleanup so a
   * delayed ciphertext cannot become fresh again after leave/rejoin.
   */
  async compareAndDeleteOpaqueState(
    roomInstance: string,
    expectedRevision: number
  ): Promise<OpaqueCryptoStateEraseResult> {
    validateRoomInstance(roomInstance);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new CryptoStateStoreError("invalid-input", "invalid expected cryptographic state revision");
    }

    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(CRYPTO_STATE_STORE, "readwrite", { durability: "strict" });
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(CRYPTO_STATE_STORE);
      const candidate = await requestResult(store.get(roomInstance));
      const prior = candidate === undefined ? null : validateOpaqueStateRecord(candidate, roomInstance);
      const currentRevision = prior?.revision ?? null;
      if (currentRevision !== expectedRevision) {
        await done;
        return { erased: false, reason: "revision-conflict", currentRevision };
      }
      await requestResult(store.delete(roomInstance));
      await done;
      return { erased: true, revision: expectedRevision };
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }

  async migrateLegacyReplayLedger(input: LegacyReplayMigrationInput): Promise<LegacyReplayMigrationResult> {
    validateRoomInstance(input?.roomInstance);
    const markerKey = migrationKey(input.roomInstance);
    const existingMarker = await this.readMigrationMarker(input.roomInstance);
    if (existingMarker) {
      return { migrated: false, reason: "already-migrated", importedEntries: existingMarker.importedEntries };
    }

    const entries = parseLegacyReplayLedger(input.rawLedger, input.roomId);
    const prepared = await Promise.all(entries.map(async (entry) => ({
      ...entry,
      key: await this.replayKey(input.roomInstance, entry.senderId, entry.sessionId),
    })));
    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction([REPLAY_STORE, METADATA_STORE], "readwrite", { durability: "strict" });
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);

    try {
      const replayStore = transaction.objectStore(REPLAY_STORE);
      const metadataStore = transaction.objectStore(METADATA_STORE);
      const concurrentMarkerCandidate = await requestResult(metadataStore.get(markerKey));
      if (concurrentMarkerCandidate !== undefined) {
        const marker = validateMigrationRecord(concurrentMarkerCandidate, input.roomInstance);
        await done;
        return { migrated: false, reason: "already-migrated", importedEntries: marker.importedEntries };
      }

      // Issue every read while the transaction is active, then merge by maximum.
      const candidates = await Promise.all(prepared.map((entry) => requestResult(replayStore.get(entry.key))));
      for (let index = 0; index < prepared.length; index += 1) {
        const entry = prepared[index];
        const candidate = candidates[index];
        const prior = candidate === undefined ? null : validateReplayRecord(candidate, entry.key, input.roomInstance);
        if (!prior || entry.sequence > prior.maxSequence) {
          const record: ReplayRecord = {
            recordVersion: RECORD_VERSION,
            kind: "replay",
            key: entry.key,
            roomInstance: input.roomInstance,
            maxSequence: entry.sequence,
            updatedAt: this.validNow(),
          };
          replayStore.put(record);
        }
      }

      const marker: MigrationRecord = {
        recordVersion: RECORD_VERSION,
        kind: "legacy-replay-migration",
        key: markerKey,
        roomInstance: input.roomInstance,
        sourceVersion: 1,
        importedEntries: prepared.length,
        migratedAt: this.validNow(),
      };
      await requestResult(metadataStore.put(marker));
      await done;
      return { migrated: true, importedEntries: prepared.length };
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }

  private async database(): Promise<IDBDatabase> {
    if (!this.factory) {
      throw new CryptoStateStoreError("unsupported", "IndexedDB is required for durable cryptographic state");
    }
    if (this.databasePromise) return this.databasePromise;

    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let settled = false;
      let upgradeError: unknown;
      const fail = (error: CryptoStateStoreError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        request = this.factory!.open(this.databaseName, DATABASE_VERSION);
      } catch (error) {
        fail(new CryptoStateStoreError("open-failed", "could not open cryptographic state database", error));
        return;
      }

      request.onupgradeneeded = (event) => {
        try {
          if (event.oldVersion !== 0) {
            throw new CryptoStateStoreError("schema-invalid", "unsupported cryptographic state database upgrade path");
          }
          const database = request.result;
          const replay = database.createObjectStore(REPLAY_STORE, { keyPath: "key" });
          replay.createIndex(ROOM_INDEX, "roomInstance", { unique: false });
          database.createObjectStore(CRYPTO_STATE_STORE, { keyPath: "roomInstance" });
          database.createObjectStore(METADATA_STORE, { keyPath: "key" });
        } catch (error) {
          upgradeError = error;
          abortQuietly(request.transaction!);
        }
      };
      request.onblocked = () => fail(new CryptoStateStoreError(
        "open-failed",
        "cryptographic state database upgrade is blocked by another context"
      ));
      request.onerror = () => fail(new CryptoStateStoreError(
        upgradeError instanceof CryptoStateStoreError ? upgradeError.code : "open-failed",
        "could not initialize cryptographic state database",
        upgradeError || request.error
      ));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        try {
          this.validateDatabaseSchema(database);
        } catch (error) {
          database.close();
          fail(error instanceof CryptoStateStoreError
            ? error
            : new CryptoStateStoreError("schema-invalid", "invalid cryptographic state database schema", error));
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          if (this.databasePromise === pending) this.databasePromise = null;
        };
        database.onclose = () => {
          if (this.databasePromise === pending) this.databasePromise = null;
        };
        resolve(database);
      };
    });

    this.databasePromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.databasePromise === pending) this.databasePromise = null;
      throw error;
    }
  }

  private validateDatabaseSchema(database: IDBDatabase): void {
    const expectedStores = [CRYPTO_STATE_STORE, METADATA_STORE, REPLAY_STORE].sort();
    const actualStores = Array.from(database.objectStoreNames).sort();
    if (
      database.version !== DATABASE_VERSION
      || actualStores.length !== expectedStores.length
      || !actualStores.every((name, index) => name === expectedStores[index])
    ) {
      throw new CryptoStateStoreError("schema-invalid", "unexpected cryptographic state database stores");
    }

    const transaction = database.transaction([REPLAY_STORE, CRYPTO_STATE_STORE, METADATA_STORE], "readonly");
    try {
      const replay = transaction.objectStore(REPLAY_STORE);
      const state = transaction.objectStore(CRYPTO_STATE_STORE);
      const metadata = transaction.objectStore(METADATA_STORE);
      if (
        replay.keyPath !== "key"
        || replay.autoIncrement
        || replay.indexNames.length !== 1
        || !replay.indexNames.contains(ROOM_INDEX)
        || replay.index(ROOM_INDEX).keyPath !== "roomInstance"
        || replay.index(ROOM_INDEX).unique
        || state.keyPath !== "roomInstance"
        || state.autoIncrement
        || state.indexNames.length !== 0
        || metadata.keyPath !== "key"
        || metadata.autoIncrement
        || metadata.indexNames.length !== 0
      ) {
        throw new CryptoStateStoreError("schema-invalid", "unexpected cryptographic state database schema");
      }
    } finally {
      abortQuietly(transaction);
    }
  }

  private async replayKey(roomInstance: string, senderId: string, sessionId: string): Promise<string> {
    if (!this.cryptoProvider?.subtle) {
      throw new CryptoStateStoreError("unsupported", "WebCrypto is required for replay-state indexing");
    }
    const canonical = new TextEncoder().encode(JSON.stringify([
      "pillowfort-replay-position",
      1,
      roomInstance,
      senderId,
      sessionId,
    ]));
    try {
      const digest = await this.cryptoProvider.subtle.digest("SHA-256", canonical);
      return `r1_${toBase64Url(new Uint8Array(digest))}`;
    } catch (error) {
      throw new CryptoStateStoreError("unsupported", "WebCrypto replay-state digest failed", error);
    }
  }

  private validNow(): number {
    const value = this.now();
    if (!validTimestamp(value)) {
      throw new CryptoStateStoreError("invalid-input", "invalid cryptographic state timestamp");
    }
    return value;
  }

  private async readMigrationMarker(roomInstance: string): Promise<MigrationRecord | null> {
    const database = await this.database();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(METADATA_STORE, "readonly");
    } catch (error) {
      throw transactionError(error);
    }
    const done = transactionDone(transaction);
    try {
      const candidate = await requestResult(transaction.objectStore(METADATA_STORE).get(migrationKey(roomInstance)));
      const record = candidate === undefined ? null : validateMigrationRecord(candidate, roomInstance);
      await done;
      return record;
    } catch (error) {
      abortQuietly(transaction);
      await done.catch(() => {});
      throw transactionError(error);
    }
  }
}
