import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer, type ViteDevServer } from "../client/node_modules/vite/dist/node/index.js";

let vite: ViteDevServer;
let baseUrl: string;
const contexts: BrowserContext[] = [];
const profileDirectories: string[] = [];

beforeAll(async () => {
  vite = await createServer({
    root: join(import.meta.dir, "../client"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  baseUrl = vite.resolvedUrls?.local[0] || vite.resolvedUrls?.network[0] || "";
  if (!baseUrl) throw new Error("Vite did not expose a replay-persistence test URL");
}, 30_000);

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    try { await context.close(); } catch {}
  }
}, 30_000);

afterAll(async () => {
  for (const context of contexts.splice(0)) {
    try { await context.close(); } catch {}
  }
  await vite?.close();
  for (const directory of profileDirectories.splice(0)) {
    try { await rm(directory, { recursive: true, force: true }); } catch {}
  }
}, 30_000);

async function persistentContext(profileDirectory: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profileDirectory, { headless: true });
  contexts.push(context);
  return context;
}

async function readyPage(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(baseUrl);
  return page;
}

function uniqueDatabase(label: string): string {
  return `pillowfort-test-${label}-${crypto.randomUUID()}`;
}

describe("durable replay and cryptographic state", () => {
  it("derives opaque v4 store keys and erases secrets without erasing replay tombstones", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-v4-state-profile-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("v4-state-erasure");
    const context = await persistentContext(profile);
    const page = await readyPage(context);
    const result = await page.evaluate(async ({ databaseName }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const encode = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
      };
      const publicRoomInstance = encode(crypto.getRandomValues(new Uint8Array(16)));
      const opaqueRoomInstance = await module.deriveCryptoRoomInstanceV4(publicRoomInstance);
      const repeatedDerivation = await module.deriveCryptoRoomInstanceV4(publicRoomInstance);
      const legacyDomainKey = await module.deriveCryptoRoomInstance(publicRoomInstance, "A".repeat(43));
      const store = new module.CryptoStateStore({ databaseName, now: () => 4_321 });
      const committed = await store.compareAndSetOpaqueState(
        opaqueRoomInstance,
        null,
        new Uint8Array([7, 8, 9]),
      );
      await store.advanceReplay({
        roomInstance: opaqueRoomInstance,
        senderId: "member",
        sessionId: "abcdefghijklmnop",
        sequence: 12,
      });
      const staleErase = await store.compareAndDeleteOpaqueState(opaqueRoomInstance, 2);
      const stateAfterStaleErase = await store.loadOpaqueState(opaqueRoomInstance);
      const erased = await store.compareAndDeleteOpaqueState(opaqueRoomInstance, 1);
      const stateAfterErase = await store.loadOpaqueState(opaqueRoomInstance);
      const replayAfterErase = await store.advanceReplay({
        roomInstance: opaqueRoomInstance,
        senderId: "member",
        sessionId: "abcdefghijklmnop",
        sequence: 12,
      });
      const recreated = await store.compareAndSetOpaqueState(
        opaqueRoomInstance,
        null,
        new Uint8Array([10]),
      );
      const replayAfterRecreate = await store.replayHighWater({
        roomInstance: opaqueRoomInstance,
        senderId: "member",
        sessionId: "abcdefghijklmnop",
      });
      await store.close();
      return {
        publicRoomInstance,
        opaqueRoomInstance,
        repeatedDerivation,
        legacyDomainKey,
        committed,
        staleErase,
        stateAfterStaleErase: stateAfterStaleErase && [...stateAfterStaleErase.state],
        erased,
        stateAfterErase,
        replayAfterErase,
        recreated,
        replayAfterRecreate,
      };
    }, { databaseName });

    expect(result.opaqueRoomInstance).toBe(result.repeatedDerivation);
    expect(result.opaqueRoomInstance).not.toContain(result.publicRoomInstance);
    expect(result.opaqueRoomInstance).not.toBe(result.legacyDomainKey);
    expect(result.committed).toEqual({ committed: true, revision: 1 });
    expect(result.staleErase).toEqual({
      erased: false,
      reason: "revision-conflict",
      currentRevision: 1,
    });
    expect(result.stateAfterStaleErase).toEqual([7, 8, 9]);
    expect(result.erased).toEqual({ erased: true, revision: 1 });
    expect(result.stateAfterErase).toBeNull();
    expect(result.replayAfterErase).toEqual({ accepted: false, reason: "replay", currentSequence: 12 });
    expect(result.recreated).toEqual({ committed: true, revision: 1 });
    expect(result.replayAfterRecreate).toBe(12);
  }, 30_000);

  it("rejects the same replay position after a persistent browser profile restarts", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-replay-profile-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("restart");

    let context = await persistentContext(profile);
    let page = await readyPage(context);
    const first = await page.evaluate(async ({ databaseName }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const roomInstance = await module.deriveCryptoRoomInstance("restart-room", "A".repeat(43));
      const store = new module.CryptoStateStore({ databaseName });
      const result = await store.advanceReplay({
        roomInstance,
        senderId: "alice",
        sessionId: "abcdefghijklmnop",
        sequence: 7,
      });
      await store.close();
      return { roomInstance, result };
    }, { databaseName });
    expect(first.result).toEqual({ accepted: true, previousSequence: 0, currentSequence: 7 });

    contexts.splice(contexts.indexOf(context), 1);
    await context.close();
    context = await persistentContext(profile);
    page = await readyPage(context);
    const afterRestart = await page.evaluate(async ({ databaseName, roomInstance }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const store = new module.CryptoStateStore({ databaseName });
      const replay = await store.advanceReplay({
        roomInstance,
        senderId: "alice",
        sessionId: "abcdefghijklmnop",
        sequence: 7,
      });
      const next = await store.advanceReplay({
        roomInstance,
        senderId: "alice",
        sessionId: "abcdefghijklmnop",
        sequence: 8,
      });
      await store.close();
      return { replay, next };
    }, { databaseName, roomInstance: first.roomInstance });

    expect(afterRestart.replay).toEqual({ accepted: false, reason: "replay", currentSequence: 7 });
    expect(afterRestart.next).toEqual({ accepted: true, previousSequence: 7, currentSequence: 8 });
  }, 30_000);

  it("serializes concurrent compare-and-advance operations across tabs", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-replay-tabs-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("tabs");
    const context = await persistentContext(profile);
    const firstPage = await readyPage(context);
    const secondPage = await context.newPage();
    await secondPage.goto(baseUrl);
    const roomInstance = await firstPage.evaluate(async () => {
      const module = await import("/src/services/cryptoStateStore.ts");
      return module.deriveCryptoRoomInstance("tabs-room", "B".repeat(43));
    });
    const input = { databaseName, roomInstance };
    const advance = (page: Page) => page.evaluate(async ({ databaseName, roomInstance }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const store = new module.CryptoStateStore({ databaseName });
      try {
        return await store.advanceReplay({
          roomInstance,
          senderId: "bob",
          sessionId: "qrstuvwxyzABCDEF",
          sequence: 11,
        });
      } finally {
        await store.close();
      }
    }, input);

    const results = await Promise.all([advance(firstPage), advance(secondPage)]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toEqual([
      { accepted: false, reason: "replay", currentSequence: 11 },
    ]);
  }, 30_000);

  it("uses revision CAS for opaque state and migrates one room from the strict v1 ledger", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-replay-migrate-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("migration");
    const context = await persistentContext(profile);
    const page = await readyPage(context);
    const result = await page.evaluate(async ({ databaseName }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const roomInstance = await module.deriveCryptoRoomInstance("legacy-room", "C".repeat(43));
      const store = new module.CryptoStateStore({ databaseName, now: () => 1234 });
      const firstCommit = await store.compareAndSetOpaqueState(roomInstance, null, new Uint8Array([1, 2, 3]));
      const conflictingCommit = await store.compareAndSetOpaqueState(roomInstance, null, new Uint8Array([9]));
      const secondCommit = await store.compareAndSetOpaqueState(roomInstance, 1, new Uint8Array([4, 5]));
      const snapshot = await store.loadOpaqueState(roomInstance);
      const occupiedDestination = await module.deriveCryptoRoomInstance("occupied-room", "D".repeat(43));
      await store.compareAndSetOpaqueState(occupiedDestination, null, new Uint8Array([7, 8]));
      const conflictingMove = await store.compareAndMoveOpaqueState(roomInstance, 2, occupiedDestination);
      const sourceAfterMoveConflict = await store.loadOpaqueState(roomInstance);
      const destinationAfterMoveConflict = await store.loadOpaqueState(occupiedDestination);

      const rawLedger = JSON.stringify({
        v: 1,
        entries: [
          { key: JSON.stringify(["legacy-room", "alice", "abcdefghijklmnop"]), seq: 15, seenAt: 100 },
          { key: JSON.stringify(["other-room", "mallory", "qrstuvwxyzABCDEF"]), seq: 99, seenAt: 101 },
        ],
      });
      const migration = await store.migrateLegacyReplayLedger({ roomId: "legacy-room", roomInstance, rawLedger });
      const repeatedMigration = await store.migrateLegacyReplayLedger({ roomId: "legacy-room", roomInstance, rawLedger });
      const highWater = await store.replayHighWater({
        roomInstance,
        senderId: "alice",
        sessionId: "abcdefghijklmnop",
      });
      const replay = await store.advanceReplay({
        roomInstance,
        senderId: "alice",
        sessionId: "abcdefghijklmnop",
        sequence: 15,
      });
      await store.close();
      return {
        firstCommit,
        conflictingCommit,
        secondCommit,
        snapshot: snapshot && { ...snapshot, state: [...snapshot.state] },
        conflictingMove,
        sourceAfterMoveConflict: sourceAfterMoveConflict && [...sourceAfterMoveConflict.state],
        destinationAfterMoveConflict: destinationAfterMoveConflict && [...destinationAfterMoveConflict.state],
        migration,
        repeatedMigration,
        highWater,
        replay,
      };
    }, { databaseName });

    expect(result.firstCommit).toEqual({ committed: true, revision: 1 });
    expect(result.conflictingCommit).toEqual({ committed: false, reason: "revision-conflict", currentRevision: 1 });
    expect(result.secondCommit).toEqual({ committed: true, revision: 2 });
    expect(result.snapshot).toEqual({ revision: 2, state: [4, 5], updatedAt: 1234 });
    expect(result.conflictingMove).toEqual({ moved: false, reason: "destination-exists", currentRevision: 1 });
    expect(result.sourceAfterMoveConflict).toEqual([4, 5]);
    expect(result.destinationAfterMoveConflict).toEqual([7, 8]);
    expect(result.migration).toEqual({ migrated: true, importedEntries: 1 });
    expect(result.repeatedMigration).toEqual({ migrated: false, reason: "already-migrated", importedEntries: 1 });
    expect(result.highWater).toBe(15);
    expect(result.replay).toEqual({ accepted: false, reason: "replay", currentSequence: 15 });
  }, 30_000);

  it("bounds provisional identities without evicting established or ambiguous state", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-provisional-registry-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("provisional-registry");
    const context = await persistentContext(profile);
    const page = await readyPage(context);
    const result = await page.evaluate(async ({ databaseName }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const derive = (label: string) => module.deriveCryptoRoomInstance(label, "E".repeat(43));
      const store = new module.CryptoStateStore({ databaseName, now: () => 5_000 });
      const scope = await derive("scope-main");
      const firstKey = await derive("state-first");
      const first = await store.createProvisionalOpaqueState(firstKey, scope, new Uint8Array([1]));
      const deleted = await store.compareAndDeleteOpaqueState(firstKey, 1);
      const recreated = await store.createProvisionalOpaqueState(firstKey, scope, new Uint8Array([2]));
      const ambiguous = await store.markOpaqueStateAuthenticationAmbiguous(firstKey, 1);
      const ambiguousAgain = await store.markOpaqueStateAuthenticationAmbiguous(firstKey, 2);
      const ambiguousSnapshot = await store.loadOpaqueState(firstKey);
      const established = await store.markOpaqueStateEstablished(firstKey, 2);
      const duplicateAfterEstablish = await store.createProvisionalOpaqueState(
        firstKey, scope, new Uint8Array([9]),
      );
      const moveSource = await derive("state-move-source");
      const moveDestination = await derive("state-move-destination");
      await store.createProvisionalOpaqueState(moveSource, await derive("scope-move"), new Uint8Array([8]));
      await store.markOpaqueStateAuthenticationAmbiguous(moveSource, 1);
      const movedAmbiguous = await store.compareAndMoveOpaqueState(moveSource, 2, moveDestination);
      const movedAmbiguousSnapshot = await store.loadOpaqueState(moveDestination);
      const deletedMovedAmbiguous = await store.compareAndDeleteOpaqueState(moveDestination, 2);

      const sameRoomCreates = [];
      for (let index = 0; index < 4; index += 1) {
        sameRoomCreates.push(await store.createProvisionalOpaqueState(
          await derive(`state-same-${index}`), scope, new Uint8Array([10 + index]),
        ));
      }
      const sameRoomOverflowKey = await derive("state-same-overflow");
      const sameRoomOverflow = await store.createProvisionalOpaqueState(
        sameRoomOverflowKey, scope, new Uint8Array([20]),
      );

      const globalCreates = [];
      for (let index = 0; index < 12; index += 1) {
        globalCreates.push(await store.createProvisionalOpaqueState(
          await derive(`state-global-${index}`),
          await derive(`scope-global-${index}`),
          new Uint8Array([30 + index]),
        ));
      }
      const globalOverflowKey = await derive("state-global-overflow");
      const globalOverflow = await store.createProvisionalOpaqueState(
        globalOverflowKey,
        await derive("scope-global-overflow"),
        new Uint8Array([99]),
      );
      const establishedSnapshot = await store.loadOpaqueState(firstKey);
      const preservedAmbiguous = await Promise.all(sameRoomCreates.map(async (_entry, index) =>
        store.loadOpaqueState(await derive(`state-same-${index}`))));
      const rejectedKeysWereNotWritten = await store.loadOpaqueState(sameRoomOverflowKey) === null &&
        await store.loadOpaqueState(globalOverflowKey) === null;
      await store.close();
      return {
        first,
        deleted,
        recreated,
        ambiguous,
        ambiguousAgain,
        ambiguousLifecycle: ambiguousSnapshot?.lifecycle,
        established,
        duplicateAfterEstablish,
        movedAmbiguous,
        movedAmbiguousLifecycle: movedAmbiguousSnapshot?.lifecycle,
        deletedMovedAmbiguous,
        sameRoomCreates,
        sameRoomOverflow,
        globalCreates,
        globalOverflow,
        establishedSnapshot: establishedSnapshot && {
          revision: establishedSnapshot.revision,
          state: [...establishedSnapshot.state],
        },
        preservedAmbiguous: preservedAmbiguous.every(Boolean),
        rejectedKeysWereNotWritten,
      };
    }, { databaseName });

    expect(result.first).toEqual({ committed: true, revision: 1 });
    expect(result.deleted).toEqual({ erased: true, revision: 1 });
    expect(result.recreated).toEqual({ committed: true, revision: 1 });
    expect(result.ambiguous).toEqual({ committed: true, revision: 2 });
    expect(result.ambiguousAgain).toEqual({ committed: true, revision: 2 });
    expect(result.ambiguousLifecycle).toBe("authentication-ambiguous");
    expect(result.established).toEqual({ committed: true, revision: 3 });
    expect(result.duplicateAfterEstablish).toEqual({
      committed: false, reason: "revision-conflict", currentRevision: 3,
    });
    expect(result.movedAmbiguous).toEqual({ moved: true, revision: 2 });
    expect(result.movedAmbiguousLifecycle).toBe("authentication-ambiguous");
    expect(result.deletedMovedAmbiguous).toEqual({ erased: true, revision: 2 });
    expect(result.sameRoomCreates).toEqual(Array(4).fill({ committed: true, revision: 1 }));
    expect(result.sameRoomOverflow).toEqual({
      committed: false, reason: "provisional-saturated", currentRevision: null,
    });
    expect(result.globalCreates).toEqual(Array(12).fill({ committed: true, revision: 1 }));
    expect(result.globalOverflow).toEqual({
      committed: false, reason: "provisional-saturated", currentRevision: null,
    });
    expect(result.establishedSnapshot).toEqual({ revision: 3, state: [2] });
    expect(result.preservedAmbiguous).toBe(true);
    expect(result.rejectedKeysWereNotWritten).toBe(true);
  }, 30_000);

  it("fails closed for unavailable, corrupt, saturated, and transaction-failing storage", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-replay-failures-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("failures");
    const context = await persistentContext(profile);
    const page = await readyPage(context);
    const result = await page.evaluate(async ({ databaseName }) => {
      const module = await import("/src/services/cryptoStateStore.ts");
      const roomInstance = await module.deriveCryptoRoomInstance("failure-room", "D".repeat(43));
      const position = {
        roomInstance,
        senderId: "alice",
        sessionId: "abcdefghijklmnop",
        sequence: 1,
      };
      const errorCode = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code || "unknown";
        }
      };

      const unsupported = await errorCode(() => new module.CryptoStateStore({ indexedDB: null }).open());
      const store = new module.CryptoStateStore({ databaseName });
      await store.advanceReplay(position);

      const direct = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = direct.transaction("replay-high-water", "readwrite");
        const request = transaction.objectStore("replay-high-water").openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return reject(new Error("missing replay test record"));
          cursor.update({ ...cursor.value, unexpected: true });
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      direct.close();
      const corrupt = await errorCode(() => store.advanceReplay({ ...position, sequence: 2 }));
      await store.close();

      const transactionStore = new module.CryptoStateStore({ databaseName: `${databaseName}-transaction` });
      await transactionStore.open();
      const originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function () {
        throw new DOMException("injected transaction failure", "QuotaExceededError");
      } as typeof IDBDatabase.prototype.transaction;
      const transactionFailure = await errorCode(() => transactionStore.advanceReplay(position));
      IDBDatabase.prototype.transaction = originalTransaction;
      await transactionStore.close();

      const saturatedStore = new module.CryptoStateStore({ databaseName: `${databaseName}-legacy` });
      const legacySaturated = await errorCode(() => saturatedStore.migrateLegacyReplayLedger({
        roomId: "failure-room",
        roomInstance,
        rawLedger: JSON.stringify({ v: 1, saturated: true, entries: [] }),
      }));
      const legacyNonCanonical = await errorCode(() => saturatedStore.migrateLegacyReplayLedger({
        roomId: "failure-room",
        roomInstance,
        rawLedger: JSON.stringify({
          v: 1,
          entries: [{ key: '[ "failure-room", "alice", "abcdefghijklmnop" ]', seq: 1, seenAt: 1 }],
        }),
      }));
      await saturatedStore.close();
      return { unsupported, corrupt, transactionFailure, legacySaturated, legacyNonCanonical };
    }, { databaseName });

    expect(result).toEqual({
      unsupported: "unsupported",
      corrupt: "corrupt-record",
      transactionFailure: "transaction-failed",
      legacySaturated: "legacy-saturated",
      legacyNonCanonical: "legacy-invalid",
    });
  }, 30_000);
});

describe("single-writer room cryptographic lock", () => {
  it("reports busy, cooperatively transfers ownership, and aborts the old lease", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-lock-tabs-"));
    profileDirectories.push(profile);
    const context = await persistentContext(profile);
    const ownerPage = await readyPage(context);
    const takeoverPage = await context.newPage();
    await takeoverPage.goto(baseUrl);
    const roomInstance = await ownerPage.evaluate(async () => {
      const module = await import("/src/services/cryptoStateStore.ts");
      return module.deriveCryptoRoomInstance("locked-room", "E".repeat(43));
    });

    const owner = await ownerPage.evaluate(async (roomInstance) => {
      const module = await import("/src/services/roomCryptoLock.ts");
      const coordinator = new module.RoomCryptoLockCoordinator();
      const result = await coordinator.acquire(roomInstance);
      if (result.status !== "acquired") return { status: result.status };
      Object.assign(globalThis, { testLockCoordinator: coordinator, testLockLease: result.lease });
      return { status: result.status, active: result.lease.isActive() };
    }, roomInstance);
    expect(owner).toEqual({ status: "acquired", active: true });

    const busy = await takeoverPage.evaluate(async (roomInstance) => {
      const module = await import("/src/services/roomCryptoLock.ts");
      const coordinator = new module.RoomCryptoLockCoordinator();
      Object.assign(globalThis, { testLockCoordinator: coordinator });
      const result = await coordinator.acquire(roomInstance);
      return result.status === "busy" ? { status: result.status, reason: result.reason } : { status: result.status };
    }, roomInstance);
    expect(busy).toEqual({ status: "busy", reason: "held-in-another-context" });

    const takeover = await takeoverPage.evaluate(async (roomInstance) => {
      const coordinator = (globalThis as typeof globalThis & { testLockCoordinator: any }).testLockCoordinator;
      const result = await coordinator.acquire(roomInstance, { takeover: true, timeoutMs: 3_000 });
      if (result.status !== "acquired") return { status: result.status, reason: result.reason };
      Object.assign(globalThis, { testLockLease: result.lease });
      return { status: result.status, active: result.lease.isActive() };
    }, roomInstance);
    expect(takeover).toEqual({ status: "acquired", active: true });

    const prior = await ownerPage.evaluate(async () => {
      const lease = (globalThis as typeof globalThis & { testLockLease: any }).testLockLease;
      return { active: lease.isActive(), reason: await lease.released, aborted: lease.signal.aborted };
    });
    expect(prior).toEqual({ active: false, reason: "takeover", aborted: true });

    await takeoverPage.evaluate(() => {
      const globals = globalThis as typeof globalThis & { testLockLease: any; testLockCoordinator: any };
      globals.testLockLease.release();
      globals.testLockCoordinator.close();
    });
    await ownerPage.evaluate(() => {
      (globalThis as typeof globalThis & { testLockCoordinator: any }).testLockCoordinator.close();
    });
  }, 30_000);

  it("does not silently fall back when Web Locks or takeover signaling are unavailable", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-lock-unsupported-"));
    profileDirectories.push(profile);
    const context = await persistentContext(profile);
    const page = await readyPage(context);
    const result = await page.evaluate(async () => {
      const stateModule = await import("/src/services/cryptoStateStore.ts");
      const lockModule = await import("/src/services/roomCryptoLock.ts");
      const roomInstance = await stateModule.deriveCryptoRoomInstance("unsupported-room", "F".repeat(43));
      const noLocks = new lockModule.RoomCryptoLockCoordinator({ locks: null, channelFactory: null });
      const noLocksResult = await noLocks.acquire(roomInstance);
      const noChannel = new lockModule.RoomCryptoLockCoordinator({ channelFactory: null });
      const noChannelResult = await noChannel.acquire(roomInstance, { takeover: true });
      const holder = new lockModule.RoomCryptoLockCoordinator();
      const held = await holder.acquire(roomInstance);
      const silentChannelFactory = () => ({ onmessage: null, postMessage() {}, close() {} });
      const waiting = new lockModule.RoomCryptoLockCoordinator({ channelFactory: silentChannelFactory });
      const timedOutTakeover = await waiting.acquire(roomInstance, { takeover: true, timeoutMs: 25 });
      if (held.status === "acquired") held.lease.release();
      noLocks.close();
      noChannel.close();
      holder.close();
      waiting.close();
      return { noLocksResult, noChannelResult, timedOutTakeover };
    });

    expect(result).toEqual({
      noLocksResult: { status: "unsupported", reason: "web-locks-unavailable" },
      noChannelResult: { status: "unsupported", reason: "takeover-channel-unavailable" },
      timedOutTakeover: { status: "failed", reason: "takeover-timeout" },
    });
  }, 30_000);
});
