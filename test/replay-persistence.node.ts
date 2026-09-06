import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer, type ViteDevServer } from "../client/node_modules/vite/dist/node/index.js";

let vite: ViteDevServer;
let fixtureUrl: string;
const contexts: BrowserContext[] = [];
const profileDirectories: string[] = [];
const FIXTURE_PATH = "/__test/replay-persistence.html";

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../client", import.meta.url)),
    logLevel: "error",
    plugins: [{
      name: "replay-persistence-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== FIXTURE_PATH) return next();
          // These tests import real modules directly; app startup is not part
          // of the IndexedDB, persistent-profile, or Web Locks contract.
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>Replay persistence</title></head><body></body></html>");
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const baseUrl = vite.resolvedUrls?.local[0] || vite.resolvedUrls?.network[0];
  if (!baseUrl) throw new Error("Vite did not expose a replay-persistence test URL");
  fixtureUrl = new URL(FIXTURE_PATH, baseUrl).href;
}, { timeout: 30_000 });

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await closePersistentContext(context);
  }
}, { timeout: 30_000 });

after(async () => {
  for (const context of contexts.splice(0)) {
    await closePersistentContext(context);
  }
  await vite?.close();
  for (const directory of profileDirectories.splice(0)) {
    try { await rm(directory, { recursive: true, force: true }); } catch {}
  }
}, { timeout: 30_000 });

async function closePersistentContext(context: BrowserContext): Promise<void> {
  try {
    for (const page of context.pages()) {
      await page.close();
    }
  } finally {
    await context.close();
  }
}

async function persistentContext(profileDirectory: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profileDirectory, { headless: true });
  contexts.push(context);
  return context;
}

async function readyPage(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(fixtureUrl);
  return page;
}

function uniqueDatabase(label: string): string {
  return `pillowfort-test-${label}-${crypto.randomUUID()}`;
}

describe("durable replay and cryptographic state", () => {
  it("derives opaque v4 store keys and erases secrets without erasing replay tombstones", { timeout: 30_000 }, async () => {
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
  
    assert.equal(result.opaqueRoomInstance, result.repeatedDerivation);
    assert.ok(!(result.opaqueRoomInstance).includes(result.publicRoomInstance));
    assert.notEqual(result.opaqueRoomInstance, result.legacyDomainKey);
    assert.deepEqual(result.committed, { committed: true, revision: 1 });
    assert.deepEqual(result.staleErase, {
      erased: false,
      reason: "revision-conflict",
      currentRevision: 1,
    });
    assert.deepEqual(result.stateAfterStaleErase, [7, 8, 9]);
    assert.deepEqual(result.erased, { erased: true, revision: 1 });
    assert.equal(result.stateAfterErase, null);
    assert.deepEqual(result.replayAfterErase, { accepted: false, reason: "replay", currentSequence: 12 });
    assert.deepEqual(result.recreated, { committed: true, revision: 1 });
    assert.equal(result.replayAfterRecreate, 12);
  });

  it("rejects the same replay position after a persistent browser profile restarts", { timeout: 30_000 }, async () => {
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
    assert.deepEqual(first.result, { accepted: true, previousSequence: 0, currentSequence: 7 });
  
    contexts.splice(contexts.indexOf(context), 1);
    await closePersistentContext(context);
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
  
    assert.deepEqual(afterRestart.replay, { accepted: false, reason: "replay", currentSequence: 7 });
    assert.deepEqual(afterRestart.next, { accepted: true, previousSequence: 7, currentSequence: 8 });
  });

  it("serializes concurrent compare-and-advance operations across tabs", { timeout: 30_000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-replay-tabs-"));
    profileDirectories.push(profile);
    const databaseName = uniqueDatabase("tabs");
    const context = await persistentContext(profile);
    const firstPage = await readyPage(context);
    const secondPage = await context.newPage();
    await secondPage.goto(fixtureUrl);
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
    assert.equal((results.filter((result) => result.accepted)).length, 1);
    assert.deepEqual(results.filter((result) => !result.accepted), [
      { accepted: false, reason: "replay", currentSequence: 11 },
    ]);
  });

  it("uses revision CAS for opaque state and migrates one room from the strict v1 ledger", { timeout: 30_000 }, async () => {
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
  
    assert.deepEqual(result.firstCommit, { committed: true, revision: 1 });
    assert.deepEqual(result.conflictingCommit, { committed: false, reason: "revision-conflict", currentRevision: 1 });
    assert.deepEqual(result.secondCommit, { committed: true, revision: 2 });
    assert.deepEqual(result.snapshot, { revision: 2, state: [4, 5], updatedAt: 1234 });
    assert.deepEqual(result.conflictingMove, { moved: false, reason: "destination-exists", currentRevision: 1 });
    assert.deepEqual(result.sourceAfterMoveConflict, [4, 5]);
    assert.deepEqual(result.destinationAfterMoveConflict, [7, 8]);
    assert.deepEqual(result.migration, { migrated: true, importedEntries: 1 });
    assert.deepEqual(result.repeatedMigration, { migrated: false, reason: "already-migrated", importedEntries: 1 });
    assert.equal(result.highWater, 15);
    assert.deepEqual(result.replay, { accepted: false, reason: "replay", currentSequence: 15 });
  });

  it("bounds provisional identities without evicting established or ambiguous state", { timeout: 30_000 }, async () => {
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
  
    assert.deepEqual(result.first, { committed: true, revision: 1 });
    assert.deepEqual(result.deleted, { erased: true, revision: 1 });
    assert.deepEqual(result.recreated, { committed: true, revision: 1 });
    assert.deepEqual(result.ambiguous, { committed: true, revision: 2 });
    assert.deepEqual(result.ambiguousAgain, { committed: true, revision: 2 });
    assert.equal(result.ambiguousLifecycle, "authentication-ambiguous");
    assert.deepEqual(result.established, { committed: true, revision: 3 });
    assert.deepEqual(result.duplicateAfterEstablish, {
      committed: false, reason: "revision-conflict", currentRevision: 3,
    });
    assert.deepEqual(result.movedAmbiguous, { moved: true, revision: 2 });
    assert.equal(result.movedAmbiguousLifecycle, "authentication-ambiguous");
    assert.deepEqual(result.deletedMovedAmbiguous, { erased: true, revision: 2 });
    assert.deepEqual(result.sameRoomCreates, Array(4).fill({ committed: true, revision: 1 }));
    assert.deepEqual(result.sameRoomOverflow, {
      committed: false, reason: "provisional-saturated", currentRevision: null,
    });
    assert.deepEqual(result.globalCreates, Array(12).fill({ committed: true, revision: 1 }));
    assert.deepEqual(result.globalOverflow, {
      committed: false, reason: "provisional-saturated", currentRevision: null,
    });
    assert.deepEqual(result.establishedSnapshot, { revision: 3, state: [2] });
    assert.equal(result.preservedAmbiguous, true);
    assert.equal(result.rejectedKeysWereNotWritten, true);
  });

  it("fails closed for unavailable, corrupt, saturated, and transaction-failing storage", { timeout: 30_000 }, async () => {
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
  
    assert.deepEqual(result, {
      unsupported: "unsupported",
      corrupt: "corrupt-record",
      transactionFailure: "transaction-failed",
      legacySaturated: "legacy-saturated",
      legacyNonCanonical: "legacy-invalid",
    });
  });
});

describe("single-writer room cryptographic lock", () => {
  it("reports busy, cooperatively transfers ownership, and aborts the old lease", { timeout: 30_000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-lock-tabs-"));
    profileDirectories.push(profile);
    const context = await persistentContext(profile);
    const ownerPage = await readyPage(context);
    const takeoverPage = await context.newPage();
    await takeoverPage.goto(fixtureUrl);
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
    assert.deepEqual(owner, { status: "acquired", active: true });
  
    const busy = await takeoverPage.evaluate(async (roomInstance) => {
      const module = await import("/src/services/roomCryptoLock.ts");
      const coordinator = new module.RoomCryptoLockCoordinator();
      Object.assign(globalThis, { testLockCoordinator: coordinator });
      const result = await coordinator.acquire(roomInstance);
      return result.status === "busy" ? { status: result.status, reason: result.reason } : { status: result.status };
    }, roomInstance);
    assert.deepEqual(busy, { status: "busy", reason: "held-in-another-context" });
  
    const takeover = await takeoverPage.evaluate(async (roomInstance) => {
      const coordinator = (globalThis as typeof globalThis & { testLockCoordinator: any }).testLockCoordinator;
      const result = await coordinator.acquire(roomInstance, { takeover: true, timeoutMs: 3_000 });
      if (result.status !== "acquired") return { status: result.status, reason: result.reason };
      Object.assign(globalThis, { testLockLease: result.lease });
      return { status: result.status, active: result.lease.isActive() };
    }, roomInstance);
    assert.deepEqual(takeover, { status: "acquired", active: true });
  
    const prior = await ownerPage.evaluate(async () => {
      const lease = (globalThis as typeof globalThis & { testLockLease: any }).testLockLease;
      return { active: lease.isActive(), reason: await lease.released, aborted: lease.signal.aborted };
    });
    assert.deepEqual(prior, { active: false, reason: "takeover", aborted: true });
  
    await takeoverPage.evaluate(() => {
      const globals = globalThis as typeof globalThis & { testLockLease: any; testLockCoordinator: any };
      globals.testLockLease.release();
      globals.testLockCoordinator.close();
    });
    await ownerPage.evaluate(() => {
      (globalThis as typeof globalThis & { testLockCoordinator: any }).testLockCoordinator.close();
    });
  });

  it("does not silently fall back when Web Locks or takeover signaling are unavailable", { timeout: 30_000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "pillowfort-lock-unsupported-"));
    profileDirectories.push(profile);
    const context = await persistentContext(profile);
    const page = await readyPage(context);
    const result = await page.evaluate(async () => {
      const stateModule = await import("/src/services/cryptoStateStore.ts");
      const lockModule = await import("/src/services/roomCryptoLock.ts");
      const roomInstance = await stateModule.deriveCryptoRoomInstance("unsupported-room", "F".repeat(43));
      const nativeRequests: Promise<unknown>[] = [];
      const locks = {
        request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>) {
          const request = navigator.locks.request(name, options, callback);
          nativeRequests.push(request);
          return request;
        },
      };
      const noLocks = new lockModule.RoomCryptoLockCoordinator({ locks: null, channelFactory: null });
      const noChannel = new lockModule.RoomCryptoLockCoordinator({ locks, channelFactory: null });
      const holder = new lockModule.RoomCryptoLockCoordinator({ locks });
      const silentChannelFactory = () => ({ onmessage: null, postMessage() {}, close() {} });
      const waiting = new lockModule.RoomCryptoLockCoordinator({ locks, channelFactory: silentChannelFactory });
      try {
        const noLocksResult = await noLocks.acquire(roomInstance);
        const noChannelResult = await noChannel.acquire(roomInstance, { takeover: true });
        const held = await holder.acquire(roomInstance);
        if (held.status !== "acquired") throw new Error("The timeout scenario requires a held native Web Lock");
        const timedOutTakeover = await waiting.acquire(roomInstance, { takeover: true, timeoutMs: 25 });
        return { noLocksResult, noChannelResult, timedOutTakeover };
      } finally {
        noLocks.close();
        noChannel.close();
        holder.close();
        waiting.close();
        // Releasing a lease signals its callback; it does not await completion
        // of the native request. Drain both release and abort before Chromium exits.
        await Promise.allSettled(nativeRequests);
      }
    });
  
    assert.deepEqual(result, {
      noLocksResult: { status: "unsupported", reason: "web-locks-unavailable" },
      noChannelResult: { status: "unsupported", reason: "takeover-channel-unavailable" },
      timedOutTakeover: { status: "failed", reason: "takeover-timeout" },
    });
  });
});
