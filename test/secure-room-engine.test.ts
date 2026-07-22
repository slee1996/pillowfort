import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "../client/node_modules/vite/dist/node/index.js";
import { verifySecureDeviceResumeProofV4 } from "../src/deviceAuthV4";

let vite: ViteDevServer;
let browser: Browser;
let page: Page;
let baseUrl: string;
const secureGameReducerModuleUrl = `/@fs${join(import.meta.dir, "../src/secureGameReducer.ts")}`;
const roomInvitationMemberBindingModuleUrl =
  `/@fs${join(import.meta.dir, "../src/roomInvitationMemberBindingV4.ts")}`;

beforeAll(async () => {
  vite = await createServer({
    root: join(import.meta.dir, "../client"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  baseUrl = vite.resolvedUrls?.local[0] || vite.resolvedUrls?.network[0] || "";
  if (!baseUrl) throw new Error("Vite did not expose a secure-room engine test URL");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(baseUrl);
}, 60_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
}, 60_000);

describe("protocol-v4 durable secure room engine", () => {
  it("authenticates composite state and makes send, rollback, CAS, restart, and retirement crash-safe", async () => {
    const result = await page.evaluate(async () => {
      const engineModule = await import("/src/services/secureRoomEngine.ts");
      const stateModule = await import("/src/services/secureRoomState.ts");
      const storeModule = await import("/src/services/cryptoStateStore.ts");

      const base64Url = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
      };
      const randomId = () => base64Url(crypto.getRandomValues(new Uint8Array(16)));
      const roomInstance = randomId();
      const otherRoom = randomId();
      const roomSecret = `pf2_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const wrongSecret = `pf2_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const grantFor = (target: { deviceId: string; state: { logicalOrder: number } }) => ({
        v: 4 as const,
        suite: 1 as const,
        roomInstance,
        requestId: randomId(),
        tokenId: randomId(),
        deviceId: target.deviceId,
        logicalOrder: target.state.logicalOrder + 1,
        expiresAt: Date.now() + 60_000,
      });
      const databaseName = `secure-engine-persistence-${crypto.randomUUID()}`;
      const store = new storeModule.CryptoStateStore({ databaseName });
      const lockKey = await engineModule.secureRoomEngineStoreKey(roomInstance);
      const storeKey = await engineModule.secureRoomEngineStateKey(roomInstance, roomSecret);
      const controller = new AbortController();
      const lease = {
        roomInstance: lockKey,
        signal: controller.signal,
        released: new Promise<"released">(() => {}),
        isActive: () => !controller.signal.aborted,
        release: () => controller.abort(),
      };
      const code = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code || "error";
        }
      };
      const step = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const typed = error as Error & { cause?: Error & { cause?: Error } };
          throw new Error(`${label}: ${typed.message}; ${typed.cause?.message}; ${typed.cause?.cause?.message}`);
        }
      };

      let engine = await engineModule.SecureRoomEngine.createFounder({
        roomInstance,
        roomSecret,
        displayName: "Alice",
        store,
        lease,
      });
      const createdWasProvisional = engine.isProvisional && !engine.isAuthenticationAmbiguous;
      await engine.markAuthenticationAttempted();
      const attemptedRecord = await store.loadOpaqueState(storeKey);
      const attemptWasDurable = !engine.isProvisional && engine.isAuthenticationAmbiguous &&
        attemptedRecord?.lifecycle === "authentication-ambiguous";
      engine.dispose();
      engine = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store, lease });
      const ambiguitySurvivedRestore = engine.isAuthenticationAmbiguous;
      await engine.markAuthenticated();
      const establishedRecord = await store.loadOpaqueState(storeKey);
      const authenticationWasEstablished = !engine.isProvisional && !engine.isAuthenticationAmbiguous &&
        establishedRecord?.lifecycle === "established";
      const rawSession = (engine as any).session;
      const originalEncrypt = rawSession.encrypt.bind(rawSession);
      let capturedPlaintext: Uint8Array | null = null;
      rawSession.encrypt = async (plaintext: Uint8Array) => {
        capturedPlaintext = plaintext;
        return originalEncrypt(plaintext);
      };
      const hygieneProbe = await engine.encryptEvent(
        { type: "chat", text: "plaintext hygiene probe" },
        grantFor(engine),
      );
      rawSession.encrypt = originalEncrypt;
      const plaintextZeroedAfterEncrypt = capturedPlaintext !== null &&
        [...capturedPlaintext].every((byte) => byte === 0);
      await engine.rejectOutbound(hygieneProbe.messageId);
      const initialRecord = await store.loadOpaqueState(storeKey);
      if (!initialRecord) throw new Error("initial durable record missing");
      const decodedInitial = new TextDecoder().decode(initialRecord.state);
      const tampered = initialRecord.state.slice();
      tampered[tampered.length - 1] ^= 0x40;

      let releaseCas!: () => void;
      const casGate = new Promise<void>((resolve) => { releaseCas = resolve; });
      const originalCas = store.compareAndSetOpaqueState.bind(store);
      let gateEnabled = true;
      (store as unknown as { compareAndSetOpaqueState: typeof store.compareAndSetOpaqueState }).compareAndSetOpaqueState = async (...args) => {
        const committed = await originalCas(...args);
        if (gateEnabled) await casGate;
        return committed;
      };
      let sendSettled = false;
      const gatedSendPromise = engine.encryptEvent(
        { type: "chat", text: "held until durable" },
        grantFor(engine),
      ).then((value) => {
        sendSettled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const outputWithheldUntilCas = !sendSettled;
      releaseCas();
      const gatedSend = await gatedSendPromise;
      gateEnabled = false;
      const gatedRecord = await store.loadOpaqueState(storeKey);
      if (!gatedRecord) throw new Error("gated durable record missing");
      const gatedDurable = await stateModule.unprotectSecureRoomStateV1(gatedRecord.state, roomInstance, roomSecret);
      const applicationRollbackOmitsPriorSnapshot = gatedDurable.pendingApplicationRollback !== null &&
        !Object.prototype.hasOwnProperty.call(gatedDurable.pendingApplicationRollback, "mlsSnapshot");
      const postSendSnapshot = base64Url(gatedDurable.mlsSnapshot);
      const gatedRejectDisposition = await engine.rejectOutbound(gatedSend.messageId);
      const afterGatedRejectRecord = await store.loadOpaqueState(storeKey);
      if (!afterGatedRejectRecord) throw new Error("post-rejection durable record missing");
      const afterGatedReject = await stateModule.unprotectSecureRoomStateV1(
        afterGatedRejectRecord.state,
        roomInstance,
        roomSecret,
      );
      const rejectedApplicationKeptAdvancedRatchet = gatedRejectDisposition === "reverted" &&
        base64Url(afterGatedReject.mlsSnapshot) === postSendSnapshot;

      const accepted = await engine.encryptEvent({ type: "chat", text: "accepted forever" }, grantFor(engine));
      await engine.acknowledgeOutbound(accepted.messageId);
      const acceptedCannotRollback = await code(() => engine.rejectOutbound(accepted.messageId));
      const acceptedOutboxCleared = !engine.pendingOutboundMessageIds.includes(accepted.messageId);

      const crashy = await engine.encryptEvent(
        { type: "chat", text: "crash before host approval" },
        grantFor(engine),
      );
      const crashyWire = base64Url(crashy.outbound);
      const exposedCrashy = engine.pendingOutbox.find((entry) => entry.messageId === crashy.messageId)!;
      const outboxPersistedBeforeReturn = exposedCrashy.kind === "application" &&
        base64Url(exposedCrashy.outbound) === crashyWire && exposedCrashy.event.eventId === crashy.event.eventId;
      exposedCrashy.outbound[0] ^= 0xff;
      const outboxGetterReturnsClones = base64Url(
        engine.pendingOutbox.find((entry) => entry.messageId === crashy.messageId)!.outbound,
      ) === crashyWire;
      const revisionBeforeCrash = engine.durableRevision;
      engine.dispose();
      engine = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store, lease });
      const restartedOutbox = engine.pendingOutbox.find((entry) => entry.messageId === crashy.messageId);
      const recoveredCrashUi = await engine.pendingOutboundUiResult(crashy.messageId);
      const crashUiRecoveredExactly = recoveredCrashUi.effects.some((effect) =>
        effect.type === "chat" && effect.text === "crash before host approval");
      const restartHasRollback = engine.durableRevision === revisionBeforeCrash &&
        engine.pendingOutboundMessageIds.includes(crashy.messageId) &&
        engine.state.logicalOrder === crashy.event.logicalOrder &&
        engine.state.seenEventIds.includes(crashy.event.eventId) &&
        restartedOutbox?.kind === "application" && base64Url(restartedOutbox.outbound) === crashyWire &&
        restartedOutbox.event.eventId === crashy.event.eventId;
      const wrongRollbackId = await code(() => engine.rejectOutbound(randomId()));
      const stillPendingAfterWrongId = engine.pendingOutboundMessageIds.includes(crashy.messageId);
      await engine.rejectOutbound(crashy.messageId);
      const exactRollback = !engine.pendingOutboundMessageIds.includes(crashy.messageId) &&
        engine.state.logicalOrder === accepted.event.logicalOrder &&
        !engine.state.seenEventIds.includes(crashy.event.eventId) &&
        engine.state.seenEventIds.includes(accepted.event.eventId);

      const beforeConflictState = JSON.stringify(engine.state);
      const staleRevision = engine.durableRevision;
      const authoritative = await store.loadOpaqueState(storeKey);
      if (!authoritative) throw new Error("authoritative record missing");
      const forcedRace = await originalCas(storeKey, staleRevision, authoritative.state);
      const revisionConflict = await code(() => engine.encryptEvent(
        { type: "chat", text: "must not escape" },
        grantFor(engine),
      ));
      const recoveredAfterConflict = forcedRace.committed && engine.durableRevision === forcedRace.revision &&
        JSON.stringify(engine.state) === beforeConflictState;
      const afterConflict = await engine.encryptEvent(
        { type: "chat", text: "after conflict recovery" },
        grantFor(engine),
      );
      await engine.acknowledgeOutbound(afterConflict.messageId);

      const theme = await engine.encryptEvent({ type: "theme", theme: "campus-blue" }, grantFor(engine));
      await engine.acknowledgeOutbound(theme.messageId);
      const expectedSequenceAfterTranscriptScrub = theme.event.deviceSequence;
      const expectedLogicalOrderAfterTranscriptScrub = theme.event.logicalOrder;
      engine.dispose();
      engine = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store, lease });
      const durableTranscriptNotRestored = engine.state.messages.length === 0 && engine.state.drawings.length === 0;
      const durableStateSurvivedTranscriptScrub = engine.state.theme === "campus-blue" &&
        engine.state.logicalOrder === expectedLogicalOrderAfterTranscriptScrub &&
        engine.state.members.find((member) => member.deviceId === engine.deviceId)?.lastSequence ===
          expectedSequenceAfterTranscriptScrub;

      const currentRecord = await store.loadOpaqueState(storeKey);
      if (!currentRecord) throw new Error("current durable record missing");
      const directRestore = await stateModule.unprotectSecureRoomStateV1(currentRecord.state, roomInstance, roomSecret);
      const tamperCode = await code(() => stateModule.unprotectSecureRoomStateV1(tampered, roomInstance, roomSecret));
      const wrongSecretCode = await code(() => stateModule.unprotectSecureRoomStateV1(currentRecord.state, roomInstance, wrongSecret));
      const roomSwapCode = await code(() => stateModule.unprotectSecureRoomStateV1(currentRecord.state, otherRoom, roomSecret));

      await store.advanceReplay({
        roomInstance: lockKey,
        senderId: engine.deviceId,
        sessionId: "A".repeat(16),
        sequence: 7,
      });
      const deviceId = engine.deviceId;
      await engine.retire();
      const erasedOpaqueState = await store.loadOpaqueState(storeKey) === null;
      const replaySurvived = await store.replayHighWater({
        roomInstance: lockKey,
        senderId: deviceId,
        sessionId: "A".repeat(16),
      });
      const retiredCode = await code(async () => engine.state);
      await store.close();

      return {
        createdWasProvisional,
        attemptWasDurable,
        ambiguitySurvivedRestore,
        authenticationWasEstablished,
        wrapperMagic: new TextDecoder().decode(initialRecord.state.slice(0, 8)),
        plaintextAbsent: !decodedInitial.includes("Alice") && !decodedInitial.includes(roomSecret),
        plaintextZeroedAfterEncrypt,
        outputWithheldUntilCas,
        applicationRollbackOmitsPriorSnapshot,
        rejectedApplicationKeptAdvancedRatchet,
        acceptedCannotRollback,
        acceptedOutboxCleared,
        outboxPersistedBeforeReturn,
        outboxGetterReturnsClones,
        restartHasRollback,
        crashUiRecoveredExactly,
        wrongRollbackId,
        stillPendingAfterWrongId,
        exactRollback,
        revisionConflict,
        recoveredAfterConflict,
        durableTranscriptNotRestored,
        durableStateSurvivedTranscriptScrub,
        directRestoreDeviceMatches: directRestore.deviceId === deviceId,
        tamperCode,
        wrongSecretCode,
        roomSwapCode,
        erasedOpaqueState,
        replaySurvived,
        retiredCode,
      };
    });

    expect(result.wrapperMagic).toBe("PFRMST01");
    expect(result.createdWasProvisional).toBe(true);
    expect(result.attemptWasDurable).toBe(true);
    expect(result.ambiguitySurvivedRestore).toBe(true);
    expect(result.authenticationWasEstablished).toBe(true);
    expect(result.plaintextAbsent).toBe(true);
    expect(result.plaintextZeroedAfterEncrypt).toBe(true);
    expect(result.outputWithheldUntilCas).toBe(true);
    expect(result.applicationRollbackOmitsPriorSnapshot).toBe(true);
    expect(result.rejectedApplicationKeptAdvancedRatchet).toBe(true);
    expect(result.acceptedCannotRollback).toBe("invalid-input");
    expect(result.acceptedOutboxCleared).toBe(true);
    expect(result.outboxPersistedBeforeReturn).toBe(true);
    expect(result.outboxGetterReturnsClones).toBe(true);
    expect(result.restartHasRollback).toBe(true);
    expect(result.crashUiRecoveredExactly).toBe(true);
    expect(result.wrongRollbackId).toBe("invalid-input");
    expect(result.stillPendingAfterWrongId).toBe(true);
    expect(result.exactRollback).toBe(true);
    expect(result.revisionConflict).toBe("revision-conflict");
    expect(result.recoveredAfterConflict).toBe(true);
    expect(result.durableTranscriptNotRestored).toBe(true);
    expect(result.durableStateSurvivedTranscriptScrub).toBe(true);
    expect(result.directRestoreDeviceMatches).toBe(true);
    expect(result.tamperCode).toBe("state-invalid");
    expect(result.wrongSecretCode).toBe("state-invalid");
    expect(result.roomSwapCode).toBe("state-invalid");
    expect(result.erasedOpaqueState).toBe(true);
    expect(result.replaySurvived).toBe(7);
    expect(result.retiredCode).toBe("retired");
  }, 120_000);

  it("isolates abandoned wrong-password state and atomically migrates legacy room-scoped records", async () => {
    const result = await page.evaluate(async () => {
      const [engineModule, storeModule] = await Promise.all([
        import("/src/services/secureRoomEngine.ts"),
        import("/src/services/cryptoStateStore.ts"),
      ]);
      const base64Url = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
      };
      const randomId = () => base64Url(crypto.getRandomValues(new Uint8Array(16)));
      const randomSecret = () => `pf2_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const makeLease = (roomInstance: string) => {
        const controller = new AbortController();
        return engineModule.secureRoomEngineStoreKey(roomInstance).then((lockKey: string) => ({
          roomInstance: lockKey,
          signal: controller.signal,
          released: new Promise<"released">(() => {}),
          isActive: () => !controller.signal.aborted,
          release: () => controller.abort(),
        }));
      };

      const roomInstance = randomId();
      const wrongSecret = randomSecret();
      const correctSecret = randomSecret();
      const store = new storeModule.CryptoStateStore({
        databaseName: `secure-engine-credential-scope-${crypto.randomUUID()}`,
      });
      const lease = await makeLease(roomInstance);
      const abandoned = await engineModule.SecureRoomEngine.createJoiner({
        roomInstance, roomSecret: wrongSecret, store, lease,
      });
      abandoned.dispose();
      const correct = await engineModule.SecureRoomEngine.createJoiner({
        roomInstance, roomSecret: correctSecret, store, lease,
      });
      const wrongKey = await engineModule.secureRoomEngineStateKey(roomInstance, wrongSecret);
      const correctKey = await engineModule.secureRoomEngineStateKey(roomInstance, correctSecret);
      const abandonedWrongStateDidNotBlockCorrect = wrongKey !== correctKey &&
        await store.loadOpaqueState(wrongKey) !== null &&
        await store.loadOpaqueState(correctKey) !== null;
      const restoredAbandoned = await engineModule.SecureRoomEngine.restore({
        roomInstance, roomSecret: wrongSecret, store, lease,
      });
      await restoredAbandoned.retire();
      await correct.retire();
      await store.close();

      const legacyRoomInstance = randomId();
      const legacySecret = randomSecret();
      const wrongLegacySecret = randomSecret();
      const legacyStore = new storeModule.CryptoStateStore({
        databaseName: `secure-engine-legacy-move-${crypto.randomUUID()}`,
      });
      const legacyLease = await makeLease(legacyRoomInstance);
      const legacySourceKey = await engineModule.secureRoomEngineStoreKey(legacyRoomInstance);
      const migratedKey = await engineModule.secureRoomEngineStateKey(legacyRoomInstance, legacySecret);
      const seeded = await engineModule.SecureRoomEngine.createJoiner({
        roomInstance: legacyRoomInstance,
        roomSecret: legacySecret,
        store: legacyStore,
        lease: legacyLease,
      });
      seeded.dispose();
      const credentialRecord = await legacyStore.loadOpaqueState(migratedKey);
      if (!credentialRecord) throw new Error("credential-scoped seed is missing");
      const removedSeed = await legacyStore.compareAndDeleteOpaqueState(migratedKey, credentialRecord.revision);
      if (!removedSeed.erased) throw new Error("credential-scoped seed could not be moved to legacy key");
      const legacySeed = await legacyStore.compareAndSetOpaqueState(
        legacySourceKey,
        null,
        credentialRecord.state,
      );
      if (!legacySeed.committed) throw new Error("legacy seed could not be created");
      let wrongLegacyRestoreCode = "accepted";
      try {
        await engineModule.SecureRoomEngine.restore({
          roomInstance: legacyRoomInstance,
          roomSecret: wrongLegacySecret,
          store: legacyStore,
          lease: legacyLease,
        });
      } catch (error) {
        wrongLegacyRestoreCode = (error as { code?: string }).code || "error";
      }
      const wrongLegacyKey = await engineModule.secureRoomEngineStateKey(legacyRoomInstance, wrongLegacySecret);
      const wrongCredentialCouldNotMoveLegacy = wrongLegacyRestoreCode === "state-not-found" &&
        await legacyStore.loadOpaqueState(legacySourceKey) !== null &&
        await legacyStore.loadOpaqueState(wrongLegacyKey) === null;
      const restored = await engineModule.SecureRoomEngine.restore({
        roomInstance: legacyRoomInstance,
        roomSecret: legacySecret,
        store: legacyStore,
        lease: legacyLease,
      });
      const migratedRecord = await legacyStore.loadOpaqueState(migratedKey);
      const legacyMigrationWasAtomic = migratedRecord?.revision === legacySeed.revision &&
        await legacyStore.loadOpaqueState(legacySourceKey) === null;
      await restored.retire();
      await legacyStore.close();

      return {
        abandonedWrongStateDidNotBlockCorrect,
        wrongCredentialCouldNotMoveLegacy,
        legacyMigrationWasAtomic,
      };
    });

    expect(result.abandonedWrongStateDidNotBlockCorrect).toBe(true);
    expect(result.wrongCredentialCouldNotMoveLegacy).toBe(true);
    expect(result.legacyMigrationWasAtomic).toBe(true);
  }, 120_000);

  it("admits a member privately, inspects without mutation, rejects replay/reorder/forgeries, and authorizes commit summaries", async () => {
    const result = await page.evaluate(async (bindingModuleUrl) => {
      const engineModule = await import("/src/services/secureRoomEngine.ts");
      const stateModule = await import("/src/services/secureRoomState.ts");
      const storeModule = await import("/src/services/cryptoStateStore.ts");
      const mlsModule = await import("/src/services/mlsCrypto.ts");
      const invitationModule = await import("/src/services/secureInvitationAuth.ts");
      const bindingModule = await import(bindingModuleUrl);
      const encoder = new TextEncoder();
      const base64Url = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
      };
      const decode = (value: string) => {
        const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      };
      const randomId = () => base64Url(crypto.getRandomValues(new Uint8Array(16)));
      const canonicalJson = (value: unknown): string => {
        if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
          return JSON.stringify(value);
        }
        if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
      };
      const roomInstance = randomId();
      const roomBinding = decode(roomInstance);
      const roomSecret = `pf2_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const roomId = "abcdefghij";
      const grantFor = (target: { deviceId: string; state: { logicalOrder: number } }) => ({
        v: 4 as const,
        suite: 1 as const,
        roomInstance,
        requestId: randomId(),
        tokenId: randomId(),
        deviceId: target.deviceId,
        logicalOrder: target.state.logicalOrder + 1,
        expiresAt: Date.now() + 60_000,
      });
      const hostStore = new storeModule.CryptoStateStore({ databaseName: `secure-engine-host-${crypto.randomUUID()}` });
      const bobStore = new storeModule.CryptoStateStore({ databaseName: `secure-engine-bob-${crypto.randomUUID()}` });
      const lockKey = await engineModule.secureRoomEngineStoreKey(roomInstance);
      const storeKey = await engineModule.secureRoomEngineStateKey(roomInstance, roomSecret);
      const fakeLease = (leaseStoreKey = lockKey) => {
        const controller = new AbortController();
        return {
          roomInstance: leaseStoreKey,
          signal: controller.signal,
          released: new Promise<"released">(() => {}),
          isActive: () => !controller.signal.aborted,
          release: () => controller.abort(),
        };
      };
      const hostLease = fakeLease();
      const bobLease = fakeLease();
      const code = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code || "error";
        }
      };
      const step = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const typed = error as Error & { cause?: Error & { cause?: Error } };
          throw new Error(`${label}: ${typed.message}; ${typed.cause?.message}; ${typed.cause?.cause?.message}`);
        }
      };
      const restoreRaw = async (store: InstanceType<typeof storeModule.CryptoStateStore>) => {
        const record = await store.loadOpaqueState(storeKey);
        if (!record) throw new Error("raw durable state missing");
        const durable = await stateModule.unprotectSecureRoomStateV1(record.state, roomInstance, roomSecret);
        return mlsModule.restore({ roomBinding, roomSecret, snapshot: durable.mlsSnapshot });
      };

      let host = await engineModule.SecureRoomEngine.createFounder({
        roomInstance,
        roomSecret,
        displayName: "Alice",
        store: hostStore,
        lease: hostLease,
      });
      let bob = await engineModule.SecureRoomEngine.createJoiner({
        roomInstance,
        roomSecret,
        store: bobStore,
        lease: bobLease,
      });
      // Setup persists the founder's invitation-authenticated admission id
      // before the frame is sent, then retires the exact setup outbox on ACK.
      const hostPackage = await host.createKeyPackage();
      const founderAdmissionPersistedBeforeSetupAck = host.state.membershipAdmissionBindings.some((binding) =>
        binding.deviceId === host.deviceId && binding.admissionId === hostPackage.messageId);
      host.dispose();
      host = await engineModule.SecureRoomEngine.restore({
        roomInstance,
        roomSecret,
        store: hostStore,
        lease: hostLease,
      });
      const founderAdmissionSurvivedSetupResponseLoss = host.state.membershipAdmissionBindings.some((binding) =>
        binding.deviceId === host.deviceId && binding.admissionId === hostPackage.messageId) &&
        host.pendingOutbox.some((entry) => entry.kind === "admission" &&
          entry.messageId === hostPackage.messageId && !entry.commitAcknowledged);
      await host.acknowledgeOutbound(hostPackage.messageId);
      await host.completeJoinAdmission(hostPackage.messageId);
      const resumeContext = {
        roomId: "fort-1",
        roomInstance,
        deviceId: host.deviceId,
        connectionId: randomId(),
        requestId: randomId(),
        challenge: base64Url(crypto.getRandomValues(new Uint8Array(32))),
      };
      const resumeProof = await host.signDeviceResumeProof(resumeContext);
      const resumeSignaturePublicKey = host.signaturePublicKey;
      const wrongResumeBindingCode = await code(() => host.signDeviceResumeProof({
        ...resumeContext,
        roomInstance: randomId(),
      }));

      const bobPackage = await bob.createKeyPackage();
      const keyPackageWire = base64Url(bobPackage.keyPackage);
      const bobBinding = await invitationModule.createRoomInvitationMemberBindingV4({
        mode: "admission",
        roomId,
        roomInstance,
        deviceId: bob.deviceId,
        admissionId: bobPackage.messageId,
        signaturePublicKey: bob.signaturePublicKey,
        keyPackageDigest: await bindingModule.secureKeyPackageDigestV4(bobPackage.keyPackage),
      }, roomSecret);
      const founderBinding = await invitationModule.createRoomInvitationMemberBindingV4({
        mode: "founder",
        roomId,
        roomInstance,
        deviceId: host.deviceId,
        admissionId: hostPackage.messageId,
        signaturePublicKey: host.signaturePublicKey,
        keyPackageDigest: await bindingModule.secureKeyPackageDigestV4(hostPackage.keyPackage),
      }, roomSecret);
      bob.dispose();
      bob = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store: bobStore, lease: bobLease });
      const restartedKeyPackage = bob.pendingOutbox.find((entry) => entry.messageId === bobPackage.messageId);
      const keyPackageRetryStable = restartedKeyPackage?.kind === "admission" &&
        restartedKeyPackage.welcomeMessageId === null && base64Url(restartedKeyPackage.outbound) === keyPackageWire;
      // The relay binds admissionId to the joiner's durable KeyPackage request
      // ID so a pending join can retry the exact authentication artifact.
      const admissionId = bobPackage.messageId;
      const substitutedKeyPackage = restartedKeyPackage!.outbound.slice();
      substitutedKeyPackage[0] ^= 0x01;
      const substitutedKeyPackageCode = await code(() => host.addMember(
        substitutedKeyPackage, admissionId, grantFor(host), roomId, bobBinding,
      ));
      const substitutedSignatureKeyCode = await code(() => host.addMember(
        restartedKeyPackage!.outbound,
        admissionId,
        grantFor(host),
        roomId,
        { ...bobBinding, signaturePublicKey: base64Url(new Uint8Array(32).fill(91)) },
      ));
      const substitutedDeviceIdCode = await code(() => host.addMember(
        restartedKeyPackage!.outbound,
        admissionId,
        grantFor(host),
        roomId,
        { ...bobBinding, deviceId: randomId() },
      ));
      const substitutedAdmissionIdCode = await code(() => host.addMember(
        restartedKeyPackage!.outbound, randomId(), grantFor(host), roomId, bobBinding,
      ));
      let addition: Awaited<ReturnType<typeof host.addMember>>;
      try {
        addition = await host.addMember(
          restartedKeyPackage!.outbound,
          admissionId,
          grantFor(host),
          roomId,
          bobBinding,
        );
      } catch (error) {
        const typed = error as Error & { cause?: Error & { cause?: Error } };
        throw new Error(`${typed.message}; ${typed.cause?.message}; ${typed.cause?.cause?.message}`);
      }
      await step("key-package ack", () => bob.acknowledgeOutbound(bobPackage.messageId));
      const addEntryBeforeAck = host.pendingOutbox.find((entry) => entry.messageId === addition.messageId);
      const addArtifactsPersisted = addEntryBeforeAck?.kind === "admission" &&
        addEntryBeforeAck.admissionId === admissionId &&
        addEntryBeforeAck.welcomeMessageId === addition.welcomeMessageId &&
        base64Url(addEntryBeforeAck.outbound) === base64Url(addition.outbound) &&
        base64Url(addEntryBeforeAck.welcome!) === base64Url(addition.welcome) &&
        base64Url(addEntryBeforeAck.ratchetTree!) === base64Url(addition.ratchetTree);
      await step("admission commit ack", () => host.acknowledgeOutbound(addition.messageId));
      const commitAckRetainedAdmission = host.pendingOutbox.some((entry) => entry.kind === "admission" &&
        entry.admissionId === admissionId && entry.commitAcknowledged && !entry.welcomeAcknowledged);
      host.dispose();
      host = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store: hostStore, lease: hostLease });
      const restartedAdmission = host.pendingOutbox.find((entry) => entry.kind === "admission" &&
        entry.admissionId === admissionId);
      const admissionRetryStable = restartedAdmission?.kind === "admission" && restartedAdmission.commitAcknowledged &&
        base64Url(restartedAdmission.welcome!) === base64Url(addition.welcome) &&
        base64Url(restartedAdmission.ratchetTree!) === base64Url(addition.ratchetTree);
      await step("Welcome ack", () => host.acknowledgeOutbound(addition.welcomeMessageId));
      await bob.authorizeJoinFounder(roomId, founderBinding);
      const joined = await step(
        "join",
        () => bob.join(addition.welcome, addition.ratchetTree, addition.welcomeMessageId, admissionId),
      );
      bob.dispose();
      bob = await engineModule.SecureRoomEngine.restore({
        roomInstance,
        roomSecret,
        store: bobStore,
        lease: bobLease,
      });
      await bob.authorizeJoinFounder(roomId, founderBinding);
      const retainedJoinAdmission = bob.pendingOutbox.find((entry) => entry.kind === "admission" &&
        entry.admissionId === admissionId && entry.welcomeMessageId === null);
      const durableJoinWelcomeRetained = retainedJoinAdmission?.kind === "admission" &&
        retainedJoinAdmission.joinWelcomeMessageId === addition.welcomeMessageId;
      const duplicateJoin = await bob.join(
        addition.welcome,
        addition.ratchetTree,
        addition.welcomeMessageId,
        admissionId,
      );
      const mismatchedWelcome = addition.welcome.slice();
      mismatchedWelcome[0] ^= 0x01;
      const reusedWelcomeIdCode = await code(() => bob.join(
        mismatchedWelcome,
        addition.ratchetTree,
        addition.welcomeMessageId,
        admissionId,
      ));
      const durableWelcomeDelivery = joined.kind === "join" &&
        joined.relayMessageId === addition.welcomeMessageId &&
        duplicateJoin.kind === "already-processed" &&
        bob.hasProcessedRelayMessage(addition.welcomeMessageId);

      const bootstrap = await step(
        "bootstrap encrypt",
        () => host.encryptStateSnapshot(admissionId, grantFor(host)),
      );
      const bootstrapResult = await step(
        "bootstrap receive",
        () => bob.receive(bootstrap.outbound, {
          messageId: bootstrap.messageId,
          fromDeviceId: host.deviceId,
          logicalOrder: bootstrap.event.logicalOrder,
          relayContext: { kind: "bootstrap", admissionId, welcomeMessageId: addition.welcomeMessageId },
        }),
      );
      const duplicateBootstrap = await bob.receive(bootstrap.outbound, {
        messageId: bootstrap.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: bootstrap.event.logicalOrder,
        relayContext: { kind: "bootstrap", admissionId, welcomeMessageId: addition.welcomeMessageId },
      });
      await step("bootstrap ack", () => host.acknowledgeOutbound(bootstrap.messageId));
      const bootstrapContextRetained = host.pendingOutbox.some((entry) => entry.kind === "admission" &&
        entry.admissionId === admissionId && entry.bootstrapMessageId === bootstrap.messageId && entry.welcomeAcknowledged);
      await step("admission complete", () => host.completeAdmission(admissionId));
      const admissionRetainedUntilActivation = host.pendingOutbox.some((entry) => entry.kind === "admission" &&
        entry.admissionId === admissionId) && host.pendingAdmissionBarrier?.deviceId === bob.deviceId &&
        bob.pendingAdmissionBarrier?.admissionId === admissionId;
      const hostAdmissionChatBlocked = await code(() => host.encryptEvent(
        { type: "chat", text: "must not cross admission barrier" },
        grantFor(host),
      ));
      const hostAdmissionUpdateBlocked = await code(() => host.selfUpdate(grantFor(host)));
      const bootstrapSubset = bootstrapResult.kind === "inbound-application" &&
        bob.state.hostDeviceId === host.deviceId && bob.state.members.length === 1 &&
        bob.state.members[0].deviceId === host.deviceId;

      const unboundJoinProofCode = await code(() => bob.encryptEvent(
        { type: "member-profile", displayName: "Bob" },
        grantFor(bob),
      ));
      const profile = await bob.encryptJoinProof(
        "Bob",
        admissionId,
        addition.welcomeMessageId,
        grantFor(bob),
      );
      const hostRevisionBeforeInspect = host.durableRevision;
      const hostEpochBeforeInspect = host.epoch;
      const hostStateBeforeInspect = JSON.stringify(host.state);
      const inspectedProfile = await host.inspectInboundApplication(
        profile.outbound,
        bob.deviceId,
        profile.event.logicalOrder,
        { kind: "join-proof", admissionId, welcomeMessageId: addition.welcomeMessageId },
      );
      const wrongPreviewSenderCode = await code(() => host.inspectInboundApplication(
        profile.outbound,
        host.deviceId,
        profile.event.logicalOrder,
        { kind: "join-proof", admissionId, welcomeMessageId: addition.welcomeMessageId },
      ));
      const wrongPreviewOrderCode = await code(() => host.inspectInboundApplication(
        profile.outbound,
        bob.deviceId,
        profile.event.logicalOrder + 1,
        { kind: "join-proof", admissionId, welcomeMessageId: addition.welcomeMessageId },
      ));
      const inspectorWasIsolated = host.durableRevision === hostRevisionBeforeInspect &&
        host.epoch === hostEpochBeforeInspect && JSON.stringify(host.state) === hostStateBeforeInspect;
      const wrongDeliverySenderCode = await code(() => host.receive(profile.outbound, {
        messageId: profile.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: profile.event.logicalOrder,
        relayContext: { kind: "join-proof", admissionId, welcomeMessageId: addition.welcomeMessageId },
      }));
      const wrongDeliveryOrderCode = await code(() => host.receive(profile.outbound, {
        messageId: profile.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: profile.event.logicalOrder + 1,
        relayContext: { kind: "join-proof", admissionId, welcomeMessageId: addition.welcomeMessageId },
      }));
      const mislabeledDeliveryRolledBack = host.durableRevision === hostRevisionBeforeInspect &&
        host.epoch === hostEpochBeforeInspect && JSON.stringify(host.state) === hostStateBeforeInspect;
      const profileResult = await host.receive(profile.outbound, {
        messageId: profile.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: profile.event.logicalOrder,
        relayContext: { kind: "join-proof", admissionId, welcomeMessageId: addition.welcomeMessageId },
      });
      await bob.acknowledgeOutbound(profile.messageId);
      const inspectedThenConsumed = inspectedProfile.eventId === profile.event.eventId &&
        profileResult.kind === "inbound-application" && host.state.members.some((member) => member.displayName === "Bob");
      const postProofChatStillBlocked = await code(() => host.encryptEvent(
        { type: "chat", text: "activation has not landed" },
        grantFor(host),
      ));
      await host.completeAdmissionLifecycle(bob.deviceId, "active");
      await bob.completeAdmissionLifecycle(bob.deviceId, "active");
      const completedAdmissionCleared = !host.pendingOutbox.some((entry) => entry.kind === "admission" &&
        entry.admissionId === admissionId) && host.pendingAdmissionBarrier === null &&
        bob.pendingAdmissionBarrier === null;

      const transferOffer = await host.encryptEvent({
        type: "host-transfer",
        action: "offer",
        targetDeviceId: bob.deviceId,
      }, grantFor(host));
      const missingOfferRelayCode = await code(() => bob.receive(transferOffer.outbound));
      await bob.receive(transferOffer.outbound, {
        messageId: transferOffer.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: transferOffer.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await host.acknowledgeOutbound(transferOffer.messageId);
      const transferOfferDurableOnBoth = host.pendingRelayControls.some((control) =>
        control.kind === "transfer-host" && control.targetDeviceId === bob.deviceId &&
        control.offerMessageId === transferOffer.messageId) && bob.pendingRelayControls.some((control) =>
          control.kind === "transfer-host" && control.targetDeviceId === bob.deviceId &&
          control.offerMessageId === transferOffer.messageId);
      const initialTransferAuthorizationId = transferOffer.hostTransferAuthorizationId!;
      await bob.recordHostTransferAuthorization(transferOffer.messageId, initialTransferAuthorizationId);
      await bob.completeRelayControl({
        kind: "host-transfer-expired",
        authorizationId: initialTransferAuthorizationId,
      });
      await host.completeRelayControl({
        kind: "host-transfer-expired",
        authorizationId: initialTransferAuthorizationId,
      });
      const renewedTransferAuthorizationId = await host.renewHostTransferAuthorization(transferOffer.messageId);
      await bob.recordHostTransferAuthorization(transferOffer.messageId, renewedTransferAuthorizationId);
      const hostTransferExpirationRenewed = renewedTransferAuthorizationId !== initialTransferAuthorizationId &&
        host.pendingRelayControls.some((control) => control.kind === "transfer-host" &&
          control.authorizationId === renewedTransferAuthorizationId) &&
        bob.pendingRelayControls.some((control) => control.kind === "transfer-host" &&
          control.authorizationId === renewedTransferAuthorizationId);
      const tentativeTransferAccept = await bob.encryptEvent(
        {
          type: "host-transfer",
          action: "accept",
          authorizationId: renewedTransferAuthorizationId,
        },
        grantFor(bob),
      );
      const transferAcceptCapabilityBound =
        tentativeTransferAccept.hostTransferAuthorizationId === renewedTransferAuthorizationId &&
        bob.pendingRelayControls.some((control) => control.kind === "transfer-host" &&
          control.authorizationId === renewedTransferAuthorizationId &&
          control.acceptMessageId === tentativeTransferAccept.messageId) &&
        bob.state.hostDeviceId === bob.deviceId;
      const missingTransferAcceptContextCode = await code(() => host.inspectInboundApplication(
        tentativeTransferAccept.outbound,
        bob.deviceId,
        tentativeTransferAccept.event.logicalOrder,
        undefined as never,
      ));
      const genericTransferAcceptContextCode = await code(() => host.inspectInboundApplication(
        tentativeTransferAccept.outbound,
        bob.deviceId,
        tentativeTransferAccept.event.logicalOrder,
        { kind: "application" },
      ));
      const wrongTransferAcceptCapabilityCode = await code(() => host.inspectInboundApplication(
        tentativeTransferAccept.outbound,
        bob.deviceId,
        tentativeTransferAccept.event.logicalOrder,
        { kind: "host-transfer-accept", authorizationId: initialTransferAuthorizationId },
      ));
      const exactTransferAcceptPreview = await host.inspectInboundApplication(
        tentativeTransferAccept.outbound,
        bob.deviceId,
        tentativeTransferAccept.event.logicalOrder,
        { kind: "host-transfer-accept", authorizationId: renewedTransferAuthorizationId },
      );
      const exactTransferAcceptCapabilityAccepted = exactTransferAcceptPreview.eventId ===
        tentativeTransferAccept.event.eventId;
      await bob.rejectOutbound(tentativeTransferAccept.messageId);
      const rejectedTransferAcceptRolledBack = bob.state.hostDeviceId === host.deviceId &&
        bob.pendingRelayControls.some((control) => control.kind === "transfer-host" &&
          control.authorizationId === renewedTransferAuthorizationId && control.acceptMessageId === null);
      const transferReject = await bob.encryptEvent(
        { type: "host-transfer", action: "reject" },
        grantFor(bob),
      );
      await host.receive(transferReject.outbound, {
        messageId: transferReject.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: transferReject.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(transferReject.messageId);
      const rejectedTransferCleared = !host.pendingRelayControls.some((control) => control.kind === "transfer-host") &&
        !bob.pendingRelayControls.some((control) => control.kind === "transfer-host");

      const chat = await bob.encryptEvent({ type: "chat", text: "one delivery" }, grantFor(bob));
      await host.inspectInboundApplication(chat.outbound, bob.deviceId, chat.event.logicalOrder, { kind: "application" });
      const acceptedChat = await host.receive(chat.outbound, {
        messageId: chat.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: chat.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(chat.messageId);
      host.dispose();
      host = await engineModule.SecureRoomEngine.restore({
        roomInstance,
        roomSecret,
        store: hostStore,
        lease: hostLease,
      });
      const duplicateChat = await host.receive(chat.outbound, {
        messageId: chat.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: chat.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      const wrongReplayAttributionCode = await code(() => host.receive(chat.outbound, {
        messageId: chat.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: chat.event.logicalOrder,
        relayContext: { kind: "application" },
      }));
      const mismatchedChat = chat.outbound.slice();
      mismatchedChat[mismatchedChat.length - 1] ^= 0x01;
      const reusedChatIdCode = await code(() => host.receive(mismatchedChat, {
        messageId: chat.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: chat.event.logicalOrder,
        relayContext: { kind: "application" },
      }));
      const revisionAfterChat = host.durableRevision;
      const replayCode = await code(() => host.receive(chat.outbound));
      const replayRolledBack = host.durableRevision === revisionAfterChat &&
        host.state.logicalOrder === chat.event.logicalOrder &&
        host.state.seenEventIds.filter((eventId) => eventId === chat.event.eventId).length === 1;

      const orderedA = await bob.encryptEvent({ type: "chat", text: "ordered A" }, grantFor(bob));
      await bob.acknowledgeOutbound(orderedA.messageId);
      const orderedB = await bob.encryptEvent({ type: "chat", text: "ordered B" }, grantFor(bob));
      const reorderCode = await code(() => host.receive(orderedB.outbound, {
        messageId: orderedB.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: orderedB.event.logicalOrder,
        relayContext: { kind: "application" },
      }));
      const receiveA = await host.receive(orderedA.outbound, {
        messageId: orderedA.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: orderedA.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      const receiveB = await host.receive(orderedB.outbound, {
        messageId: orderedB.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: orderedB.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(orderedB.messageId);
      const reorderedRecovered = receiveA.kind === "inbound-application" && receiveB.kind === "inbound-application" &&
        receiveA.effects.some((effect) => effect.type === "chat" && effect.text === "ordered A") &&
        receiveB.effects.some((effect) => effect.type === "chat" && effect.text === "ordered B") &&
        host.state.logicalOrder === orderedB.event.logicalOrder &&
        host.state.seenEventIds.includes(orderedA.event.eventId) &&
        host.state.seenEventIds.includes(orderedB.event.eventId);

      const nextLogicalOrder = host.state.logicalOrder + 1;
      const bobMember = host.state.members.find((member) => member.deviceId === bob.deviceId)!;
      const hostMember = host.state.members.find((member) => member.deviceId === host.deviceId)!;

      let bobTemporary = await restoreRaw(bobStore);
      const invalidSignature = base64Url(new Uint8Array(64));
      const senderMismatchEvent = {
        v: 4 as const,
        roomInstance,
        eventId: randomId(),
        deviceId: host.deviceId,
        deviceSequence: hostMember.lastSequence + 1,
        logicalOrder: nextLogicalOrder,
        content: { type: "chat" as const, text: "sender mismatch" },
        signature: invalidSignature,
      };
      const senderMismatchCiphertext = await bobTemporary.encrypt(encoder.encode(canonicalJson(senderMismatchEvent)));
      bobTemporary.dispose();
      const senderMismatchCode = await code(() => host.receive(senderMismatchCiphertext.outbound!, {
        messageId: randomId(),
        fromDeviceId: bob.deviceId,
        logicalOrder: nextLogicalOrder,
        relayContext: { kind: "application" },
      }));

      bobTemporary = await restoreRaw(bobStore);
      const signatureMismatchEvent = {
        v: 4 as const,
        roomInstance,
        eventId: randomId(),
        deviceId: bob.deviceId,
        deviceSequence: bobMember.lastSequence + 1,
        logicalOrder: nextLogicalOrder,
        content: { type: "chat" as const, text: "signature mismatch" },
        signature: invalidSignature,
      };
      const signatureMismatchCiphertext = await bobTemporary.encrypt(encoder.encode(canonicalJson(signatureMismatchEvent)));
      bobTemporary.dispose();
      const signatureMismatchCode = await code(() => host.receive(signatureMismatchCiphertext.outbound!, {
        messageId: randomId(),
        fromDeviceId: bob.deviceId,
        logicalOrder: nextLogicalOrder,
        relayContext: { kind: "application" },
      }));

      const legitimate = await bob.encryptEvent(
        { type: "chat", text: "valid after forgeries" },
        grantFor(bob),
      );
      const legitimateResult = await host.receive(legitimate.outbound, {
        messageId: legitimate.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: legitimate.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(legitimate.messageId);

      const gameId = randomId();
      const challenge = await bob.encryptEvent(
        { type: "rps", action: "challenge", gameId, targetDeviceId: host.deviceId },
        grantFor(bob),
      );
      await host.receive(challenge.outbound, {
        messageId: challenge.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: challenge.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(challenge.messageId);
      const accept = await host.encryptEvent({ type: "rps", action: "accept", gameId }, grantFor(host));
      await bob.receive(accept.outbound, {
        messageId: accept.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: accept.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await host.acknowledgeOutbound(accept.messageId);
      const commitment = async (deviceId: string, pick: "rock" | "paper" | "scissors", nonce: string) => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(`Pillowfort RPS commitment v4\0${canonicalJson({ deviceId, gameId, nonce, pick })}`),
        );
        return base64Url(new Uint8Array(digest));
      };
      const bobNonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const bobCommitment = await commitment(bob.deviceId, "rock", bobNonce);
      const badSecretCode = await code(() => bob.putPendingCommitSecret({
        kind: "rps",
        gameId,
        pick: "rock",
        nonce: bobNonce,
        commitment: base64Url(crypto.getRandomValues(new Uint8Array(32))),
      }));
      const bobCommit = await bob.encryptCommitEvent(
        { type: "rps", action: "commit", gameId, commitment: bobCommitment },
        { kind: "rps", gameId, pick: "rock", nonce: bobNonce, commitment: bobCommitment },
        grantFor(bob),
      );
      await host.receive(bobCommit.outbound, {
        messageId: bobCommit.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: bobCommit.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(bobCommit.messageId);
      bob.dispose();
      bob = await engineModule.SecureRoomEngine.restore({
        roomInstance,
        roomSecret,
        store: bobStore,
        lease: bobLease,
      });
      const secretSurvivedRestart = bob.pendingCommitSecret(gameId)?.nonce === bobNonce;
      const secretRecord = await bobStore.loadOpaqueState(storeKey);
      const secretHiddenAtRest = !!secretRecord && !new TextDecoder().decode(secretRecord.state).includes(bobNonce);

      const hostNonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const hostCommitment = await commitment(host.deviceId, "paper", hostNonce);
      const hostCommit = await host.encryptCommitEvent(
        { type: "rps", action: "commit", gameId, commitment: hostCommitment },
        { kind: "rps", gameId, pick: "paper", nonce: hostNonce, commitment: hostCommitment },
        grantFor(host),
      );
      await bob.receive(hostCommit.outbound, {
        messageId: hostCommit.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: hostCommit.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await host.acknowledgeOutbound(hostCommit.messageId);

      const tentativeReveal = await bob.encryptEvent(
        { type: "rps", action: "reveal", gameId, pick: "rock", nonce: bobNonce },
        grantFor(bob),
      );
      await bob.rejectOutbound(tentativeReveal.messageId);
      const rejectedRevealKeptSecret = bob.pendingCommitSecret(gameId)?.nonce === bobNonce;
      const bobReveal = await bob.encryptEvent(
        { type: "rps", action: "reveal", gameId, pick: "rock", nonce: bobNonce },
        grantFor(bob),
      );
      await host.receive(bobReveal.outbound, {
        messageId: bobReveal.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: bobReveal.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(bobReveal.messageId);
      const acceptedRevealDeletedSecret = bob.pendingCommitSecret(gameId) === null;
      const hostReveal = await host.encryptEvent(
        { type: "rps", action: "reveal", gameId, pick: "paper", nonce: hostNonce },
        grantFor(host),
      );
      await bob.receive(hostReveal.outbound, {
        messageId: hostReveal.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: hostReveal.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await host.acknowledgeOutbound(hostReveal.messageId);
      const hostAcceptedRevealDeletedSecret = host.pendingCommitSecret(gameId) === null;

      const charlie = await mlsModule.create({
        roomBinding,
        identity: crypto.getRandomValues(new Uint8Array(16)),
        roomSecret,
      });
      const charliePackage = await charlie.session.keyPackage();
      bobTemporary = await restoreRaw(bobStore);
      const unauthorizedAdd = await bobTemporary.add(charliePackage.outbound!);
      bobTemporary.dispose();
      charlie.session.dispose();
      const hostRevisionBeforeUnauthorized = host.durableRevision;
      const hostRosterBeforeUnauthorized = host.roster().map((entry) => entry.deviceId).join(",");
      const unauthorizedCommitCode = await code(() => host.receive(unauthorizedAdd.outbound!, {
        messageId: randomId(),
        fromDeviceId: bob.deviceId,
        logicalOrder: null,
        relayContext: { kind: "commit" },
      }));
      const unauthorizedRolledBack = host.durableRevision === hostRevisionBeforeUnauthorized &&
        host.roster().map((entry) => entry.deviceId).join(",") === hostRosterBeforeUnauthorized;

      const rejectedUpdateGrant = grantFor(bob);
      const rejectedSelfUpdate = await bob.selfUpdate(rejectedUpdateGrant);
      const rejectedUpdateWire = base64Url(rejectedSelfUpdate.outbound);
      const hostRevisionBeforeCommitPreview = host.durableRevision;
      const hostEpochBeforeCommitPreview = host.epoch;
      const hostRosterBeforeCommitPreview = JSON.stringify(host.roster());
      const validCommitPreview = await host.inspectInboundCommit(rejectedSelfUpdate.outbound, bob.deviceId);
      const wrongCommitOuterSenderCode = await code(() => host.inspectInboundCommit(
        rejectedSelfUpdate.outbound,
        host.deviceId,
      ));
      const applicationAsCommitCode = await code(() => host.inspectInboundCommit(
        legitimate.outbound,
        bob.deviceId,
      ));
      const arbitraryCommitCode = await code(() => host.inspectInboundCommit(
        new Uint8Array([1, 2, 3, 4]),
        bob.deviceId,
      ));
      const commitInspectorWasIsolated = validCommitPreview.kind === "inbound-commit" &&
        validCommitPreview.senderDeviceId === bob.deviceId &&
        host.durableRevision === hostRevisionBeforeCommitPreview &&
        host.epoch === hostEpochBeforeCommitPreview &&
        JSON.stringify(host.roster()) === hostRosterBeforeCommitPreview;

      bob.dispose();
      bob = await engineModule.SecureRoomEngine.restore({
        roomInstance,
        roomSecret,
        store: bobStore,
        lease: bobLease,
      });
      const restartedRejectedUpdate = bob.pendingOutbox.find((entry) =>
        entry.messageId === rejectedSelfUpdate.messageId);
      const rejectedCommitRetryStable = restartedRejectedUpdate?.kind === "commit" &&
        base64Url(restartedRejectedUpdate.outbound) === rejectedUpdateWire &&
        restartedRejectedUpdate.grant.tokenId === rejectedUpdateGrant.tokenId &&
        restartedRejectedUpdate.grant.requestId === rejectedUpdateGrant.requestId;
      const commitSingleFlightCode = await code(() => bob.encryptEvent(
        { type: "chat", text: "must wait for commit decision" },
        grantFor(bob),
      ));
      const bobPendingCommitRecord = await bobStore.loadOpaqueState(storeKey);
      if (!bobPendingCommitRecord) throw new Error("pending commit durable record missing");
      const bobPendingCommitState = await stateModule.unprotectSecureRoomStateV1(
        bobPendingCommitRecord.state,
        roomInstance,
        roomSecret,
      );
      const commitRollbackOmitsPriorSnapshot = bobPendingCommitState.pendingCommitRollback !== null &&
        !Object.prototype.hasOwnProperty.call(bobPendingCommitState.pendingCommitRollback, "mlsSnapshot");

      const retryCommitPreview = await host.inspectInboundCommit(rejectedSelfUpdate.outbound, bob.deviceId);
      const hostRevisionBeforeMislabeledCommit = host.durableRevision;
      const hostEpochBeforeMislabeledCommit = host.epoch;
      const wrongCommitDeliverySenderCode = await code(() => host.receive(rejectedSelfUpdate.outbound, {
        messageId: rejectedSelfUpdate.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: null,
        relayContext: { kind: "commit" },
      }));
      const wrongCommitDeliveryOrderCode = await code(() => host.receive(rejectedSelfUpdate.outbound, {
        messageId: rejectedSelfUpdate.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: host.state.logicalOrder + 1,
        relayContext: { kind: "commit" },
      }));
      const mislabeledCommitRolledBack = host.durableRevision === hostRevisionBeforeMislabeledCommit &&
        host.epoch === hostEpochBeforeMislabeledCommit;
      const selfUpdateResult = await host.receive(rejectedSelfUpdate.outbound, {
        messageId: rejectedSelfUpdate.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: null,
        relayContext: { kind: "commit" },
      });
      await bob.acknowledgeOutbound(rejectedSelfUpdate.messageId);
      const memberSelfUpdateAccepted = retryCommitPreview.kind === "inbound-commit" &&
        selfUpdateResult.kind === "inbound-commit" && !selfUpdateResult.retired;

      const normalizedBefore = host.roster().map((entry) => ({
        leafIndex: entry.leafIndex,
        deviceId: entry.deviceId,
        signaturePublicKey: entry.signaturePublicKey,
        identity: decode(entry.deviceId),
        signatureKey: decode(entry.signaturePublicKey),
      }));
      const bobRosterEntry = normalizedBefore.find((entry) => entry.deviceId === bob.deviceId)!;
      const syntheticSameSetCode = await code(() => (
        host as unknown as {
          planInboundCommit: (transition: unknown, roster: unknown[], delivery: unknown) => Promise<unknown>;
        }
      ).planInboundCommit({
        kind: "inbound-commit",
        epoch: host.epoch + 1n,
        snapshot: new Uint8Array([1]),
        senderIdentity: decode(bob.deviceId),
        senderLeafIndex: bobRosterEntry.leafIndex,
        commitSummary: { addCount: 1, removeCount: 1, updateCount: 0, otherCount: 0, hasUpdatePath: true },
      }, normalizedBefore, {
        messageId: randomId(),
        fromDeviceId: bob.deviceId,
        logicalOrder: null,
        relayContext: { kind: "commit" },
      }));

      await bobStore.advanceReplay({
        roomInstance: lockKey,
        senderId: host.deviceId,
        sessionId: "B".repeat(16),
        sequence: 9,
      });
      const leave = await bob.encryptEvent({ type: "member-leave" }, grantFor(bob));
      const exactRemovalAuthorizationExposed =
        bob.pendingRemovalAuthorizationMessageId === leave.messageId;
      const unrelatedRemovalAuthorizationRejected =
        bob.pendingRemovalAuthorizationMessageId !== randomId();
      await host.receive(leave.outbound, {
        messageId: leave.messageId,
        fromDeviceId: bob.deviceId,
        logicalOrder: leave.event.logicalOrder,
        relayContext: { kind: "application" },
      });
      await bob.acknowledgeOutbound(leave.messageId);
      const acceptedRemovalAuthorizationCleared =
        bob.pendingRemovalAuthorizationMessageId === null;
      const signedRemovalHostChatBlocked = await code(() => host.encryptEvent(
        { type: "chat", text: "must not reach departing member" },
        grantFor(host),
      ));
      const signedRemovalMemberChatBlocked = await code(() => bob.encryptEvent(
        { type: "chat", text: "departing member cannot send" },
        grantFor(bob),
      ));
      const signedRemovalUpdateBlocked = await code(() => host.selfUpdate(grantFor(host)));
      const signedRemovalInboundAppBlocked = await code(() => host.receive(new Uint8Array([1]), {
        messageId: randomId(),
        fromDeviceId: bob.deviceId,
        logicalOrder: host.state.logicalOrder + 1,
        relayContext: { kind: "application" },
      }));
      const rawBobAtRemovalBarrier = await restoreRaw(bobStore);
      const staleSelfUpdate = await rawBobAtRemovalBarrier.selfUpdate();
      rawBobAtRemovalBarrier.dispose();
      const signedRemovalRevisionBeforeUpdate = host.durableRevision;
      const signedRemovalEpochBeforeUpdate = host.epoch;
      const signedRemovalInboundUpdateBlocked = await code(() => host.receive(staleSelfUpdate.outbound!, {
        messageId: randomId(),
        fromDeviceId: bob.deviceId,
        logicalOrder: null,
        relayContext: { kind: "commit" },
      }));
      const signedRemovalInboundUpdateRolledBack =
        host.durableRevision === signedRemovalRevisionBeforeUpdate &&
        host.epoch === signedRemovalEpochBeforeUpdate;
      const retirementBarrier = {
        deviceId: bob.deviceId,
        // Legacy wire name: this is the invitation-signed membership admission
        // id, never the unauthenticated outer MLS commit message id.
        admissionCommitMessageId: admissionId,
      };
      const randomRetirementMarkerCode = await code(async () => host.registerRetirementBarrier({
        deviceId: bob.deviceId,
        admissionCommitMessageId: randomId(),
      }));
      const crossBoundRetirementMarkerCode = await code(async () => host.registerRetirementBarrier({
        deviceId: bob.deviceId,
        admissionCommitMessageId: hostPackage.messageId,
      }));
      host.registerRetirementBarrier(retirementBarrier);
      bob.registerRetirementBarrier(retirementBarrier);
      const bobLeaf = host.roster().find((entry) => entry.deviceId === bob.deviceId)!.leafIndex;
      const wrongRetirementTargetCode = await code(() => host.removeMember(bobLeaf, grantFor(host), {
        deviceId: host.deviceId,
        admissionCommitMessageId: retirementBarrier.admissionCommitMessageId,
      }));
      const removal = await host.removeMember(bobLeaf, grantFor(host), retirementBarrier);
      const retirementControlAtomic = host.pendingRelayControls.some((control) =>
        control.kind === "retire-member" && control.deviceId === bob.deviceId &&
        control.commitMessageId === removal.messageId && control.requestId === removal.relayRequestId &&
        control.retirementAdmissionCommitMessageId === admissionId);
      host.dispose();
      host = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store: hostStore, lease: hostLease });
      const replayedMarkerBeforeAckCode = await code(async () => host.registerRetirementBarrier(retirementBarrier));
      const replayedMarkerRestoredExactBarrier =
        host.currentRetirementBarrier?.deviceId === retirementBarrier.deviceId &&
        host.currentRetirementBarrier?.admissionCommitMessageId === retirementBarrier.admissionCommitMessageId;
      await host.acknowledgeOutbound(removal.messageId);
      host.resolveRetirementBarrier(retirementBarrier);
      const retirementControlSurvivedCommitAck = host.pendingRelayControls.some((control) =>
        control.kind === "retire-member" && control.deviceId === bob.deviceId);
      host.dispose();
      host = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store: hostStore, lease: hostLease });
      const retirementControlSurvivedRestart = host.pendingRelayControls.some((control) =>
        control.kind === "retire-member" && control.deviceId === bob.deviceId &&
        control.commitMessageId === removal.messageId);
      const replayedMarkerAfterAckCode = await code(async () => host.registerRetirementBarrier(retirementBarrier));
      host.resolveRetirementBarrier(retirementBarrier);
      const originalBobCas = bobStore.compareAndSetOpaqueState.bind(bobStore);
      let removalIntermediateWrites = 0;
      (bobStore as unknown as {
        compareAndSetOpaqueState: typeof bobStore.compareAndSetOpaqueState;
      }).compareAndSetOpaqueState = async (...args) => {
        removalIntermediateWrites += 1;
        return originalBobCas(...args);
      };
      const wrongRetirementContextCode = await code(() => bob.receive(removal.outbound, {
        messageId: removal.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: null,
        relayContext: { kind: "commit" },
      }));
      const removedResult = await bob.receive(removal.outbound, {
        messageId: removal.messageId,
        fromDeviceId: host.deviceId,
        logicalOrder: null,
        relayContext: {
          kind: "commit",
          retirementDeviceId: retirementBarrier.deviceId,
          retirementAdmissionCommitMessageId: retirementBarrier.admissionCommitMessageId,
        },
      });
      await host.completeRelayControl({ kind: "member-lifecycle", deviceId: bob.deviceId, status: "retired" });
      const retirementControlCleared = !host.pendingRelayControls.some((control) =>
        control.kind === "retire-member" && control.deviceId === bob.deviceId);
      const removedOpaqueErased = await bobStore.loadOpaqueState(storeKey) === null;
      const removedReplaySurvived = await bobStore.replayHighWater({
        roomInstance: lockKey,
        senderId: host.deviceId,
        sessionId: "B".repeat(16),
      });

      const doomedRoomInstance = randomId();
      const doomedRoomSecret = `pf2_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const doomedStore = new storeModule.CryptoStateStore({
        databaseName: `secure-engine-doomed-${crypto.randomUUID()}`,
      });
      const doomedLockKey = await engineModule.secureRoomEngineStoreKey(doomedRoomInstance);
      const doomedStoreKey = await engineModule.secureRoomEngineStateKey(doomedRoomInstance, doomedRoomSecret);
      const doomed = await engineModule.SecureRoomEngine.createFounder({
        roomInstance: doomedRoomInstance,
        roomSecret: doomedRoomSecret,
        displayName: "Doomed",
        store: doomedStore,
        lease: fakeLease(doomedLockKey),
      });
      const doomedUpdate = await doomed.selfUpdate({
        v: 4,
        suite: 1,
        roomInstance: doomedRoomInstance,
        requestId: randomId(),
        tokenId: randomId(),
        deviceId: doomed.deviceId,
        logicalOrder: doomed.state.logicalOrder + 1,
        expiresAt: Date.now() + 60_000,
      });
      const rejectedCommitDisposition = await doomed.rejectOutbound(doomedUpdate.messageId);
      const rejectedCommitErasedOpaqueState = await doomedStore.loadOpaqueState(doomedStoreKey) === null;
      const rejectedCommitEngineRetiredCode = await code(async () => doomed.state);
      const rejectedCommitRetired = rejectedCommitDisposition === "retired";
      doomed.dispose();
      await doomedStore.close();

      const close = await host.encryptEvent(
        { type: "room-close", reason: "relay retirement test" },
        grantFor(host),
      );
      const closeControlAtomic = host.pendingRelayControls.some((control) => control.kind === "close-room" &&
        control.authorizationMessageId === close.messageId);
      await host.acknowledgeOutbound(close.messageId);
      host.dispose();
      host = await engineModule.SecureRoomEngine.restore({ roomInstance, roomSecret, store: hostStore, lease: hostLease });
      const closeControlSurvivedRestart = host.pendingRelayControls.some((control) => control.kind === "close-room" &&
        control.authorizationMessageId === close.messageId);
      await host.completeRelayControl({ kind: "room-retired" });
      const closeErasedOpaqueState = await hostStore.loadOpaqueState(storeKey) === null;
      const closedEngineRetiredCode = await code(async () => host.state);

      host.dispose();
      await hostStore.close();
      await bobStore.close();
      roomBinding.fill(0);
      return {
        resumeContext,
        resumeProof,
        resumeSignaturePublicKey,
        founderAdmissionPersistedBeforeSetupAck,
        founderAdmissionSurvivedSetupResponseLoss,
        wrongResumeBindingCode,
        substitutedKeyPackageCode,
        substitutedSignatureKeyCode,
        substitutedDeviceIdCode,
        substitutedAdmissionIdCode,
        keyPackageRetryStable,
        addArtifactsPersisted,
        commitAckRetainedAdmission,
        admissionRetryStable,
        bootstrapContextRetained,
        admissionRetainedUntilActivation,
        hostAdmissionChatBlocked,
        hostAdmissionUpdateBlocked,
        postProofChatStillBlocked,
        completedAdmissionCleared,
        durableWelcomeDelivery,
        durableJoinWelcomeRetained,
        reusedWelcomeIdCode,
        bootstrapSubset,
        duplicateBootstrapKind: duplicateBootstrap.kind,
        unboundJoinProofCode,
        inspectorWasIsolated,
        wrongPreviewSenderCode,
        wrongPreviewOrderCode,
        wrongDeliverySenderCode,
        wrongDeliveryOrderCode,
        mislabeledDeliveryRolledBack,
        inspectedThenConsumed,
        missingOfferRelayCode,
        transferOfferDurableOnBoth,
        hostTransferExpirationRenewed,
        transferAcceptCapabilityBound,
        missingTransferAcceptContextCode,
        genericTransferAcceptContextCode,
        wrongTransferAcceptCapabilityCode,
        exactTransferAcceptCapabilityAccepted,
        rejectedTransferAcceptRolledBack,
        rejectedTransferCleared,
        acceptedChatKind: acceptedChat.kind,
        duplicateChatKind: duplicateChat.kind,
        wrongReplayAttributionCode,
        reusedChatIdCode,
        replayCode,
        replayRolledBack,
        reorderCode,
        reorderedRecovered,
        senderMismatchCode,
        signatureMismatchCode,
        legitimateKind: legitimateResult.kind,
        badSecretCode,
        secretSurvivedRestart,
        secretHiddenAtRest,
        rejectedRevealKeptSecret,
        acceptedRevealDeletedSecret,
        hostAcceptedRevealDeletedSecret,
        unauthorizedCommitCode,
        unauthorizedRolledBack,
        wrongCommitOuterSenderCode,
        applicationAsCommitCode,
        arbitraryCommitCode,
        commitInspectorWasIsolated,
        rejectedCommitRetryStable,
        commitSingleFlightCode,
        commitRollbackOmitsPriorSnapshot,
        rejectedCommitRetired,
        rejectedCommitErasedOpaqueState,
        rejectedCommitEngineRetiredCode,
        wrongCommitDeliverySenderCode,
        wrongCommitDeliveryOrderCode,
        mislabeledCommitRolledBack,
        memberSelfUpdateAccepted,
        syntheticSameSetCode,
        exactRemovalAuthorizationExposed,
        unrelatedRemovalAuthorizationRejected,
        acceptedRemovalAuthorizationCleared,
        signedRemovalHostChatBlocked,
        signedRemovalMemberChatBlocked,
        signedRemovalUpdateBlocked,
        signedRemovalInboundAppBlocked,
        signedRemovalInboundUpdateBlocked,
        signedRemovalInboundUpdateRolledBack,
        randomRetirementMarkerCode,
        crossBoundRetirementMarkerCode,
        wrongRetirementTargetCode,
        wrongRetirementContextCode,
        retirementControlAtomic,
        replayedMarkerBeforeAckCode,
        replayedMarkerRestoredExactBarrier,
        replayedMarkerAfterAckCode,
        retirementControlSurvivedCommitAck,
        retirementControlSurvivedRestart,
        retirementControlCleared,
        closeControlAtomic,
        closeControlSurvivedRestart,
        closeErasedOpaqueState,
        closedEngineRetiredCode,
        removedRetired: removedResult.kind === "inbound-commit" && removedResult.retired,
        removalErasedWithoutIntermediateWrite: removalIntermediateWrites === 0,
        removedOpaqueErased,
        removedReplaySurvived,
      };
    }, roomInvitationMemberBindingModuleUrl);

    expect(await verifySecureDeviceResumeProofV4(
      result.resumeContext,
      result.resumeProof,
      result.resumeSignaturePublicKey,
    )).toBe(true);
    expect(result.founderAdmissionPersistedBeforeSetupAck).toBe(true);
    expect(result.founderAdmissionSurvivedSetupResponseLoss).toBe(true);
    expect(result.wrongResumeBindingCode).toBe("invalid-input");
    expect(result.substitutedKeyPackageCode).toBe("unauthorized");
    expect(result.substitutedSignatureKeyCode).toBe("unauthorized");
    expect(result.substitutedDeviceIdCode).toBe("unauthorized");
    expect(result.substitutedAdmissionIdCode).toBe("unauthorized");
    expect(result.keyPackageRetryStable).toBe(true);
    expect(result.addArtifactsPersisted).toBe(true);
    expect(result.commitAckRetainedAdmission).toBe(true);
    expect(result.admissionRetryStable).toBe(true);
    expect(result.bootstrapContextRetained).toBe(true);
    expect(result.admissionRetainedUntilActivation).toBe(true);
    expect(result.hostAdmissionChatBlocked).toBe("unauthorized");
    expect(result.hostAdmissionUpdateBlocked).toBe("unauthorized");
    expect(result.postProofChatStillBlocked).toBe("unauthorized");
    expect(result.completedAdmissionCleared).toBe(true);
    expect(result.durableWelcomeDelivery).toBe(true);
    expect(result.durableJoinWelcomeRetained).toBe(true);
    expect(result.reusedWelcomeIdCode).toBe("transition-invalid");
    expect(result.bootstrapSubset).toBe(true);
    expect(result.duplicateBootstrapKind).toBe("already-processed");
    expect(result.unboundJoinProofCode).toBe("unauthorized");
    expect(result.inspectorWasIsolated).toBe(true);
    expect(result.wrongPreviewSenderCode).toBe("unauthorized");
    expect(result.wrongPreviewOrderCode).toBe("transition-invalid");
    expect(result.wrongDeliverySenderCode).toBe("unauthorized");
    expect(result.wrongDeliveryOrderCode).toBe("transition-invalid");
    expect(result.mislabeledDeliveryRolledBack).toBe(true);
    expect(result.inspectedThenConsumed).toBe(true);
    expect(result.missingOfferRelayCode).toBe("invalid-input");
    expect(result.transferOfferDurableOnBoth).toBe(true);
    expect(result.hostTransferExpirationRenewed).toBe(true);
    expect(result.transferAcceptCapabilityBound).toBe(true);
    expect(result.missingTransferAcceptContextCode).toBe("invalid-input");
    expect(result.genericTransferAcceptContextCode).toBe("unauthorized");
    expect(result.wrongTransferAcceptCapabilityCode).toBe("unauthorized");
    expect(result.exactTransferAcceptCapabilityAccepted).toBe(true);
    expect(result.rejectedTransferAcceptRolledBack).toBe(true);
    expect(result.rejectedTransferCleared).toBe(true);
    expect(result.acceptedChatKind).toBe("inbound-application");
    expect(result.duplicateChatKind).toBe("already-processed");
    expect(result.wrongReplayAttributionCode).toBe("transition-invalid");
    expect(result.reusedChatIdCode).toBe("transition-invalid");
    expect(result.replayCode).toBe("invalid-input");
    expect(result.replayRolledBack).toBe(true);
    expect(result.reorderCode).toBe("transition-invalid");
    expect(result.reorderedRecovered).toBe(true);
    expect(result.senderMismatchCode).toBe("transition-invalid");
    expect(result.signatureMismatchCode).toBe("transition-invalid");
    expect(result.legitimateKind).toBe("inbound-application");
    expect(result.badSecretCode).toBe("invalid-input");
    expect(result.secretSurvivedRestart).toBe(true);
    expect(result.secretHiddenAtRest).toBe(true);
    expect(result.rejectedRevealKeptSecret).toBe(true);
    expect(result.acceptedRevealDeletedSecret).toBe(true);
    expect(result.hostAcceptedRevealDeletedSecret).toBe(true);
    expect(result.unauthorizedCommitCode).toBe("unauthorized");
    expect(result.unauthorizedRolledBack).toBe(true);
    expect(result.wrongCommitOuterSenderCode).toBe("unauthorized");
    expect(result.applicationAsCommitCode).toBe("transition-invalid");
    expect(result.arbitraryCommitCode).toBe("transition-invalid");
    expect(result.commitInspectorWasIsolated).toBe(true);
    expect(result.rejectedCommitRetryStable).toBe(true);
    expect(result.commitSingleFlightCode).toBe("transition-invalid");
    expect(result.commitRollbackOmitsPriorSnapshot).toBe(true);
    expect(result.rejectedCommitRetired).toBe(true);
    expect(result.rejectedCommitErasedOpaqueState).toBe(true);
    expect(result.rejectedCommitEngineRetiredCode).toBe("retired");
    expect(result.wrongCommitDeliverySenderCode).toBe("unauthorized");
    expect(result.wrongCommitDeliveryOrderCode).toBe("invalid-input");
    expect(result.mislabeledCommitRolledBack).toBe(true);
    expect(result.memberSelfUpdateAccepted).toBe(true);
    expect(result.syntheticSameSetCode).toBe("transition-invalid");
    expect(result.exactRemovalAuthorizationExposed).toBe(true);
    expect(result.unrelatedRemovalAuthorizationRejected).toBe(true);
    expect(result.acceptedRemovalAuthorizationCleared).toBe(true);
    expect(result.signedRemovalHostChatBlocked).toBe("unauthorized");
    expect(result.signedRemovalMemberChatBlocked).toBe("unauthorized");
    expect(result.signedRemovalUpdateBlocked).toBe("unauthorized");
    expect(result.signedRemovalInboundAppBlocked).toBe("unauthorized");
    expect(result.signedRemovalInboundUpdateBlocked).toBe("unauthorized");
    expect(result.signedRemovalInboundUpdateRolledBack).toBe(true);
    expect(result.randomRetirementMarkerCode).toBe("unauthorized");
    expect(result.crossBoundRetirementMarkerCode).toBe("unauthorized");
    expect(result.wrongRetirementTargetCode).toBe("unauthorized");
    expect(result.wrongRetirementContextCode).toBe("unauthorized");
    expect(result.retirementControlAtomic).toBe(true);
    expect(result.replayedMarkerBeforeAckCode).toBe("accepted");
    expect(result.replayedMarkerRestoredExactBarrier).toBe(true);
    expect(result.replayedMarkerAfterAckCode).toBe("accepted");
    expect(result.retirementControlSurvivedCommitAck).toBe(true);
    expect(result.retirementControlSurvivedRestart).toBe(true);
    expect(result.retirementControlCleared).toBe(true);
    expect(result.closeControlAtomic).toBe(true);
    expect(result.closeControlSurvivedRestart).toBe(true);
    expect(result.closeErasedOpaqueState).toBe(true);
    expect(result.closedEngineRetiredCode).toBe("retired");
    expect(result.removedRetired).toBe(true);
    expect(result.removalErasedWithoutIntermediateWrite).toBe(true);
    expect(result.removedOpaqueErased).toBe(true);
    expect(result.removedReplaySurvived).toBe(9);
  }, 180_000);

  it("requires explicit, exact, deduplicated host approval before admitting an invitation holder", async () => {
    const result = await page.evaluate(async (bindingModuleUrl) => {
      const [{ SecureRoomController, secureAdmissionBindingFingerprintV4 }, { useGameStore }, stateModule, invitationModule, bindingModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/stores/gameStore.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureInvitationAuth.ts"),
        import(bindingModuleUrl),
      ]);
      const toBase64Url = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
      };
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const roomId = "abcdefghij";
      const roomSecret = `pf2_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const safetyCode = await invitationModule.secureRoomInvitationSafetyCodeV4(roomId, roomInstance, roomSecret);
      const repeatedSafetyCode = await invitationModule.secureRoomInvitationSafetyCodeV4(roomId, roomInstance, roomSecret);
      const otherInstanceSafetyCode = await invitationModule.secureRoomInvitationSafetyCodeV4(
        roomId,
        stateModule.randomSecureRoomIdV4(16),
        roomSecret,
      );
      const hostDeviceId = stateModule.randomSecureRoomIdV4(16);
      const ejectedDeviceReplacement = stateModule.randomSecureRoomIdV4(16);
      const replacementSignaturePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      const firstAdmissionId = stateModule.randomSecureRoomIdV4(16);
      const approvedAdmissionId = stateModule.randomSecureRoomIdV4(16);
      const unrelatedAdmissionId = stateModule.randomSecureRoomIdV4(16);
      const expiredAdmissionId = stateModule.randomSecureRoomIdV4(16);
      const boundaryAdmissionId = stateModule.randomSecureRoomIdV4(16);
      const firstKeyPackage = new Uint8Array([1, 2, 3, 4]);
      const approvedKeyPackage = new Uint8Array([5, 6, 7, 8]);
      const validationController = new SecureRoomController();
      const missingFortPassClaimRejected = await validationController.setup({
        roomId,
        roomSecret,
        displayName: "Host",
        fortPassSessionId: "cs_test_paid",
      });
      const malformedFortPassClaimRejected = await validationController.setup({
        roomId,
        roomSecret,
        displayName: "Host",
        fortPassSessionId: "cs_test_paid",
        fortPassClaimSecret: "A".repeat(64),
      });
      const claimWithoutSessionRejected = await validationController.setup({
        roomId,
        roomSecret,
        displayName: "Host",
        fortPassClaimSecret: "a".repeat(64),
      });
      const paidFieldsOnJoinRejected = await validationController.join({
        roomId,
        roomSecret,
        displayName: "Guest",
        fortPassSessionId: "cs_test_paid",
        fortPassClaimSecret: "a".repeat(64),
      });
      const controller = new SecureRoomController();
      const harness = controller as any;
      const addCalls: Array<{ admissionId: string; keyPackage: string }> = [];
      const sentFrames: unknown[] = [];
      const sentPendingEntries: string[] = [];
      const grantIntents: Array<{ key: string; run: (grant: unknown) => Promise<string | null> }> = [];
      let addGate: Promise<void> | null = null;
      let establishAdmissionBarrier = false;
      const applicationState = {
        logicalOrder: 1,
        hostDeviceId,
        pendingHostDeviceId: null,
        pendingRemovalDeviceIds: [],
        members: [{ deviceId: hostDeviceId }],
        vote: null,
        rps: null,
        ttt: null,
        saboteur: null,
      };
      const fakeEngine: any = {
        roomInstance,
        deviceId: hostDeviceId,
        state: applicationState,
        pendingOutbox: [],
        pendingRelayControls: [],
        pendingAdmissionBarrier: null,
        isActive: () => true,
        addMember: async (keyPackage: Uint8Array, admissionId: string) => {
          addCalls.push({ admissionId, keyPackage: toBase64Url(keyPackage) });
          if (addGate) await addGate;
          if (establishAdmissionBarrier) fakeEngine.pendingAdmissionBarrier = { admissionId };
          return { messageId: stateModule.randomSecureRoomIdV4(16) };
        },
        dispose: () => {},
      };
      harness.engine = fakeEngine;
      harness.authenticated = true;
      harness.stopped = false;
      harness.terminal = false;
      harness.replayingBacklog = false;
      harness.socket = { readyState: WebSocket.OPEN };
      harness.config = {
        initialMode: "setup",
        roomId,
        roomSecret,
        displayName: "Host Private Name",
        setupRoomInstance: roomInstance,
      };
      harness.sendClientFrame = (frame: unknown) => sentFrames.push(frame);
      harness.sendPendingEntry = (messageId: string) => { sentPendingEntries.push(messageId); };
      harness.enqueueGrantIntent = (intent: { key: string; run: (grant: unknown) => Promise<string | null> }) => {
        grantIntents.push(intent);
      };
      useGameStore.getState().setPendingAdmissions([]);

      const makeFrame = async (admissionId: string, keyPackage: Uint8Array) => {
        const memberBinding = await invitationModule.createRoomInvitationMemberBindingV4({
          mode: "admission",
          roomId,
          roomInstance,
          deviceId: ejectedDeviceReplacement,
          admissionId,
          signaturePublicKey: replacementSignaturePublicKey,
          keyPackageDigest: await bindingModule.secureKeyPackageDigestV4(keyPackage),
        }, roomSecret);
        return {
          kind: "secure-server" as const,
          v: 4 as const,
          suite: 1 as const,
          type: "deliver-key-package" as const,
          fromDeviceId: ejectedDeviceReplacement,
          admissionId,
          memberBinding,
          hello: {
            v: 4 as const,
            suite: 1 as const,
            roomInstance,
            deviceId: ejectedDeviceReplacement,
            keyPackage: toBase64Url(keyPackage),
          },
        };
      };

      const firstFrame = await makeFrame(firstAdmissionId, firstKeyPackage);
      await harness.handleKeyPackage(firstFrame);
      await harness.handleKeyPackage(firstFrame);
      const noSilentReadmission = addCalls.length === 0;
      const duplicatePromptsOnce = useGameStore.getState().pendingAdmissions.length === 1;
      const hostFingerprint = useGameStore.getState().pendingAdmissions[0]?.deviceFingerprint;
      harness.publishPendingJoinFingerprint(firstFrame.memberBinding);
      const guestFingerprint = useGameStore.getState().pendingJoinFingerprint;
      const hostAndGuestFingerprintsMatch = hostFingerprint === guestFingerprint &&
        guestFingerprint === secureAdmissionBindingFingerprintV4(firstFrame.memberBinding);
      harness.publishPendingJoinFingerprint(null);
      const relayMetadataHidesDisplayName = !JSON.stringify(firstFrame).includes("Host Private Name");
      await harness.mapUiAction("admission-reject", { admissionId: firstAdmissionId });
      const rejectionDidNotAdd = addCalls.length === 0 && useGameStore.getState().pendingAdmissions.length === 0;
      const exactCancellation = sentFrames.some((candidate) => {
        const frame = candidate as { kind?: string; admissionId?: string; deviceId?: string };
        return frame.kind === "cancel-admission" && frame.admissionId === firstAdmissionId &&
          frame.deviceId === ejectedDeviceReplacement;
      });

      await harness.handleKeyPackage(await makeFrame(approvedAdmissionId, approvedKeyPackage));
      await harness.handleKeyPackage(await makeFrame(unrelatedAdmissionId, new Uint8Array([15, 16, 17])));
      await harness.mapUiAction("admission-approve", { admissionId: stateModule.randomSecureRoomIdV4(16) });
      const wrongAdmissionCannotApprove = grantIntents.length === 0 && addCalls.length === 0;
      await harness.mapUiAction("admission-approve", { admissionId: approvedAdmissionId });
      const approvalStillDoesNotAdvanceBeforeGrant = addCalls.length === 0 && grantIntents.length === 1;
      establishAdmissionBarrier = true;
      await grantIntents[0].run({
        v: 4,
        suite: 1,
        roomInstance,
        requestId: stateModule.randomSecureRoomIdV4(16),
        tokenId: stateModule.randomSecureRoomIdV4(16),
        deviceId: hostDeviceId,
        logicalOrder: 2,
        expiresAt: Date.now() + 30_000,
      });
      establishAdmissionBarrier = false;
      fakeEngine.pendingAdmissionBarrier = null;
      const approvedExactAdmissionOnly = addCalls.length === 1 &&
        addCalls[0].admissionId === approvedAdmissionId &&
        addCalls[0].keyPackage === toBase64Url(approvedKeyPackage) &&
        useGameStore.getState().pendingAdmissions.length === 0 &&
        sentPendingEntries.length === 1 && !harness.terminal;
      const barrierCancelledOnlyUnrelatedAdmission = sentFrames.some((candidate) => {
        const frame = candidate as { kind?: string; admissionId?: string };
        return frame.kind === "cancel-admission" && frame.admissionId === unrelatedAdmissionId;
      }) && !sentFrames.some((candidate) => {
        const frame = candidate as { kind?: string; admissionId?: string };
        return frame.kind === "cancel-admission" && frame.admissionId === approvedAdmissionId;
      });

      await harness.handleKeyPackage(await makeFrame(expiredAdmissionId, new Uint8Array([9, 10, 11])));
      harness.pendingHostAdmissions.get(expiredAdmissionId).expiresAt = Date.now() - 1;
      await harness.mapUiAction("admission-approve", { admissionId: expiredAdmissionId });
      const expiryBoundaryCannotAdvanceMls = addCalls.length === 1 && grantIntents.length === 1 &&
        !harness.pendingHostAdmissions.has(expiredAdmissionId);

      let releaseAdd!: () => void;
      addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
      await harness.handleKeyPackage(await makeFrame(boundaryAdmissionId, new Uint8Array([12, 13, 14])));
      await harness.mapUiAction("admission-approve", { admissionId: boundaryAdmissionId });
      const boundaryIntent = grantIntents[1];
      const boundaryRun = boundaryIntent.run({
        v: 4,
        suite: 1,
        roomInstance,
        requestId: stateModule.randomSecureRoomIdV4(16),
        tokenId: stateModule.randomSecureRoomIdV4(16),
        deviceId: hostDeviceId,
        logicalOrder: 3,
        expiresAt: Date.now() + 30_000,
      });
      await Promise.resolve();
      const boundaryPending = harness.pendingHostAdmissions.get(boundaryAdmissionId);
      boundaryPending.expiresAt = Date.now();
      harness.armPendingHostAdmissionTimeout(boundaryPending);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await harness.serialQueue;
      const inFlightApprovalSurvivesTimeout = harness.pendingHostAdmissions.get(boundaryAdmissionId) === boundaryPending &&
        boundaryPending.inFlight;
      releaseAdd();
      await boundaryRun;
      addGate = null;
      const inFlightApprovalCompletesExactlyOnce = addCalls.filter((call) =>
        call.admissionId === boundaryAdmissionId).length === 1 &&
        !harness.pendingHostAdmissions.has(boundaryAdmissionId);

      for (let index = 0; index < 400; index += 1) harness.trackTransientControlId(`control-${index}`);
      const transientControlIdsBoundedAndAged = harness.transientControlIds.size <= 256 &&
        !harness.transientControlIds.has("control-0") && harness.transientControlIds.has("control-399");
      let outboundUiCapEnforced = false;
      try {
        for (let index = 0; index < 100; index += 1) {
          harness.rememberOutboundUi(`outbound-${index}`, { state: applicationState, effects: [] });
        }
      } catch {
        outboundUiCapEnforced = harness.outboundUi.size < 100;
      }
      harness.outboundUi.clear();
      let messageIntentCapEnforced = false;
      try {
        for (let index = 0; index < 100; index += 1) {
          harness.rememberMessageIntent(`message-${index}`, `intent-${index}`);
        }
      } catch {
        messageIntentCapEnforced = harness.messageIntentKeys.size < 100;
      }
      harness.messageIntentKeys.clear();
      for (let index = 0; index < 100; index += 1) harness.rememberIntentKey(`queued-${index}`);
      const intentKeysBounded = harness.intentKeys.size < 100;
      harness.intentKeys.clear();

      let drawReschedules = 0;
      harness.scheduleDrawingFlush = () => { drawReschedules += 1; };
      for (const messageId of ["draw-accepted", "draw-rejected"]) {
        harness.intentKeys.add("drawing");
        harness.messageIntentKeys.set(messageId, "drawing");
        harness.releaseMessageIntent(messageId);
      }
      const drawReschedulesAfterAcceptAndReject = drawReschedules === 2;

      harness.intentKeys.add("leftover");
      harness.messageIntentKeys.set("leftover", "leftover");
      harness.outboundUi.set("leftover", { state: applicationState, effects: [] });
      harness.transientControlIds.add("leftover");
      harness.sentDurableControls.add("leftover");
      harness.grantQueue.push({ key: "leftover", run: async () => null });
      harness.pendingGrant = { requestId: "leftover", intent: harness.grantQueue[0] };
      harness.publishPendingJoinFingerprint(firstFrame.memberBinding);
      useGameStore.getState().setRoomSafetyCode(safetyCode);
      harness.clearTimers();
      const clearTimersClearsTransientState = harness.intentKeys.size === 0 &&
        harness.messageIntentKeys.size === 0 && harness.outboundUi.size === 0 &&
        harness.transientControlIds.size === 0 && harness.sentDurableControls.size === 0 &&
        harness.grantQueue.length === 0 && harness.pendingGrant === null &&
        useGameStore.getState().pendingJoinFingerprint === null &&
        useGameStore.getState().roomSafetyCode === null;
      harness.intentKeys.add("disconnect-leftover");
      harness.outboundUi.set("disconnect-leftover", { state: applicationState, effects: [] });
      harness.socket = null;
      await controller.disconnect();
      const disconnectClearsTransientState = harness.intentKeys.size === 0 && harness.outboundUi.size === 0 &&
        useGameStore.getState().pendingAdmissions.length === 0 &&
        useGameStore.getState().pendingJoinFingerprint === null;
      return {
        safetyCodeStableAndRoomBound: safetyCode === repeatedSafetyCode &&
          safetyCode !== otherInstanceSafetyCode && /^[A-Za-z0-9_-]{4}(?:-[A-Za-z0-9_-]{4}){2}$/u.test(safetyCode),
        missingFortPassClaimRejected: missingFortPassClaimRejected.reason === "invalid-input",
        malformedFortPassClaimRejected: malformedFortPassClaimRejected.reason === "invalid-input",
        claimWithoutSessionRejected: claimWithoutSessionRejected.reason === "invalid-input",
        paidFieldsOnJoinRejected: paidFieldsOnJoinRejected.reason === "invalid-input",
        noSilentReadmission,
        duplicatePromptsOnce,
        hostAndGuestFingerprintsMatch,
        relayMetadataHidesDisplayName,
        rejectionDidNotAdd,
        exactCancellation,
        wrongAdmissionCannotApprove,
        approvalStillDoesNotAdvanceBeforeGrant,
        approvedExactAdmissionOnly,
        barrierCancelledOnlyUnrelatedAdmission,
        expiryBoundaryCannotAdvanceMls,
        inFlightApprovalSurvivesTimeout,
        inFlightApprovalCompletesExactlyOnce,
        transientControlIdsBoundedAndAged,
        outboundUiCapEnforced,
        messageIntentCapEnforced,
        intentKeysBounded,
        drawReschedulesAfterAcceptAndReject,
        clearTimersClearsTransientState,
        disconnectClearsTransientState,
      };
    }, roomInvitationMemberBindingModuleUrl);

    expect(result.safetyCodeStableAndRoomBound).toBe(true);
    expect(result.missingFortPassClaimRejected).toBe(true);
    expect(result.malformedFortPassClaimRejected).toBe(true);
    expect(result.claimWithoutSessionRejected).toBe(true);
    expect(result.paidFieldsOnJoinRejected).toBe(true);
    expect(result.noSilentReadmission).toBe(true);
    expect(result.duplicatePromptsOnce).toBe(true);
    expect(result.hostAndGuestFingerprintsMatch).toBe(true);
    expect(result.relayMetadataHidesDisplayName).toBe(true);
    expect(result.rejectionDidNotAdd).toBe(true);
    expect(result.exactCancellation).toBe(true);
    expect(result.wrongAdmissionCannotApprove).toBe(true);
    expect(result.approvalStillDoesNotAdvanceBeforeGrant).toBe(true);
    expect(result.approvedExactAdmissionOnly).toBe(true);
    expect(result.barrierCancelledOnlyUnrelatedAdmission).toBe(true);
    expect(result.expiryBoundaryCannotAdvanceMls).toBe(true);
    expect(result.inFlightApprovalSurvivesTimeout).toBe(true);
    expect(result.inFlightApprovalCompletesExactlyOnce).toBe(true);
    expect(result.transientControlIdsBoundedAndAged).toBe(true);
    expect(result.outboundUiCapEnforced).toBe(true);
    expect(result.messageIntentCapEnforced).toBe(true);
    expect(result.intentKeysBounded).toBe(true);
    expect(result.drawReschedulesAfterAcceptAndReject).toBe(true);
    expect(result.clearTimersClearsTransientState).toBe(true);
    expect(result.disconnectClearsTransientState).toBe(true);
  });

  it("cancels queued and in-flight ordinary work at membership barriers and binds zombie removal exactly", async () => {
    const result = await page.evaluate(async (reducerModuleUrl) => {
      const [{ SecureRoomController }, stateModule, reducerModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import(reducerModuleUrl),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const hostDeviceId = stateModule.randomSecureRoomIdV4(16);
      const targetDeviceId = stateModule.randomSecureRoomIdV4(16);
      const admissionId = stateModule.randomSecureRoomIdV4(16);
      const markerId = stateModule.randomSecureRoomIdV4(16);
      const sentFrames: unknown[] = [];
      const removeCalls: Array<{ deviceId: string; marker: unknown }> = [];
      let registeredMarker: unknown = null;
      let resolvedMarker: unknown = null;
      let targetPresent = true;
      let ownRetired = false;
      const admissionLifecycleCalls: Array<{ deviceId: string; status: string }> = [];
      const applicationState = reducerModule.createSecureRoomStateV4(roomInstance, [
        {
          deviceId: hostDeviceId,
          displayName: "Host",
          signaturePublicKey: stateModule.randomSecureRoomIdV4(32),
        },
        {
          deviceId: targetDeviceId,
          displayName: "Target",
          signaturePublicKey: stateModule.randomSecureRoomIdV4(32),
        },
      ], hostDeviceId);
      const rejectedCancelledMessages: string[] = [];
      const fakeEngine = {
        roomInstance,
        deviceId: hostDeviceId,
        state: applicationState,
        pendingAdmissionBarrier: { admissionId, deviceId: targetDeviceId } as { admissionId: string; deviceId: string } | null,
        pendingSignedRemovalDeviceId: null as string | null,
        pendingRemovalAuthorizationMessageId: null as string | null,
        pendingOutbox: [] as any[],
        pendingRelayControls: [] as unknown[],
        roster: () => [
          { leafIndex: 0, deviceId: hostDeviceId },
          ...(targetPresent ? [{ leafIndex: 1, deviceId: targetDeviceId }] : []),
        ],
        isActive: () => true,
        registerRetirementBarrier: (marker: unknown) => { registeredMarker = marker; return true; },
        resolveRetirementBarrier: (marker: unknown) => { resolvedMarker = marker; },
        completeAdmissionLifecycle: async (deviceId: string, status: "active" | "retired") => {
          admissionLifecycleCalls.push({ deviceId, status });
          if (fakeEngine.pendingAdmissionBarrier?.deviceId !== deviceId) return false;
          fakeEngine.pendingAdmissionBarrier = null;
          return true;
        },
        retire: async () => { ownRetired = true; },
        rejectOutbound: async (messageId: string) => {
          rejectedCancelledMessages.push(messageId);
          fakeEngine.pendingOutbox = fakeEngine.pendingOutbox.filter((entry) => entry.messageId !== messageId);
          return "reverted" as const;
        },
        removeMember: async (_leafIndex: number, _grant: unknown, marker: unknown) => {
          removeCalls.push({ deviceId: targetDeviceId, marker });
          return { messageId: stateModule.randomSecureRoomIdV4(16), effects: [] };
        },
        dispose: () => {},
      };
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.engine = fakeEngine;
      harness.authenticated = false;
      harness.stopped = false;
      harness.terminal = false;
      harness.replayingBacklog = false;
      harness.socket = { readyState: WebSocket.OPEN };
      harness.sendClientFrame = (frame: unknown) => sentFrames.push(frame);
      harness.sendPendingEntry = () => {};

      let ordinaryRuns = 0;
      let bootstrapRuns = 0;
      harness.enqueueGrantIntent({ key: "chat:queued", run: async () => { ordinaryRuns += 1; return null; } });
      harness.enqueueGrantIntent({ key: `bootstrap:${admissionId}`, run: async () => { bootstrapRuns += 1; return null; } });
      const admissionOnlyKeepsBootstrap = harness.grantQueue.length === 1 &&
        harness.grantQueue[0].key === `bootstrap:${admissionId}`;

      const staleRequestId = stateModule.randomSecureRoomIdV4(16);
      const staleIntent = { key: "chat:in-flight", run: async () => { ordinaryRuns += 1; return null; } };
      harness.intentKeys.add(staleIntent.key);
      harness.pendingGrant = { requestId: staleRequestId, intent: staleIntent };
      harness.authenticated = true;
      await harness.handleGrant({
        v: 4,
        suite: 1,
        roomInstance,
        requestId: staleRequestId,
        tokenId: stateModule.randomSecureRoomIdV4(16),
        deviceId: hostDeviceId,
        logicalOrder: 2,
        expiresAt: Date.now() + 30_000,
      });
      const inFlightOrdinaryWasReplaced = ordinaryRuns === 0 && bootstrapRuns === 1;

      harness.authenticated = false;
      fakeEngine.pendingAdmissionBarrier = null;
      harness.enqueueGrantIntent({ key: "chat:before-removal", run: async () => { ordinaryRuns += 1; return null; } });
      fakeEngine.pendingSignedRemovalDeviceId = targetDeviceId;
      fakeEngine.state.pendingRemovalDeviceIds = [targetDeviceId];
      const causalRemovalMessageId = stateModule.randomSecureRoomIdV4(16);
      fakeEngine.pendingRemovalAuthorizationMessageId = causalRemovalMessageId;
      const causalRemovalApplicationAllowed = harness.isPendingEntryAllowedDuringMembershipBarrier({
        kind: "application",
        messageId: causalRemovalMessageId,
      });
      const unrelatedRemovalApplicationBlocked = !harness.isPendingEntryAllowedDuringMembershipBarrier({
        kind: "application",
        messageId: stateModule.randomSecureRoomIdV4(16),
      });
      const cancelledRequestId = stateModule.randomSecureRoomIdV4(16);
      const cancelledMessageId = stateModule.randomSecureRoomIdV4(16);
      fakeEngine.pendingOutbox = [{
        kind: "application",
        messageId: cancelledMessageId,
        grant: { requestId: cancelledRequestId },
      }];
      harness.intentKeys.add("chat:already-encrypted");
      harness.messageIntentKeys.set(cancelledMessageId, "chat:already-encrypted");
      harness.outboundUi.set(cancelledMessageId, { state: applicationState, effects: [] });
      await harness.handleOrderCancelled(cancelledRequestId, "removal-pending");
      const postEncryptionCancellationRolledBack =
        rejectedCancelledMessages.length === 1 && rejectedCancelledMessages[0] === cancelledMessageId &&
        fakeEngine.pendingOutbox.length === 0 && !harness.messageIntentKeys.has(cancelledMessageId) &&
        !harness.intentKeys.has("chat:already-encrypted");
      harness.activateMembershipBarrier();
      const signedRemovalPurgedQueue = !harness.grantQueue.some((intent: { key: string }) =>
        intent.key === "chat:before-removal") && harness.grantQueue.some((intent: { key: string }) =>
        intent.key.startsWith(`remove:${targetDeviceId}:`));
      const signedRemovalIntent = harness.grantQueue.find((intent: { key: string }) =>
        intent.key.startsWith(`remove:${targetDeviceId}:`));
      await signedRemovalIntent.run({
        v: 4,
        suite: 1,
        roomInstance,
        requestId: stateModule.randomSecureRoomIdV4(16),
        tokenId: stateModule.randomSecureRoomIdV4(16),
        deviceId: hostDeviceId,
        logicalOrder: 2,
        expiresAt: Date.now() + 30_000,
      });
      const signedRemovalPassesNoRelayMarker = removeCalls.length === 1 && removeCalls[0].marker === undefined;

      harness.clearTimers();
      harness.engine = fakeEngine;
      harness.authenticated = false;
      harness.stopped = false;
      harness.terminal = false;
      fakeEngine.pendingSignedRemovalDeviceId = null;
      fakeEngine.state.pendingRemovalDeviceIds = [];
      harness.handleZombieRemovalRequired(targetDeviceId, markerId);
      harness.enqueueGrantIntent({ key: "chat:during-zombie", run: async () => { ordinaryRuns += 1; return null; } });
      const zombieIntent = harness.grantQueue.find((intent: { key: string }) =>
        intent.key === `remove:${targetDeviceId}:zombie:${markerId}`);
      await zombieIntent.run({
        v: 4,
        suite: 1,
        roomInstance,
        requestId: stateModule.randomSecureRoomIdV4(16),
        tokenId: stateModule.randomSecureRoomIdV4(16),
        deviceId: hostDeviceId,
        logicalOrder: 2,
        expiresAt: Date.now() + 30_000,
      });
      const zombieRemovalBoundExactly = JSON.stringify(registeredMarker) === JSON.stringify({
        deviceId: targetDeviceId,
        admissionCommitMessageId: markerId,
      }) && JSON.stringify(removeCalls[1]?.marker) === JSON.stringify({
        deviceId: targetDeviceId,
        admissionCommitMessageId: markerId,
      }) && !harness.grantQueue.some((intent: { key: string }) => intent.key === "chat:during-zombie");
      targetPresent = false;
      await harness.handleMemberLifecycle(targetDeviceId, "retired");
      const absentTargetLifecycleClearsReplayedMarker = JSON.stringify(resolvedMarker) === JSON.stringify({
        deviceId: targetDeviceId,
        admissionCommitMessageId: markerId,
      }) && harness.retirementBarriers.size === 0;
      targetPresent = true;
      fakeEngine.pendingAdmissionBarrier = { admissionId, deviceId: targetDeviceId };
      harness.replayingBacklog = true;
      harness.roomStateSnapshotReceived = false;
      await harness.handleRoomStateSnapshot({
        hostDeviceId,
        members: [
          { deviceId: hostDeviceId, status: "active" },
          { deviceId: targetDeviceId, status: "active" },
        ],
        pendingHostTransfer: null,
      });
      const replayedActiveLifecycleClearsAdmission = fakeEngine.pendingAdmissionBarrier === null &&
        admissionLifecycleCalls.some((call) => call.deviceId === targetDeviceId && call.status === "active") &&
        harness.roomStateSnapshotReceived;
      harness.roomStateSnapshotReceived = false;
      let activeWithoutPriorAddCode = "accepted";
      try {
        await harness.handleRoomStateSnapshot({
          hostDeviceId,
          members: [
            { deviceId: hostDeviceId, status: "active" },
            { deviceId: targetDeviceId, status: "active" },
            { deviceId: stateModule.randomSecureRoomIdV4(16), status: "active" },
          ],
          pendingHostTransfer: null,
        });
      } catch (error) {
        activeWithoutPriorAddCode = (error as { code?: string }).code || "error";
      }
      await harness.handleMemberLifecycle(hostDeviceId, "retired");
      const ownRetiredLifecycleTerminalized = ownRetired && harness.engine === null && harness.terminal;
      return {
        admissionOnlyKeepsBootstrap,
        inFlightOrdinaryWasReplaced,
        postEncryptionCancellationRolledBack,
        causalRemovalApplicationAllowed,
        unrelatedRemovalApplicationBlocked,
        signedRemovalPurgedQueue,
        signedRemovalPassesNoRelayMarker,
        zombieRemovalBoundExactly,
        absentTargetLifecycleClearsReplayedMarker,
        replayedActiveLifecycleClearsAdmission,
        activeWithoutPriorAddCode,
        ownRetiredLifecycleTerminalized,
      };
    }, secureGameReducerModuleUrl);

    expect(result.admissionOnlyKeepsBootstrap).toBe(true);
    expect(result.inFlightOrdinaryWasReplaced).toBe(true);
    expect(result.postEncryptionCancellationRolledBack).toBe(true);
    expect(result.causalRemovalApplicationAllowed).toBe(true);
    expect(result.unrelatedRemovalApplicationBlocked).toBe(true);
    expect(result.signedRemovalPurgedQueue).toBe(true);
    expect(result.signedRemovalPassesNoRelayMarker).toBe(true);
    expect(result.zombieRemovalBoundExactly).toBe(true);
    expect(result.absentTargetLifecycleClearsReplayedMarker).toBe(true);
    expect(result.replayedActiveLifecycleClearsAdmission).toBe(true);
    expect(result.activeWithoutPriorAddCode).toBe("unauthorized");
    expect(result.ownRetiredLifecycleTerminalized).toBe(true);
  });

  it("renders the terminal Tic-Tac-Toe move on the result board", async () => {
    const result = await page.evaluate(async (reducerModuleUrl) => {
      const [uiModule, storeModule, stateModule, reducerModule] = await Promise.all([
        import("/src/services/secureUiV4.ts"),
        import("/src/stores/gameStore.ts"),
        import("/src/services/secureRoomState.ts"),
        import(reducerModuleUrl),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const lunaDeviceId = stateModule.randomSecureRoomIdV4(16);
      const priyaDeviceId = stateModule.randomSecureRoomIdV4(16);
      const gameId = stateModule.randomSecureRoomIdV4(16);
      const state = reducerModule.createSecureRoomStateV4(roomInstance, [
        {
          deviceId: lunaDeviceId,
          displayName: "luna",
          signaturePublicKey: stateModule.randomSecureRoomIdV4(32),
        },
        {
          deviceId: priyaDeviceId,
          displayName: "priya",
          signaturePublicKey: stateModule.randomSecureRoomIdV4(32),
        },
      ], lunaDeviceId);
      state.ttt = {
        gameId,
        p1DeviceId: lunaDeviceId,
        p2DeviceId: priyaDeviceId,
        phase: "playing",
        board: ["O", "O", "X", "", "X", "X", "O", "", ""],
        turn: 6,
      };
      uiModule.initializeSecureRoomUiV4({
        roomId: "abcdefghij",
        ownDeviceId: lunaDeviceId,
        state,
      });
      const terminalState = structuredClone(state);
      terminalState.ttt = null;
      uiModule.applySecureRoomUiV4(terminalState, [
        { type: "ttt-updated", gameId, cell: 8, mark: "X", turn: 7 },
        { type: "ttt-result", gameId, winnerDeviceId: lunaDeviceId, draw: false },
      ], lunaDeviceId);
      const rendered = storeModule.useGameStore.getState().tttState;
      const output = {
        board: rendered?.board ?? [],
        turn: rendered?.turn ?? null,
        winner: rendered?.winner ?? null,
        phase: rendered?.phase ?? null,
      };
      uiModule.resetSecureRoomUiV4();
      storeModule.useGameStore.getState().cleanup();
      return output;
    }, secureGameReducerModuleUrl);

    expect(result.board).toEqual(["O", "O", "X", "", "X", "X", "O", "", "X"]);
    expect(result.turn).toBe(7);
    expect(result.winner).toBe("luna");
    expect(result.phase).toBe("result");
  });

  it("binds authentication to one socket and completes founder resume through an authoritative snapshot", async () => {
    const result = await page.evaluate(async (reducerModuleUrl) => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule, reducerModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import(reducerModuleUrl),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const toBase64Url = (bytes: Uint8Array) => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
      };
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const deviceId = stateModule.randomSecureRoomIdV4(16);
      const setupAdmissionId = stateModule.randomSecureRoomIdV4(16);
      const roomSecret = `pf2_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
      const signaturePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      const state = reducerModule.createSecureRoomStateV4(roomInstance, [{
        deviceId,
        displayName: "Founder",
        signaturePublicKey,
      }], deviceId);
      state.membershipAdmissionBindings = [{ deviceId, admissionId: setupAdmissionId }];
      let pendingOutbox: any[] = [{
        kind: "admission",
        messageId: setupAdmissionId,
        admissionId: setupAdmissionId,
        welcomeMessageId: null,
        commitAcknowledged: false,
        outbound: new Uint8Array([1]),
      }];
      const fakeEngine = {
        roomInstance,
        deviceId,
        state,
        get pendingOutbox() { return pendingOutbox; },
        pendingRelayControls: [] as unknown[],
        pendingAdmissionBarrier: null,
        isProvisional: false,
        isAuthenticationAmbiguous: false,
        isActive: () => true,
        roster: () => [{ leafIndex: 0, deviceId, signaturePublicKey }],
        acknowledgeOutbound: async (messageId: string) => {
          const entry = pendingOutbox.find((candidate) => candidate.messageId === messageId);
          if (entry) entry.commitAcknowledged = true;
        },
        completeJoinAdmission: async (admissionId: string) => {
          pendingOutbox = pendingOutbox.filter((entry) => entry.admissionId !== admissionId);
        },
        markAuthenticated: async () => {},
        markAuthenticationAttempted: async () => {},
        dispose: () => {},
      };
      const controller = new SecureRoomController();
      const harness = controller as any;
      const generation = 17;
      const socketEpoch = 23;
      const socket = { readyState: WebSocket.OPEN };
      const authModes: string[] = [];
      const authenticationFrames: unknown[] = [];
      const sentFrames: any[] = [];
      const settlements: unknown[] = [];
      let durableRetries = 0;
      harness.generation = generation;
      harness.socketEpoch = socketEpoch;
      harness.socket = socket;
      harness.engine = fakeEngine;
      harness.lease = { isActive: () => true };
      harness.stopped = false;
      harness.terminal = false;
      harness.authenticated = false;
      harness.config = {
        initialMode: "setup",
        roomId: "abcdefghij",
        roomSecret,
        roomSecretResolvedFor: roomInstance,
        displayName: "Founder",
        fortPassSessionId: "session-1",
        fortPassClaimSecret: "f".repeat(64),
        // Deliberately differs: an existing founder must restore the
        // server-challenged room rather than attempt a second setup identity.
        setupRoomInstance: stateModule.randomSecureRoomIdV4(16),
      };
      harness.createAuthenticateFrame = async (_challenge: unknown, mode: string) => {
        authModes.push(mode);
        return { test: true };
      };
      harness.sendAuthentication = (frame: unknown) => authenticationFrames.push(frame);
      harness.sendClientFrame = (frame: unknown) => sentFrames.push(frame);
      harness.initializeUi = () => {};
      harness.runAutomations = async () => {};
      harness.retryDurableWork = async () => { durableRetries += 1; };
      harness.maybeSchedulePostCompromiseUpdate = () => {};
      const handshake = { generation, settle: (value: unknown) => settlements.push(value) };
      const challenge = {
        kind: "secure-auth-challenge", v: 4, suite: 1,
        connectionId: stateModule.randomSecureRoomIdV4(16),
        challenge: stateModule.randomSecureRoomIdV4(32),
        roomInstance,
      };
      await harness.handleWire(
        socket, generation, socketEpoch, JSON.stringify(challenge), handshake, {},
      );
      const challengeProducedResume = authModes.join(",") === "resume" &&
        authenticationFrames.length === 1 && harness.authenticatedMode === "resume";
      await harness.handleWire(socket, generation, socketEpoch, JSON.stringify({
        kind: "secure-server", v: 4, suite: 1, type: "authenticated",
        mode: "resume", roomInstance, deviceId, status: "pending",
      }), handshake, {});
      const preAuthResponseAccepted = harness.authenticated && harness.replayingBacklog &&
        pendingOutbox.length === 0 &&
        (settlements[0] as { status?: string } | undefined)?.status === "connected";
      const fortPassClaimClearedAfterResume = harness.config.fortPassClaimSecret === undefined;
      await harness.handleWire(socket, generation, socketEpoch, JSON.stringify({
        kind: "secure-server", v: 4, suite: 1, type: "room-state-snapshot",
        hostDeviceId: deviceId,
        members: [{ deviceId, status: "active" }],
        pendingHostTransfer: null,
      }), handshake, {});
      const backlogCursor = stateModule.randomSecureRoomIdV4(16);
      await harness.handleWire(socket, generation, socketEpoch, JSON.stringify({
        kind: "secure-server", v: 4, suite: 1, type: "backlog-end", lastMessageId: backlogCursor,
      }), handshake, {});
      const resumeComplete = sentFrames.find((frame) => frame.kind === "resume-complete");
      const snapshotPrecedesResumeComplete = harness.roomStateSnapshotReceived &&
        resumeComplete?.lastMessageId === backlogCursor && harness.replayingBacklog;
      await harness.handleWire(socket, generation, socketEpoch, JSON.stringify({
        kind: "secure-server", v: 4, suite: 1, type: "frame-accepted",
        messageId: resumeComplete.requestId,
      }), handshake, {});
      const resumeActivatedOnlyAfterAck = !harness.replayingBacklog && durableRetries === 1;

      const restoredPendingOutbox = [{
        kind: "admission",
        messageId: setupAdmissionId,
        admissionId: setupAdmissionId,
        welcomeMessageId: null,
        commitAcknowledged: false,
        outbound: new Uint8Array([1]),
      }];
      const restoredFakeEngine = {
        ...fakeEngine,
        get pendingOutbox() { return restoredPendingOutbox; },
      };
      const restoreController = new SecureRoomController();
      const restoreHarness = restoreController as any;
      const restoredModes: string[] = [];
      restoreHarness.lease = { isActive: () => true };
      restoreHarness.config = {
        initialMode: "setup", roomId: "abcdefghij", roomSecret,
        displayName: "Founder", setupRoomInstance: stateModule.randomSecureRoomIdV4(16),
      };
      restoreHarness.createAuthenticateFrame = async (_challenge: unknown, mode: string) => {
        restoredModes.push(mode);
        return { test: true };
      };
      restoreHarness.sendAuthentication = () => {};
      const originalRestore = (engineModule.SecureRoomEngine as any).restore;
      try {
        (engineModule.SecureRoomEngine as any).restore = async () => restoredFakeEngine;
        await restoreHarness.handleChallenge(challenge, undefined, {});
      } finally {
        (engineModule.SecureRoomEngine as any).restore = originalRestore;
      }
      const crashRestoredActiveAdmissionResumes = restoredModes.join(",") === "resume";
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");

      const snapshotBypassController = new SecureRoomController();
      const snapshotBypass = snapshotBypassController as any;
      const bypassSocket = { readyState: WebSocket.OPEN };
      const bypassCloses: string[] = [];
      snapshotBypass.generation = 5;
      snapshotBypass.socketEpoch = 6;
      snapshotBypass.socket = bypassSocket;
      snapshotBypass.engine = fakeEngine;
      snapshotBypass.stopped = false;
      snapshotBypass.authenticated = false;
      snapshotBypass.challengeHandled = true;
      snapshotBypass.authenticatedMode = "resume";
      snapshotBypass.protocolClose = (reason: string) => bypassCloses.push(reason);
      await snapshotBypass.handleWire(bypassSocket, 5, 6, JSON.stringify({
        kind: "secure-server", v: 4, suite: 1, type: "authenticated",
        mode: "resume", roomInstance, deviceId, status: "active",
      }), undefined, {});
      const resumeCannotBypassSnapshotPhase = bypassCloses[0] === "authentication result mismatch";

      const unauthenticatedController = new SecureRoomController();
      const unauthenticated = unauthenticatedController as any;
      const unauthenticatedSocket = { readyState: WebSocket.OPEN };
      const preAuthCloses: string[] = [];
      unauthenticated.generation = 3;
      unauthenticated.socketEpoch = 4;
      unauthenticated.socket = unauthenticatedSocket;
      unauthenticated.stopped = false;
      unauthenticated.protocolClose = (reason: string) => preAuthCloses.push(reason);
      await unauthenticated.handleWire(unauthenticatedSocket, 3, 4, JSON.stringify({
        kind: "secure-server", v: 4, suite: 1, type: "member-lifecycle",
        deviceId, status: "active",
      }), undefined, {});
      const preAuthRelayRejected = preAuthCloses[0] === "invalid authentication frame";

      const staleController = new SecureRoomController();
      const stale = staleController as any;
      const socketA = { readyState: WebSocket.OPEN };
      const socketB = { readyState: WebSocket.OPEN };
      let releaseAuthentication!: () => void;
      let authenticationStarted!: () => void;
      const authenticationGate = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
      const authenticationEntered = new Promise<void>((resolve) => { authenticationStarted = resolve; });
      let staleAuthenticationSends = 0;
      stale.generation = 9;
      stale.socketEpoch = 10;
      stale.socket = socketA;
      stale.engine = fakeEngine;
      stale.lease = { isActive: () => true };
      stale.stopped = false;
      stale.config = {
        initialMode: "setup", roomId: "abcdefghij", roomSecret,
        displayName: "Founder", setupRoomInstance: roomInstance,
      };
      stale.createAuthenticateFrame = async () => {
        authenticationStarted();
        await authenticationGate;
        return { test: true };
      };
      stale.sendAuthentication = () => { staleAuthenticationSends += 1; };
      const staleWire = stale.handleWire(
        socketA, 9, 10, JSON.stringify(challenge), undefined, {},
      );
      await authenticationEntered;
      stale.socket = socketB;
      stale.socketEpoch = 11;
      releaseAuthentication();
      await staleWire;
      const staleSocketCouldNotAuthenticateReplacement = staleAuthenticationSends === 0;

      const generationController = new SecureRoomController();
      const generationHarness = generationController as any;
      generationHarness.generation = 30;
      generationHarness.stopped = false;
      generationHarness.terminal = false;
      generationHarness.config = {
        initialMode: "setup", roomId: "oldroomabc", roomSecret,
        displayName: "Old", setupRoomInstance: roomInstance,
      };
      generationHarness.engine = { dispose: () => {} };
      let releaseOldOperation!: () => void;
      let oldOperationStarted!: () => void;
      const oldGate = new Promise<void>((resolve) => { releaseOldOperation = resolve; });
      const oldStarted = new Promise<void>((resolve) => { oldOperationStarted = resolve; });
      generationHarness.enqueue(async () => {
        oldOperationStarted();
        await oldGate;
        generationHarness.outboundUi.set("obsolete", { state, effects: [] });
        generationHarness.intentKeys.add("obsolete");
        throw new Error("obsolete operation failure");
      }, 30);
      await oldStarted;
      let replacementOpenedCleanly = false;
      generationHarness.openSocket = (_generation: number, nextHandshake: any) => {
        replacementOpenedCleanly = generationHarness.outboundUi.size === 0 &&
          generationHarness.intentKeys.size === 0 && generationHarness.engine === null &&
          generationHarness.config.roomId === "newroomabc" && !generationHarness.terminal;
        nextHandshake.settle({
          status: "connected",
          roomInstance: generationHarness.config.setupRoomInstance,
        });
      };
      const supersededPromise = generationHarness.start("setup", {
        roomId: "midroomabc",
        roomSecret,
        displayName: "Middle",
      });
      const replacementPromise = generationHarness.start("setup", {
        roomId: "newroomabc",
        roomSecret,
        displayName: "New",
      });
      releaseOldOperation();
      const superseded = await supersededPromise;
      const replacement = await replacementPromise;
      await generationHarness.serialQueue;
      const obsoleteGenerationCouldNotPoisonReplacement = replacementOpenedCleanly &&
        superseded.status === "failed" && superseded.reason === "aborted" &&
        replacement.status === "connected" && !generationHarness.terminal;

      // Supersession must also settle a handshake whose challenge handler is
      // already executing and suspended inside lock acquisition. A stale
      // socket guard alone stops the old authentication send, but without an
      // explicitly owned handshake the caller's setup Promise remains pending.
      let releaseAcquire!: () => void;
      let acquireEntered!: () => void;
      const acquireGate = new Promise<void>((resolve) => { releaseAcquire = resolve; });
      const acquireStarted = new Promise<void>((resolve) => { acquireEntered = resolve; });
      let acquiredLeaseReleased = 0;
      const acquiredLease = {
        signal: new AbortController().signal,
        isActive: () => true,
        release: () => { acquiredLeaseReleased += 1; },
      };
      const inFlightController = new SecureRoomController({
        acquire: async () => {
          acquireEntered();
          await acquireGate;
          return { status: "acquired", lease: acquiredLease };
        },
        close: () => {},
      } as any);
      const inFlight = inFlightController as any;
      let firstOpenEntered!: () => void;
      const firstOpened = new Promise<void>((resolve) => { firstOpenEntered = resolve; });
      let firstOpen: { generation: number; handshake: any; lock: any } | null = null;
      let openCount = 0;
      inFlight.openSocket = (nextGeneration: number, nextHandshake: any, nextLock: any) => {
        openCount += 1;
        if (openCount === 1) {
          firstOpen = { generation: nextGeneration, handshake: nextHandshake, lock: nextLock };
          firstOpenEntered();
          return;
        }
        nextHandshake.settle({
          status: "connected",
          roomInstance: inFlight.config.setupRoomInstance,
        });
      };
      const executingStart = inFlight.start("setup", {
        roomId: "runningabc",
        roomSecret,
        displayName: "Running",
      });
      await firstOpened;
      const oldOpen = firstOpen!;
      inFlight.enqueue(async () => inFlight.handleChallenge(
        { ...challenge, roomInstance: null },
        oldOpen.handshake,
        oldOpen.lock,
        () => oldOpen.generation === inFlight.generation,
      ), oldOpen.generation);
      await acquireStarted;
      const afterExecutingStart = inFlight.start("setup", {
        roomId: "newroomabc",
        roomSecret,
        displayName: "New",
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const executingOutcome = await Promise.race([
        executingStart,
        new Promise<"timeout">((resolve) => { timeout = setTimeout(() => resolve("timeout"), 100); }),
      ]);
      if (timeout) clearTimeout(timeout);
      releaseAcquire();
      const afterExecutingOutcome = await afterExecutingStart;
      await inFlight.serialQueue;
      const executingHandshakeWasAborted = executingOutcome !== "timeout" &&
        executingOutcome.status === "failed" && executingOutcome.reason === "aborted" &&
        afterExecutingOutcome.status === "connected" && acquiredLeaseReleased === 1 &&
        inFlight.config.roomId === "newroomabc";

      return {
        challengeProducedResume,
        preAuthResponseAccepted,
        fortPassClaimClearedAfterResume,
        snapshotPrecedesResumeComplete,
        resumeActivatedOnlyAfterAck,
        crashRestoredActiveAdmissionResumes,
        resumeCannotBypassSnapshotPhase,
        preAuthRelayRejected,
        staleSocketCouldNotAuthenticateReplacement,
        obsoleteGenerationCouldNotPoisonReplacement,
        executingHandshakeWasAborted,
      };
    }, secureGameReducerModuleUrl);

    expect(result.challengeProducedResume).toBe(true);
    expect(result.preAuthResponseAccepted).toBe(true);
    expect(result.fortPassClaimClearedAfterResume).toBe(true);
    expect(result.snapshotPrecedesResumeComplete).toBe(true);
    expect(result.resumeActivatedOnlyAfterAck).toBe(true);
    expect(result.crashRestoredActiveAdmissionResumes).toBe(true);
    expect(result.resumeCannotBypassSnapshotPhase).toBe(true);
    expect(result.preAuthRelayRejected).toBe(true);
    expect(result.staleSocketCouldNotAuthenticateReplacement).toBe(true);
    expect(result.obsoleteGenerationCouldNotPoisonReplacement).toBe(true);
    expect(result.executingHandshakeWasAborted).toBe(true);
  });

  it("retires only fresh identities when pre-authentication is rejected", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const roomSecret = `pf2_${"A".repeat(43)}`;
      const challenge = {
        kind: "secure-auth-challenge", v: 4, suite: 1,
        connectionId: stateModule.randomSecureRoomIdV4(16),
        challenge: stateModule.randomSecureRoomIdV4(32),
        roomInstance,
      };
      const rejection = {
        kind: "secure-server", v: 4, suite: 1, type: "error", code: "rate-limited",
      };

      const exercise = async (
        source: "restored-active" | "restored-pending" | "fresh",
        errorCode: "rate-limited" | "internal-error" = "rate-limited",
      ) => {
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
        const deviceId = stateModule.randomSecureRoomIdV4(16);
        let retireCalls = 0;
        let provisional = source === "fresh";
        let authenticationAmbiguous = source === "restored-pending";
        const fakeEngine = {
          roomInstance,
          deviceId,
          state: {
            members: source === "restored-active" ? [{ deviceId }] : [],
          },
          pendingOutbox: [],
          get isProvisional() { return provisional; },
          get isAuthenticationAmbiguous() { return authenticationAmbiguous; },
          isActive: () => source === "restored-active",
          markAuthenticationAttempted: async () => {
            if (provisional) {
              provisional = false;
              authenticationAmbiguous = true;
            }
          },
          retire: async () => { retireCalls += 1; },
          dispose: () => {},
        };
        const controller = new SecureRoomController();
        const harness = controller as any;
        const stops: Array<{ reason: string; preserveRecovery: boolean }> = [];
        let retries = 0;
        harness.lease = { isActive: () => true, release: () => {} };
        harness.config = {
          initialMode: "join",
          recoveryOnly: false,
          roomId: "abcdefghij",
          roomSecret,
          roomSecretResolvedFor: roomInstance,
          displayName: "Guest",
          roomInstance: null,
          setupRoomInstance: null,
        };
        harness.createAuthenticateFrame = async () => ({ test: true });
        harness.sendAuthentication = () => {};
        harness.stopPendingConnection = (_handshake: unknown, result: { reason: string }, preserveRecovery: boolean) => {
          stops.push({ reason: result.reason, preserveRecovery });
        };
        harness.retryPendingAuthentication = () => {
          retries += 1;
          return true;
        };

        const originalRestore = (engineModule.SecureRoomEngine as any).restore;
        const originalCreateJoiner = (engineModule.SecureRoomEngine as any).createJoiner;
        try {
          if (source === "fresh") {
            (engineModule.SecureRoomEngine as any).restore = async () => {
              throw new engineModule.SecureRoomEngineError("state-not-found", "missing");
            };
            (engineModule.SecureRoomEngine as any).createJoiner = async () => fakeEngine;
          } else {
            (engineModule.SecureRoomEngine as any).restore = async () => fakeEngine;
          }
          await harness.handleChallenge(challenge, undefined, {});
          const discardBeforeError = harness.discardEngineOnAuthenticationFailure;
          await harness.handleServerError({ ...rejection, code: errorCode }, undefined);
          return { discardBeforeError, retireCalls, stops, retries };
        } finally {
          (engineModule.SecureRoomEngine as any).restore = originalRestore;
          (engineModule.SecureRoomEngine as any).createJoiner = originalCreateJoiner;
        }
      };

      const outcomes = {
        restoredActive: await exercise("restored-active"),
        restoredPending: await exercise("restored-pending"),
        fresh: await exercise("fresh"),
        freshAmbiguous: await exercise("fresh", "internal-error"),
      };
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      return outcomes;
    });

    expect(result.restoredActive).toEqual({
      discardBeforeError: false,
      retireCalls: 0,
      stops: [{ reason: "rate-limited", preserveRecovery: false }],
      retries: 0,
    });
    expect(result.restoredPending).toEqual({
      discardBeforeError: false,
      retireCalls: 0,
      stops: [{ reason: "recovery-required", preserveRecovery: true }],
      retries: 0,
    });
    expect(result.fresh).toEqual({
      discardBeforeError: true,
      retireCalls: 1,
      stops: [{ reason: "rate-limited", preserveRecovery: false }],
      retries: 0,
    });
    expect(result.freshAmbiguous).toEqual({
      discardBeforeError: true,
      retireCalls: 0,
      stops: [],
      retries: 1,
    });
  });

  it("erases only pre-send cancellation and preserves an exact reload recovery pointer", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const makeHarness = (ambiguous: boolean) => {
        let retireCalls = 0;
        const controller = new SecureRoomController();
        const harness = controller as any;
        harness.engine = {
          isProvisional: !ambiguous,
          isAuthenticationAmbiguous: ambiguous,
          retire: async () => { retireCalls += 1; },
          dispose: () => {},
        };
        harness.config = {
          initialMode: "setup",
          roomId: "abcdefghij",
          roomSecret: `pf2_${"A".repeat(43)}`,
          roomSecretResolvedFor: roomInstance,
          displayName: "Founder",
          roomInstance,
          setupRoomInstance: roomInstance,
        };
        harness.lease = { release: () => {}, isActive: () => true };
        harness.stopped = false;
        harness.authenticationMayHaveCommitted = ambiguous;
        harness.unresolvedAuthentication = ambiguous;
        return { controller, harness, retireCalls: () => retireCalls };
      };

      const preSend = makeHarness(false);
      const preSendCanLeave = await preSend.controller.cancelPendingConnection();
      const preSendRecovery = preSend.controller.pendingRecovery;

      const postSend = makeHarness(true);
      const postSendCanLeave = await postSend.controller.cancelPendingConnection();
      const postSendRecovery = postSend.controller.pendingRecovery;
      const secondCancelCanLeave = await postSend.controller.cancelPendingConnection();
      const reloaded = new SecureRoomController();
      const reloadRecovery = reloaded.pendingRecovery;
      const mismatchedStart = await reloaded.setup({
        roomId: "different1",
        roomSecret: `pf2_${"A".repeat(43)}`,
        displayName: "Founder",
      });
      await reloaded.disconnect();

      return {
        preSendCanLeave,
        preSendRetired: preSend.retireCalls(),
        preSendRecovery,
        postSendCanLeave,
        postSendRetired: postSend.retireCalls(),
        postSendRecovery,
        secondCancelCanLeave,
        reloadRecovery,
        mismatchedStart,
      };
    });

    expect(result.preSendCanLeave).toBe(true);
    expect(result.preSendRetired).toBe(1);
    expect(result.preSendRecovery).toBeNull();
    expect(result.postSendCanLeave).toBe(false);
    expect(result.postSendRetired).toBe(0);
    expect(result.postSendRecovery).toEqual({
      mode: "setup", roomId: "abcdefghij", displayName: "Founder",
    });
    expect(result.secondCancelCanLeave).toBe(false);
    expect(result.reloadRecovery).toEqual(result.postSendRecovery);
    expect(result.mismatchedStart).toEqual({ status: "failed", reason: "recovery-required" });
  });

  it("preserves exact setup recovery and blocks replacement when provisional retirement fails", async () => {
    const result = await page.evaluate(async () => {
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const roomId = "abcdefghij";
      const displayName = "Failed Cleanup Founder";
      const roomSecret = `pf2_${"A".repeat(43)}`;

      const exercise = async (replace: boolean) => {
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
        const roomInstance = stateModule.randomSecureRoomIdV4(16);
        const events: string[] = [];
        const controller = new SecureRoomController();
        const harness = controller as any;
        harness.config = {
          initialMode: "setup",
          recoveryOnly: false,
          roomId,
          roomSecret,
          roomSecretResolvedFor: roomInstance,
          displayName,
          roomInstance,
          setupRoomInstance: roomInstance,
        };
        harness.engine = {
          isProvisional: true,
          isAuthenticationAmbiguous: false,
          retire: async () => {
            events.push("retire");
            throw new engineModule.SecureRoomEngineError(
              "persistence-failed",
              "test retirement failure",
            );
          },
          dispose: () => { events.push("dispose"); },
        };
        harness.lease = {
          isActive: () => true,
          release: () => { events.push("release"); },
        };
        harness.stopped = false;
        let openSocketCalls = 0;
        harness.openSocket = () => { openSocketCalls += 1; };

        const outcome = replace
          ? await controller.setup({
              roomId: "different1",
              roomSecret,
              displayName: "Replacement Founder",
            })
          : await controller.cancelPendingConnection();
        const raw = sessionStorage.getItem("pillowfort:secure-room-recovery:v1");
        const persisted = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        return {
          roomInstance,
          outcome,
          recovery: controller.pendingRecovery,
          persistedRoomInstance: persisted?.roomInstance ?? null,
          events,
          openSocketCalls,
        };
      };

      try {
        return {
          direct: await exercise(false),
          replacement: await exercise(true),
        };
      } finally {
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result.direct.outcome).toBe(false);
    expect(result.replacement.outcome).toEqual({ status: "failed", reason: "recovery-required" });
    for (const outcome of [result.direct, result.replacement]) {
      expect(outcome.recovery).toEqual({
        mode: "setup",
        roomId: "abcdefghij",
        displayName: "Failed Cleanup Founder",
      });
      expect(outcome.persistedRoomInstance).toBe(outcome.roomInstance);
      expect(outcome.events).toEqual(["retire", "dispose", "release"]);
      expect(outcome.openSocketCalls).toBe(0);
    }
  });

  it("keeps ambiguous authentication recovery across an explicit disconnect", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const events: string[] = [];
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.config = {
        initialMode: "join",
        recoveryOnly: false,
        roomId: "abcdefghij",
        roomSecret: `pf2_${"A".repeat(43)}`,
        roomSecretResolvedFor: roomInstance,
        displayName: "Ambiguous Guest",
        roomInstance,
        setupRoomInstance: null,
      };
      harness.engine = {
        isProvisional: false,
        isAuthenticationAmbiguous: true,
        retire: async () => { events.push("retire"); },
        dispose: () => { events.push("dispose"); },
      };
      harness.lease = {
        isActive: () => true,
        release: () => { events.push("release"); },
      };
      harness.stopped = false;
      harness.authenticationMayHaveCommitted = true;
      harness.unresolvedAuthentication = true;
      harness.rememberRecoveryContext();
      try {
        await controller.disconnect();
        const raw = sessionStorage.getItem("pillowfort:secure-room-recovery:v1");
        const persisted = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        return {
          roomInstance,
          recovery: controller.pendingRecovery,
          persistedRoomInstance: persisted?.roomInstance ?? null,
          events,
          stopped: harness.stopped,
          engineCleared: harness.engine === null,
          leaseCleared: harness.lease === null,
        };
      } finally {
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result.recovery).toEqual({
      mode: "join", roomId: "abcdefghij", displayName: "Ambiguous Guest",
    });
    expect(result.persistedRoomInstance).toBe(result.roomInstance);
    expect(result.events).toEqual(["dispose", "release"]);
    expect(result.stopped).toBe(true);
    expect(result.engineCleared).toBe(true);
    expect(result.leaseCleared).toBe(true);
  });

  it("preserves recovery when terminal or definitive rejection cleanup cannot retire local state", async () => {
    const result = await page.evaluate(async () => {
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);

      const exercise = async (kind: "terminal" | "pre-auth") => {
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
        const roomInstance = stateModule.randomSecureRoomIdV4(16);
        const events: string[] = [];
        const settlements: unknown[] = [];
        const controller = new SecureRoomController();
        const harness = controller as any;
        harness.config = {
          initialMode: "join",
          recoveryOnly: true,
          roomId: "abcdefghij",
          roomSecret: `pf2_${"A".repeat(43)}`,
          roomSecretResolvedFor: roomInstance,
          displayName: "Cleanup Guest",
          roomInstance,
          setupRoomInstance: null,
        };
        harness.engine = {
          roomInstance,
          pendingOutbox: [],
          isProvisional: false,
          isAuthenticationAmbiguous: true,
          isActive: () => false,
          retire: async () => {
            events.push("retire");
            throw new engineModule.SecureRoomEngineError(
              "persistence-failed",
              "test terminal retirement failure",
            );
          },
          dispose: () => { events.push("dispose"); },
        };
        harness.lease = {
          isActive: () => true,
          release: () => { events.push("release"); },
        };
        harness.stopped = false;
        harness.terminal = false;
        harness.unresolvedAuthentication = true;
        harness.rememberRecoveryContext();
        if (kind === "terminal") {
          harness.authenticated = true;
          await harness.finishTerminal("This secure fort is no longer available.");
        } else {
          harness.authenticated = false;
          harness.authenticatedMode = "join";
          const handshake = {
            generation: 0,
            settle: (value: unknown) => settlements.push(value),
          };
          harness.pendingHandshake = handshake;
          await harness.handleServerError({
            kind: "secure-server", v: 4, suite: 1, type: "error", code: "room-retired",
          }, handshake);
        }
        const raw = sessionStorage.getItem("pillowfort:secure-room-recovery:v1");
        const persisted = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        return {
          roomInstance,
          settlement: settlements[0] ?? null,
          recovery: controller.pendingRecovery,
          persistedRoomInstance: persisted?.roomInstance ?? null,
          events,
          stopped: harness.stopped,
          terminal: harness.terminal,
          engineCleared: harness.engine === null,
          leaseCleared: harness.lease === null,
        };
      };

      try {
        return {
          terminal: await exercise("terminal"),
          preAuth: await exercise("pre-auth"),
        };
      } finally {
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result.terminal.settlement).toBeNull();
    expect(result.preAuth.settlement).toEqual({ status: "failed", reason: "recovery-required" });
    for (const outcome of [result.terminal, result.preAuth]) {
      expect(outcome.recovery).toEqual({
        mode: "join", roomId: "abcdefghij", displayName: "Cleanup Guest",
      });
      expect(outcome.persistedRoomInstance).toBe(outcome.roomInstance);
      expect(outcome.events).toEqual(["retire", "dispose", "release"]);
      expect(outcome.stopped).toBe(true);
      expect(outcome.terminal).toBe(false);
      expect(outcome.engineCleared).toBe(true);
      expect(outcome.leaseCleared).toBe(true);
    }
  });

  it("makes ambiguous authentication recovery restore-only across reload and lifecycle failure", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const roomId = "abcdefghij";
      const displayName = "Recovery User";
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const roomSecret = `pf2_${"A".repeat(43)}`;
      const deviceId = stateModule.randomSecureRoomIdV4(16);
      const admissionId = stateModule.randomSecureRoomIdV4(16);
      const challenge = (instance: string | null) => ({
        kind: "secure-auth-challenge", v: 4, suite: 1,
        connectionId: stateModule.randomSecureRoomIdV4(16),
        challenge: stateModule.randomSecureRoomIdV4(32),
        roomInstance: instance,
      });
      const lease = () => ({
        isActive: () => true,
        release: () => {},
      });
      const config = (mode: "setup" | "join") => ({
        initialMode: mode,
        recoveryOnly: true,
        roomId,
        roomSecret,
        roomSecretResolvedFor: roomInstance,
        displayName,
        roomInstance,
        setupRoomInstance: mode === "setup" ? roomInstance : null,
      });
      const ambiguousEngine = (activeFounder: boolean) => ({
        roomInstance,
        deviceId,
        state: {
          hostDeviceId: activeFounder ? deviceId : null,
          members: activeFounder ? [{ deviceId }] : [],
        },
        pendingOutbox: [{
          kind: "admission",
          messageId: admissionId,
          admissionId,
          welcomeMessageId: null,
          commitAcknowledged: false,
          outbound: new Uint8Array([1]),
        }],
        isProvisional: false,
        isAuthenticationAmbiguous: true,
        isActive: () => activeFounder,
        markAuthenticationAttempted: async () => {},
        retire: async () => {},
        dispose: () => {},
      });
      const seedRecovery = (controller: InstanceType<typeof SecureRoomController>, mode: "setup" | "join") => {
        const harness = controller as any;
        harness.config = config(mode);
        harness.engine = ambiguousEngine(mode === "setup");
        harness.unresolvedAuthentication = true;
        harness.rememberRecoveryContext();
        harness.engine = null;
        harness.lease = lease();
        harness.stopped = false;
        return harness;
      };

      const originalRestore = (engineModule.SecureRoomEngine as any).restore;
      const originalCreateFounder = (engineModule.SecureRoomEngine as any).createFounder;
      const originalCreateJoiner = (engineModule.SecureRoomEngine as any).createJoiner;
      let createFounderCalls = 0;
      let createJoinerCalls = 0;
      let restoreCalls = 0;
      try {
        (engineModule.SecureRoomEngine as any).createFounder = async () => {
          createFounderCalls += 1;
          throw new Error("recovery created a replacement founder");
        };
        (engineModule.SecureRoomEngine as any).createJoiner = async () => {
          createJoinerCalls += 1;
          throw new Error("recovery created a replacement joiner");
        };

        const setupController = new SecureRoomController();
        const setup = seedRecovery(setupController, "setup");
        const setupModes: string[] = [];
        let setupSends = 0;
        (engineModule.SecureRoomEngine as any).restore = async () => {
          restoreCalls += 1;
          return ambiguousEngine(true);
        };
        setup.createAuthenticateFrame = async (_challenge: unknown, mode: string) => {
          setupModes.push(mode);
          return { test: true };
        };
        setup.sendAuthentication = () => { setupSends += 1; };
        await setup.handleChallenge(challenge(null), undefined, {});
        const setupRestored = setupModes.join(",") === "setup" && setupSends === 1 &&
          setup.engine?.isAuthenticationAmbiguous === true;

        const wrongSetupController = new SecureRoomController();
        const wrongSetup = seedRecovery(wrongSetupController, "setup");
        const wrongSetupSettlements: unknown[] = [];
        (engineModule.SecureRoomEngine as any).restore = async () => {
          restoreCalls += 1;
          throw new engineModule.SecureRoomEngineError("state-not-found", "wrong recovery credential");
        };
        await wrongSetup.handleChallenge(challenge(null), {
          generation: 0,
          settle: (value: unknown) => wrongSetupSettlements.push(value),
        }, {});
        const wrongSetupPreserved = wrongSetupController.pendingRecovery?.mode === "setup" &&
          (wrongSetupSettlements[0] as { reason?: string } | undefined)?.reason ===
            "recovery-credential-mismatch";

        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
        const joinController = new SecureRoomController();
        const join = seedRecovery(joinController, "join");
        const joinSettlements: unknown[] = [];
        let joinRestoreAttempt = 0;
        let joinRetireCalls = 0;
        const restoredJoin = {
          ...ambiguousEngine(false),
          retire: async () => { joinRetireCalls += 1; },
        };
        (engineModule.SecureRoomEngine as any).restore = async () => {
          restoreCalls += 1;
          joinRestoreAttempt += 1;
          if (joinRestoreAttempt === 1) {
            throw new engineModule.SecureRoomEngineError("state-not-found", "wrong recovery credential");
          }
          return restoredJoin;
        };
        join.createAuthenticateFrame = async (_challenge: unknown, mode: string) => {
          joinModes.push(mode);
          return { test: true };
        };
        join.sendAuthentication = () => { joinSends += 1; };
        const joinModes: string[] = [];
        let joinSends = 0;
        await join.handleChallenge(challenge(roomInstance), {
          generation: 0,
          settle: (value: unknown) => joinSettlements.push(value),
        }, {});
        const wrongJoinPreserved = joinController.pendingRecovery?.mode === "join" &&
          (joinSettlements[0] as { reason?: string } | undefined)?.reason ===
            "recovery-credential-mismatch" &&
          joinRetireCalls === 0;

        join.config = config("join");
        join.lease = lease();
        join.stopped = false;
        await join.handleChallenge(challenge(roomInstance), {
          generation: 1,
          settle: (value: unknown) => joinSettlements.push(value),
        }, {});
        const correctJoinRestored = joinModes.join(",") === "join" && joinSends === 1 &&
          join.engine === restoredJoin;

        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
        const lifecycleController = new SecureRoomController();
        const lifecycle = lifecycleController as any;
        let lifecycleRetireCalls = 0;
        lifecycle.generation = 7;
        lifecycle.config = config("join");
        lifecycle.engine = {
          roomInstance,
          deviceId,
          state: { members: [{ deviceId }] },
          isProvisional: false,
          isAuthenticationAmbiguous: true,
          roster: () => [{ deviceId }],
          completeAdmissionLifecycle: async () => {
            throw new engineModule.SecureRoomEngineError("persistence-failed", "lifecycle persistence failed");
          },
          retire: async () => { lifecycleRetireCalls += 1; },
          dispose: () => {},
        };
        lifecycle.lease = lease();
        lifecycle.stopped = false;
        lifecycle.authenticated = true;
        lifecycle.unresolvedAuthentication = true;
        lifecycle.rememberRecoveryContext();
        lifecycle.enqueue(
          () => lifecycle.handleMemberLifecycle(deviceId, "active"),
          lifecycle.generation,
        );
        await lifecycle.serialQueue;
        const lifecycleFailurePreserved = lifecycleController.pendingRecovery?.mode === "join" &&
          lifecycleRetireCalls === 0 && lifecycle.stopped === true && lifecycle.terminal === false;

        return {
          setupRestored,
          wrongSetupPreserved,
          wrongJoinPreserved,
          correctJoinRestored,
          lifecycleFailurePreserved,
          createFounderCalls,
          createJoinerCalls,
          restoreCalls,
          joinRetireCalls,
        };
      } finally {
        (engineModule.SecureRoomEngine as any).restore = originalRestore;
        (engineModule.SecureRoomEngine as any).createFounder = originalCreateFounder;
        (engineModule.SecureRoomEngine as any).createJoiner = originalCreateJoiner;
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result).toEqual({
      setupRestored: true,
      wrongSetupPreserved: true,
      wrongJoinPreserved: true,
      correctJoinRestored: true,
      lifecycleFailurePreserved: true,
      createFounderCalls: 0,
      createJoinerCalls: 0,
      restoreCalls: 4,
      joinRetireCalls: 0,
    });
  });

  it("terminally clears established setup recovery when the relay room is missing", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const roomId = "abcdefghij";
      const displayName = "Established Founder";
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const roomSecret = `pf2_${"A".repeat(43)}`;
      const deviceId = stateModule.randomSecureRoomIdV4(16);
      let retireCalls = 0;
      let disposeCalls = 0;
      let createFounderCalls = 0;
      let createAuthenticateCalls = 0;
      let sendAuthenticationCalls = 0;
      const establishedFounder = {
        roomInstance,
        deviceId,
        state: { hostDeviceId: deviceId, members: [{ deviceId }] },
        pendingOutbox: [],
        isProvisional: false,
        isAuthenticationAmbiguous: false,
        isActive: () => true,
        retire: async () => { retireCalls += 1; },
        dispose: () => { disposeCalls += 1; },
      };
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.config = {
        initialMode: "setup",
        recoveryOnly: true,
        roomId,
        roomSecret,
        roomSecretResolvedFor: roomInstance,
        displayName,
        roomInstance,
        setupRoomInstance: roomInstance,
      };
      harness.engine = establishedFounder;
      harness.unresolvedAuthentication = true;
      harness.rememberRecoveryContext();
      harness.engine = null;
      harness.lease = { isActive: () => true, release: () => {} };
      harness.stopped = false;
      harness.terminal = false;
      const settlements: unknown[] = [];
      const originalRestore = (engineModule.SecureRoomEngine as any).restore;
      const originalCreateFounder = (engineModule.SecureRoomEngine as any).createFounder;
      try {
        (engineModule.SecureRoomEngine as any).restore = async () => establishedFounder;
        (engineModule.SecureRoomEngine as any).createFounder = async () => {
          createFounderCalls += 1;
          throw new Error("missing-room recovery minted a replacement founder");
        };
        harness.createAuthenticateFrame = async () => {
          createAuthenticateCalls += 1;
          throw new Error("missing-room recovery constructed authentication");
        };
        harness.sendAuthentication = () => { sendAuthenticationCalls += 1; };
        await harness.handleChallenge({
          kind: "secure-auth-challenge", v: 4, suite: 1,
          connectionId: stateModule.randomSecureRoomIdV4(16),
          challenge: stateModule.randomSecureRoomIdV4(32),
          roomInstance: null,
        }, {
          generation: 0,
          settle: (value: unknown) => settlements.push(value),
        }, {});
        return {
          settlement: settlements[0] ?? null,
          pendingRecovery: controller.pendingRecovery,
          persistedRecovery: sessionStorage.getItem("pillowfort:secure-room-recovery:v1"),
          retireCalls,
          disposeCalls,
          createFounderCalls,
          createAuthenticateCalls,
          sendAuthenticationCalls,
          engineCleared: harness.engine === null,
        };
      } finally {
        (engineModule.SecureRoomEngine as any).restore = originalRestore;
        (engineModule.SecureRoomEngine as any).createFounder = originalCreateFounder;
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result).toEqual({
      settlement: { status: "failed", reason: "authentication-failed" },
      pendingRecovery: null,
      persistedRecovery: null,
      retireCalls: 1,
      disposeCalls: 1,
      createFounderCalls: 0,
      createAuthenticateCalls: 0,
      sendAuthenticationCalls: 0,
      engineCleared: true,
    });
  });

  it("settles a recovered handshake when local authentication construction throws", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const deviceId = stateModule.randomSecureRoomIdV4(16);
      const admissionId = stateModule.randomSecureRoomIdV4(16);
      let disposed = 0;
      let retired = 0;
      const restored = {
        roomInstance,
        deviceId,
        state: { hostDeviceId: deviceId, members: [{ deviceId }] },
        pendingOutbox: [{
          kind: "admission",
          messageId: admissionId,
          admissionId,
          welcomeMessageId: null,
          commitAcknowledged: false,
          outbound: new Uint8Array([1]),
        }],
        isProvisional: false,
        isAuthenticationAmbiguous: true,
        isActive: () => true,
        markAuthenticationAttempted: async () => {},
        retire: async () => { retired += 1; },
        dispose: () => { disposed += 1; },
      };
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.generation = 19;
      harness.config = {
        initialMode: "setup",
        recoveryOnly: true,
        roomId: "abcdefghij",
        roomSecret: `pf2_${"A".repeat(43)}`,
        roomSecretResolvedFor: roomInstance,
        displayName: "Recovery User",
        roomInstance,
        setupRoomInstance: roomInstance,
      };
      harness.engine = restored;
      harness.unresolvedAuthentication = true;
      harness.rememberRecoveryContext();
      harness.engine = null;
      harness.lease = { isActive: () => true, release: () => {} };
      harness.stopped = false;
      harness.terminal = false;
      const settlements: unknown[] = [];
      const handshake = {
        generation: harness.generation,
        settle: (value: unknown) => settlements.push(value),
      };
      harness.pendingHandshake = handshake;
      harness.createAuthenticateFrame = async () => {
        throw new Error("local authentication construction failed");
      };
      const originalRestore = (engineModule.SecureRoomEngine as any).restore;
      try {
        (engineModule.SecureRoomEngine as any).restore = async () => restored;
        harness.enqueue(() => harness.handleChallenge({
          kind: "secure-auth-challenge", v: 4, suite: 1,
          connectionId: stateModule.randomSecureRoomIdV4(16),
          challenge: stateModule.randomSecureRoomIdV4(32),
          roomInstance: null,
        }, handshake, {}), harness.generation);
        await harness.serialQueue;
        return {
          settlement: settlements[0] ?? null,
          recovery: controller.pendingRecovery,
          stopped: harness.stopped,
          terminal: harness.terminal,
          pendingHandshakeCleared: harness.pendingHandshake === null,
          retired,
          disposed,
        };
      } finally {
        (engineModule.SecureRoomEngine as any).restore = originalRestore;
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result.settlement).toEqual({ status: "failed", reason: "recovery-required" });
    expect(result.recovery).toEqual({
      mode: "setup", roomId: "abcdefghij", displayName: "Recovery User",
    });
    expect(result.stopped).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.pendingHandshakeCleared).toBe(true);
    expect(result.retired).toBe(0);
    expect(result.disposed).toBe(1);
  });

  it("retires a pre-send provisional identity before reconnect exhaustion releases its lease", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
      ]);
      const NativeWebSocket = window.WebSocket;
      const sockets: Array<{
        readyState: number;
        onmessage: ((event: { data: string }) => void) | null;
        onclose: (() => void) | null;
        onerror: (() => void) | null;
        close: () => void;
      }> = [];
      class FakeWebSocket {
        static readonly OPEN = 1;
        readyState = FakeWebSocket.OPEN;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(_url: string) { sockets.push(this); }
        close() { this.readyState = 3; }
      }
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: FakeWebSocket,
      });
      try {
        const roomInstance = stateModule.randomSecureRoomIdV4(16);
        const events: string[] = [];
        let provisionalPresent = true;
        const controller = new SecureRoomController();
        const harness = controller as any;
        const generation = 29;
        harness.generation = generation;
        harness.stopped = false;
        harness.terminal = false;
        harness.authenticated = false;
        harness.reconnectAttempts = 3;
        harness.config = {
          initialMode: "join",
          recoveryOnly: false,
          roomId: "abcdefghij",
          roomSecret: `pf2_${"A".repeat(43)}`,
          roomSecretResolvedFor: roomInstance,
          displayName: "Provisional User",
          roomInstance,
          setupRoomInstance: null,
        };
        harness.engine = {
          isProvisional: true,
          isAuthenticationAmbiguous: false,
          retire: async () => {
            events.push("retire");
            provisionalPresent = false;
          },
          dispose: () => { events.push("dispose"); },
        };
        harness.lease = {
          isActive: () => true,
          release: () => { events.push("release"); },
        };
        const settlements: unknown[] = [];
        const handshake = {
          generation,
          settle: (value: unknown) => settlements.push(value),
        };
        harness.pendingHandshake = handshake;
        harness.openSocket(generation, handshake);
        sockets[0]?.onclose?.();
        await harness.serialQueue;
        return {
          settlement: settlements[0] ?? null,
          provisionalPresent,
          events,
          pointerCleared: controller.pendingRecovery === null,
          engineCleared: harness.engine === null,
          leaseCleared: harness.lease === null,
        };
      } finally {
        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          writable: true,
          value: NativeWebSocket,
        });
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result.settlement).toEqual({ status: "failed", reason: "socket-failed" });
    expect(result.provisionalPresent).toBe(false);
    expect(result.events.indexOf("retire")).toBeGreaterThanOrEqual(0);
    expect(result.events.indexOf("retire")).toBeLessThan(result.events.indexOf("release"));
    expect(result.pointerCleared).toBe(true);
    expect(result.engineCleared).toBe(true);
    expect(result.leaseCleared).toBe(true);
  });

  it("binds recovered joins to their serialized room instance and terminally resolves replacement", async () => {
    const result = await page.evaluate(async () => {
      sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      const [{ SecureRoomController }, stateModule, engineModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import("/src/services/secureRoomEngine.ts"),
      ]);
      const roomId = "abcdefghij";
      const displayName = "Recovery User";
      const originalRoomInstance = stateModule.randomSecureRoomIdV4(16);
      const replacementRoomInstance = stateModule.randomSecureRoomIdV4(16);
      const roomSecret = `pf2_${"A".repeat(43)}`;
      const originalRestore = (engineModule.SecureRoomEngine as any).restore;
      const originalCreateJoiner = (engineModule.SecureRoomEngine as any).createJoiner;
      const restoreInstances: string[] = [];
      let createJoinerCalls = 0;
      let retireCalls = 0;

      const seed = () => {
        const controller = new SecureRoomController();
        const harness = controller as any;
        const engine = {
          roomInstance: originalRoomInstance,
          deviceId: stateModule.randomSecureRoomIdV4(16),
          state: { hostDeviceId: null, members: [] },
          pendingOutbox: [],
          isProvisional: false,
          isAuthenticationAmbiguous: true,
          isActive: () => false,
          retire: async () => { retireCalls += 1; },
          dispose: () => {},
        };
        harness.config = {
          initialMode: "join",
          recoveryOnly: true,
          roomId,
          roomSecret,
          roomSecretResolvedFor: originalRoomInstance,
          displayName,
          roomInstance: originalRoomInstance,
          setupRoomInstance: null,
        };
        harness.engine = engine;
        harness.unresolvedAuthentication = true;
        harness.rememberRecoveryContext();
        const raw = sessionStorage.getItem("pillowfort:secure-room-recovery:v1");
        const pointer = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        harness.engine = null;
        harness.lease = { isActive: () => true, release: () => {} };
        harness.stopped = false;
        harness.terminal = false;
        const settlements: unknown[] = [];
        return { controller, harness, engine, pointer, settlements };
      };

      try {
        (engineModule.SecureRoomEngine as any).restore = async (options: { roomInstance: string }) => {
          restoreInstances.push(options.roomInstance);
          const current = activeEngine;
          if (!current) throw new Error("missing test recovery engine");
          return current;
        };
        (engineModule.SecureRoomEngine as any).createJoiner = async () => {
          createJoinerCalls += 1;
          throw new Error("terminal recovery minted a replacement joiner");
        };

        let activeEngine: ReturnType<typeof seed>["engine"] | null = null;
        const missing = seed();
        activeEngine = missing.engine;
        const missingHandshake = {
          generation: 0,
          settle: (value: unknown) => missing.settlements.push(value),
        };
        await missing.harness.handleChallenge({
          kind: "secure-auth-challenge", v: 4, suite: 1,
          connectionId: stateModule.randomSecureRoomIdV4(16),
          challenge: stateModule.randomSecureRoomIdV4(32),
          roomInstance: null,
        }, missingHandshake, {});
        const missingResolved = missing.controller.pendingRecovery === null &&
          (missing.settlements[0] as { reason?: string } | undefined)?.reason !== "recovery-required";

        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
        const replaced = seed();
        activeEngine = replaced.engine;
        const replacedHandshake = {
          generation: 0,
          settle: (value: unknown) => replaced.settlements.push(value),
        };
        await replaced.harness.handleChallenge({
          kind: "secure-auth-challenge", v: 4, suite: 1,
          connectionId: stateModule.randomSecureRoomIdV4(16),
          challenge: stateModule.randomSecureRoomIdV4(32),
          roomInstance: replacementRoomInstance,
        }, replacedHandshake, {});
        const replacementResolved = replaced.controller.pendingRecovery === null &&
          (replaced.settlements[0] as { reason?: string } | undefined)?.reason !== "recovery-required";
        const pointerKeys = replaced.pointer ? Object.keys(replaced.pointer).sort().join(",") : "";

        return {
          originalRoomInstance,
          pointerRoomInstance: replaced.pointer?.roomInstance ?? null,
          pointerKeys,
          missingResolved,
          replacementResolved,
          restoreInstances,
          createJoinerCalls,
          retireCalls,
        };
      } finally {
        (engineModule.SecureRoomEngine as any).restore = originalRestore;
        (engineModule.SecureRoomEngine as any).createJoiner = originalCreateJoiner;
        sessionStorage.removeItem("pillowfort:secure-room-recovery:v1");
      }
    });

    expect(result.pointerRoomInstance).toBe(result.originalRoomInstance);
    expect(result.pointerKeys).toBe("displayName,mode,roomId,roomInstance,savedAt,v");
    expect(result.missingResolved).toBe(true);
    expect(result.replacementResolved).toBe(true);
    expect(result.restoreInstances).toEqual([
      result.pointerRoomInstance,
      result.pointerRoomInstance,
    ]);
    expect(result.createJoinerCalls).toBe(0);
    expect(result.retireCalls).toBe(2);
  });

  it("gates terminal relay errors before durable retirement can yield", async () => {
    const result = await page.evaluate(async () => {
      const [{ SecureRoomController }, stateModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
      ]);
      let releaseRetire!: () => void;
      let retireEntered!: () => void;
      const retireGate = new Promise<void>((resolve) => { releaseRetire = resolve; });
      const retireStarted = new Promise<void>((resolve) => { retireEntered = resolve; });
      let disposed = 0;
      let socketClosed = 0;
      let leaseReleased = 0;
      let mappedActions = 0;
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.engine = {
        deviceId: stateModule.randomSecureRoomIdV4(16),
        retire: async () => {
          retireEntered();
          await retireGate;
        },
        dispose: () => { disposed += 1; },
      };
      harness.lease = {
        isActive: () => true,
        release: () => { leaseReleased += 1; },
      };
      harness.socket = {
        readyState: WebSocket.OPEN,
        onclose: null,
        close: () => { socketClosed += 1; },
      };
      harness.config = {
        initialMode: "setup",
        roomId: "terminalab",
        roomSecret: "unused",
        displayName: "Terminal",
        setupRoomInstance: stateModule.randomSecureRoomIdV4(16),
      };
      harness.generation = 8;
      harness.stopped = false;
      harness.terminal = false;
      harness.authenticated = true;
      harness.mapUiAction = async () => { mappedActions += 1; };

      const handling = harness.handleServerFrame({
        kind: "secure-server", v: 4, suite: 1, type: "error", code: "room-retired",
      });
      await retireStarted;
      const actionAcceptedDuringRetire = controller.sendUiAction("chat", { text: "too late" });
      const gatedBeforeRetireCompleted = harness.terminal && harness.stopped &&
        !harness.authenticated && harness.socket === null && harness.config === null &&
        !actionAcceptedDuringRetire &&
        mappedActions === 0 && socketClosed === 1;
      const handlerState = await Promise.race([
        handling.then(() => "returned" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]);
      releaseRetire();
      await handling;
      return {
        gatedBeforeRetireCompleted,
        handlerWaitedForRetire: handlerState === "pending",
        cleanedAfterRetire: harness.engine === null && disposed === 1 && leaseReleased === 1,
      };
    });

    expect(result.gatedBeforeRetireCompleted).toBe(true);
    expect(result.handlerWaitedForRetire).toBe(true);
    expect(result.cleanedAfterRetire).toBe(true);
  });

  it("drains already-received secure frames before reconciling socket close", async () => {
    const result = await page.evaluate(async () => {
      const [{ SecureRoomController }, stateModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
      ]);
      const NativeWebSocket = window.WebSocket;
      const sockets: Array<{
        readyState: number;
        onmessage: ((event: { data: string }) => void) | null;
        onclose: (() => void) | null;
        onerror: (() => void) | null;
        close: () => void;
      }> = [];
      class FakeWebSocket {
        static readonly OPEN = 1;
        readyState = FakeWebSocket.OPEN;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(_url: string) { sockets.push(this); }
        close() {}
      }
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: FakeWebSocket,
      });
      try {
        const controller = new SecureRoomController();
        const harness = controller as any;
        const generation = 41;
        const roomInstance = stateModule.randomSecureRoomIdV4(16);
        let releaseMessage!: () => void;
        let messageEntered!: () => void;
        const messageGate = new Promise<void>((resolve) => { releaseMessage = resolve; });
        const messageStarted = new Promise<void>((resolve) => { messageEntered = resolve; });
        const order: string[] = [];
        let messageSawCurrentSocket = false;
        harness.generation = generation;
        harness.stopped = false;
        harness.terminal = false;
        harness.config = {
          initialMode: "setup",
          roomId: "closequeue",
          roomSecret: "unused",
          displayName: "Close queue",
          setupRoomInstance: roomInstance,
        };
        harness.lease = { isActive: () => true };
        harness.handleWire = async (socket: unknown, wireGeneration: number, socketEpoch: number) => {
          messageSawCurrentSocket = harness.isCurrentSocket(socket, wireGeneration, socketEpoch);
          order.push("message-start");
          messageEntered();
          await messageGate;
          order.push("message-end");
        };
        harness.scheduleReconnect = () => { order.push("reconnect"); };
        harness.openSocket(generation);
        const socket = sockets[0]!;
        const openedEpoch = harness.socketEpoch;
        socket.onmessage?.({ data: "{}" });
        socket.onclose?.();
        await messageStarted;
        const closeWaitedBehindMessage = harness.socket === socket &&
          harness.socketEpoch === openedEpoch && order.join(",") === "message-start";
        releaseMessage();
        await harness.serialQueue;
        return {
          messageSawCurrentSocket,
          closeWaitedBehindMessage,
          closeReconciledAfterMessage: harness.socket === null &&
            harness.socketEpoch === openedEpoch + 1 &&
            order.join(",") === "message-start,message-end,reconnect",
        };
      } finally {
        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          writable: true,
          value: NativeWebSocket,
        });
      }
    });

    expect(result.messageSawCurrentSocket).toBe(true);
    expect(result.closeWaitedBehindMessage).toBe(true);
    expect(result.closeReconciledAfterMessage).toBe(true);
  });

  it("shows an inbound self-removal as a knocked terminal state, not a voluntary leave", async () => {
    const result = await page.evaluate(async (reducerModuleUrl) => {
      const [{ SecureRoomController }, stateModule, reducerModule, storeModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import(reducerModuleUrl),
        import("/src/stores/gameStore.ts"),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const ownDeviceId = stateModule.randomSecureRoomIdV4(16);
      const applicationState = reducerModule.createSecureRoomStateV4(roomInstance, [{
        deviceId: ownDeviceId,
        signaturePublicKey: stateModule.randomSecureRoomIdV4(32),
        displayName: "Removed member",
      }], ownDeviceId);
      const controller = new SecureRoomController();
      const harness = controller as any;
      let disposed = 0;
      let leaseReleased = 0;
      harness.engine = {
        roomInstance,
        deviceId: ownDeviceId,
        state: applicationState,
        receive: async () => ({
          kind: "inbound-commit",
          retired: true,
          state: applicationState,
          effects: [],
        }),
        dispose: () => { disposed += 1; },
      };
      harness.lease = {
        isActive: () => true,
        release: () => { leaseReleased += 1; },
      };
      harness.config = {
        initialMode: "setup",
        roomId: "removedabc",
        roomSecret: "unused",
        displayName: "Removed member",
        setupRoomInstance: roomInstance,
      };
      harness.stopped = false;
      harness.terminal = false;
      harness.authenticated = true;
      harness.assertInboundRetirementContext = () => {};
      harness.consumeRetirementBarrier = () => {};
      storeModule.useGameStore.getState().cleanup();
      storeModule.useGameStore.getState().setScreen("chat");

      const messageId = stateModule.randomSecureRoomIdV4(16);
      await harness.handleRelay({
        kind: "secure-server",
        v: 4,
        suite: 1,
        type: "relay",
        fromDeviceId: stateModule.randomSecureRoomIdV4(16),
        logicalOrder: null,
        frame: {
          kind: "relay",
          relayKind: "commit",
          grant: {
            v: 4,
            suite: 1,
            roomInstance,
            requestId: stateModule.randomSecureRoomIdV4(16),
            tokenId: stateModule.randomSecureRoomIdV4(16),
            deviceId: stateModule.randomSecureRoomIdV4(16),
            logicalOrder: 1,
            expiresAt: Date.now() + 30_000,
          },
          retirementDeviceId: ownDeviceId,
          retirementAdmissionCommitMessageId: stateModule.randomSecureRoomIdV4(16),
          envelope: {
            v: 4,
            suite: 1,
            roomInstance,
            messageId,
            route: "group",
            payload: "AQ",
          },
        },
      });
      const store = storeModule.useGameStore.getState();
      return {
        screen: store.screen,
        terminalMessage: store.messages.at(-1)?.text ?? null,
        disposed,
        leaseReleased,
        terminal: harness.terminal,
      };
    }, secureGameReducerModuleUrl);

    expect(result.screen).toBe("knocked");
    expect(result.terminalMessage).toBe("You were removed from the secure fort.");
    expect(result.disposed).toBe(1);
    expect(result.leaseReleased).toBe(1);
    expect(result.terminal).toBe(true);
  });

  it("gates a revoked single-writer lease before queued disposal", async () => {
    const result = await page.evaluate(async () => {
      const [{ SecureRoomController }, stateModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
      ]);
      const abortController = new AbortController();
      let active = true;
      let releaseCalls = 0;
      const lease = {
        roomInstance: "opaque-store-key",
        signal: abortController.signal,
        released: Promise.resolve("takeover"),
        isActive: () => active,
        release: () => { releaseCalls += 1; active = false; },
      };
      let disposeCalls = 0;
      let socketClosed = 0;
      let handshakeSettlements = 0;
      let operationEntered!: () => void;
      let releaseOperation!: () => void;
      const operationStarted = new Promise<void>((resolve) => { operationEntered = resolve; });
      const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.generation = 12;
      harness.stopped = false;
      harness.terminal = false;
      harness.authenticated = true;
      harness.config = {
        initialMode: "setup", roomId: "takeoverab", roomSecret: "unused",
        displayName: "Lease", setupRoomInstance: stateModule.randomSecureRoomIdV4(16),
      };
      harness.engine = { dispose: () => { disposeCalls += 1; } };
      harness.lease = lease;
      harness.pendingHandshake = {
        generation: 12,
        settle: () => { handshakeSettlements += 1; },
      };
      harness.socket = {
        readyState: WebSocket.OPEN,
        onclose: null,
        close: () => { socketClosed += 1; },
      };
      harness.installLeaseAbort(lease);
      harness.enqueue(async () => {
        operationEntered();
        await operationGate;
      }, 12);
      await operationStarted;

      active = false;
      abortController.abort("takeover");
      const actionAccepted = controller.sendUiAction("chat", { text: "too late" });
      const gatedSynchronously = harness.stopped && !harness.authenticated &&
        harness.socket === null && harness.config === null && !actionAccepted && socketClosed === 1 &&
        handshakeSettlements === 1 && harness.engine !== null;
      releaseOperation();
      await harness.serialQueue;
      return {
        gatedSynchronously,
        disposedAfterQueueDrained: harness.engine === null && harness.lease === null &&
          disposeCalls === 1 && releaseCalls === 0,
      };
    });

    expect(result.gatedSynchronously).toBe(true);
    expect(result.disposedAfterQueueDrained).toBe(true);
  });

  it("acknowledges durable sender results before any follow-on secure work", async () => {
    const result = await page.evaluate(async (reducerModuleUrl) => {
      const [{ SecureRoomController }, stateModule, reducerModule] = await Promise.all([
        import("/src/services/secureRoomController.ts"),
        import("/src/services/secureRoomState.ts"),
        import(reducerModuleUrl),
      ]);
      const roomInstance = stateModule.randomSecureRoomIdV4(16);
      const deviceId = stateModule.randomSecureRoomIdV4(16);
      const otherDeviceId = stateModule.randomSecureRoomIdV4(16);
      const signaturePublicKey = stateModule.randomSecureRoomIdV4(32);
      const state = reducerModule.createSecureRoomStateV4(roomInstance, [{
        deviceId, displayName: "Sender", signaturePublicKey,
      }], deviceId);
      let pendingOutbox: any[] = [];
      const log: string[] = [];
      const fakeEngine = {
        roomInstance,
        deviceId,
        state,
        get pendingOutbox() { return pendingOutbox; },
        pendingRelayControls: [] as unknown[],
        pendingOutboundUiResult: async () => ({ state, effects: [] }),
        acknowledgeOutbound: async (messageId: string) => {
          log.push(`persist-accept:${messageId}`);
          const entry = pendingOutbox.find((candidate) => candidate.messageId === messageId ||
            candidate.welcomeMessageId === messageId);
          if (!entry) return;
          if (entry.kind === "admission" && messageId === entry.messageId) entry.commitAcknowledged = true;
          else pendingOutbox = pendingOutbox.filter((candidate) => candidate !== entry);
        },
        rejectOutbound: async (messageId: string) => {
          log.push(`persist-reject:${messageId}`);
          pendingOutbox = pendingOutbox.filter((candidate) => candidate.messageId !== messageId);
          return "reverted" as const;
        },
        recordHostTransferAuthorization: async (_offerMessageId: string, authorizationId: string) => {
          log.push(`persist-authorization:${authorizationId}`);
        },
        dispose: () => {},
      };
      const controller = new SecureRoomController();
      const harness = controller as any;
      harness.engine = fakeEngine;
      harness.authenticated = true;
      harness.replayingBacklog = false;
      harness.stopped = false;
      harness.terminal = false;
      harness.socket = { readyState: WebSocket.OPEN };
      harness.applyAcceptedOutbound = () => log.push("apply-ui");
      harness.afterAppliedState = async () => { log.push("after-state"); };
      harness.retryRelayControls = async () => {};
      harness.runAutomations = async () => {};
      harness.pumpGrantQueue = () => log.push("pump-grant");
      harness.enqueueBootstrap = () => log.push("enqueue-bootstrap");
      harness.sendPendingEntry = () => log.push("send-welcome");
      harness.sendClientFrame = (frame: { kind: string; lastMessageId?: string }) => {
        log.push(frame.kind === "delivery-ack"
          ? `delivery-ack:${frame.lastMessageId}`
          : `send:${frame.kind}`);
      };
      const ordered = (persist: string, ack: string, later: string) =>
        log.indexOf(persist) >= 0 && log.indexOf(ack) > log.indexOf(persist) &&
        log.indexOf(later) > log.indexOf(ack);

      const acceptedApplicationId = stateModule.randomSecureRoomIdV4(16);
      pendingOutbox = [{
        kind: "application", messageId: acceptedApplicationId,
        event: { logicalOrder: 1, content: { type: "chat", text: "accepted" } },
        relayContext: { kind: "application" },
      }];
      log.length = 0;
      await harness.handleApplicationResult({
        messageId: acceptedApplicationId, logicalOrder: 1, result: "accepted", reason: null,
      });
      const acceptedApplicationAckFirst = ordered(
        `persist-accept:${acceptedApplicationId}`,
        `delivery-ack:${acceptedApplicationId}`,
        "after-state",
      );

      const rejectedApplicationId = stateModule.randomSecureRoomIdV4(16);
      pendingOutbox = [{
        kind: "application", messageId: rejectedApplicationId,
        event: { logicalOrder: 2, content: { type: "chat", text: "rejected" } },
        relayContext: { kind: "application" },
      }];
      log.length = 0;
      await harness.handleApplicationResult({
        messageId: rejectedApplicationId, logicalOrder: 2,
        result: "rejected", reason: "grant-expired",
      });
      const rejectedApplicationAckFirst = ordered(
        `persist-reject:${rejectedApplicationId}`,
        `delivery-ack:${rejectedApplicationId}`,
        "pump-grant",
      );

      const acceptedCommitId = stateModule.randomSecureRoomIdV4(16);
      pendingOutbox = [{
        kind: "commit", messageId: acceptedCommitId, relayContext: { kind: "commit" },
      }];
      log.length = 0;
      await harness.handleFrameAccepted(acceptedCommitId);
      const acceptedCommitAckFirst = ordered(
        `persist-accept:${acceptedCommitId}`,
        `delivery-ack:${acceptedCommitId}`,
        "after-state",
      );

      const rejectedCommitId = stateModule.randomSecureRoomIdV4(16);
      pendingOutbox = [{
        kind: "commit", messageId: rejectedCommitId, relayContext: { kind: "commit" },
      }];
      log.length = 0;
      await harness.handleCommitRejected(rejectedCommitId, "grant-expired");
      const rejectedCommitAckFirst = ordered(
        `persist-reject:${rejectedCommitId}`,
        `delivery-ack:${rejectedCommitId}`,
        "pump-grant",
      );

      const addCommitId = stateModule.randomSecureRoomIdV4(16);
      const welcomeId = stateModule.randomSecureRoomIdV4(16);
      pendingOutbox = [{
        kind: "admission", messageId: addCommitId, admissionId: stateModule.randomSecureRoomIdV4(16),
        welcomeMessageId: welcomeId, commitAcknowledged: false, relayContext: { kind: "commit" },
      }];
      log.length = 0;
      await harness.handleFrameAccepted(addCommitId);
      const addCommitWasAcked = ordered(
        `persist-accept:${addCommitId}`,
        `delivery-ack:${addCommitId}`,
        "send-welcome",
      );
      log.length = 0;
      await harness.handleFrameAccepted(welcomeId);
      const welcomeWasNotDeliveryAcked = !log.includes(`delivery-ack:${welcomeId}`) &&
        log.includes("enqueue-bootstrap");

      const authorizationId = stateModule.randomSecureRoomIdV4(16);
      log.length = 0;
      await harness.handleHostTransferAuthorized({
        fromHostDeviceId: otherDeviceId,
        authorizationId,
        offerMessageId: stateModule.randomSecureRoomIdV4(16),
        expiresAt: Date.now() + 30_000,
      });
      const authorizationAckedAfterPersistence = ordered(
        `persist-authorization:${authorizationId}`,
        `delivery-ack:${authorizationId}`,
        `delivery-ack:${authorizationId}`,
      ) || log.join("|") ===
        `persist-authorization:${authorizationId}|delivery-ack:${authorizationId}`;

      return {
        acceptedApplicationAckFirst,
        rejectedApplicationAckFirst,
        acceptedCommitAckFirst,
        rejectedCommitAckFirst,
        addCommitWasAcked,
        welcomeWasNotDeliveryAcked,
        authorizationAckedAfterPersistence,
      };
    }, secureGameReducerModuleUrl);

    expect(result.acceptedApplicationAckFirst).toBe(true);
    expect(result.rejectedApplicationAckFirst).toBe(true);
    expect(result.acceptedCommitAckFirst).toBe(true);
    expect(result.rejectedCommitAckFirst).toBe(true);
    expect(result.addCommitWasAcked).toBe(true);
    expect(result.welcomeWasNotDeliveryAcked).toBe(true);
    expect(result.authorizationAckedAfterPersistence).toBe(true);
  });
});
