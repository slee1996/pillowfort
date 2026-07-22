import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "../client/node_modules/vite/dist/node/index.js";

let vite: ViteDevServer;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  vite = await createServer({
    root: join(import.meta.dir, "../client"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  baseUrl = vite.resolvedUrls?.local[0] || vite.resolvedUrls?.network[0] || "";
  if (!baseUrl) throw new Error("Vite did not expose an MLS test URL");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(baseUrl);
}, 60_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
}, 60_000);

describe("OpenMLS protocol-v4 browser adapter", () => {
  it("enforces admission, update, removal, and consumed-generation boundaries", async () => {
    const result = await page.evaluate(async () => {
      const mls = await import("/src/services/mlsCrypto.ts");
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const bytes = (value: number) => new Uint8Array(16).fill(value);
      const roomBinding = bytes(7);
      const base64Url = (value: Uint8Array) => {
        let binary = "";
        for (const byte of value) binary += String.fromCharCode(byte);
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      };
      const roomSecret = `pf2_${base64Url(new Uint8Array(32).fill(91))}`;
      const errorCode = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code || "error";
        }
      };

      const createdHost = await mls.create({
        roomBinding,
        identity: bytes(1),
        roomSecret,
        founder: true,
      });
      let host = createdHost.session;
      let hostSnapshot = createdHost.snapshot;

      const createdBob = await mls.create({
        roomBinding,
        identity: bytes(2),
        roomSecret,
      });
      let bob = createdBob.session;
      let bobSnapshot = createdBob.snapshot;
      const bobPackage = await bob.keyPackage();
      bobSnapshot = bobPackage.snapshot;

      const preAdmission = await host.encrypt(encoder.encode("before admission"));
      hostSnapshot = preAdmission.snapshot;
      const addBob = await host.add(bobPackage.outbound!);
      hostSnapshot = addBob.snapshot;
      const joinBob = await bob.join(addBob.welcome!, addBob.ratchetTree!);
      bobSnapshot = joinBob.snapshot;

      const preAdmissionRejected = await errorCode(() => bob.receive(preAdmission.outbound!));
      bob = await mls.restore({ roomBinding, roomSecret, snapshot: bobSnapshot });

      const paddedShort = await host.encrypt(encoder.encode("a"));
      hostSnapshot = paddedShort.snapshot;
      const bobPaddedShort = await bob.receive(paddedShort.outbound!);
      bobSnapshot = bobPaddedShort.snapshot;
      const paddedLong = await host.encrypt(encoder.encode("b".repeat(500)));
      hostSnapshot = paddedLong.snapshot;
      const bobPaddedLong = await bob.receive(paddedLong.outbound!);
      bobSnapshot = bobPaddedLong.snapshot;
      const samePaddingBucket = paddedShort.outbound!.byteLength === paddedLong.outbound!.byteLength;

      const skippedGeneration = await host.encrypt(encoder.encode("skipped generation"));
      hostSnapshot = skippedGeneration.snapshot;
      const forwardGeneration = await host.encrypt(encoder.encode("forward generation"));
      hostSnapshot = forwardGeneration.snapshot;
      const bobForwardGeneration = await bob.receive(forwardGeneration.outbound!);
      bobSnapshot = bobForwardGeneration.snapshot;
      const skippedGenerationRejected = await errorCode(() => bob.receive(skippedGeneration.outbound!));
      bob = await mls.restore({ roomBinding, roomSecret, snapshot: bobSnapshot });

      const epochOne = await host.encrypt(encoder.encode("epoch one"));
      hostSnapshot = epochOne.snapshot;
      const bobEpochOne = await bob.receive(epochOne.outbound!);
      bobSnapshot = bobEpochOne.snapshot;
      const consumedGenerationRejected = await errorCode(() => bob.receive(epochOne.outbound!));
      bob = await mls.restore({ roomBinding, roomSecret, snapshot: bobSnapshot });

      const createdCharlie = await mls.create({
        roomBinding,
        identity: bytes(3),
        roomSecret,
      });
      let charlie = createdCharlie.session;
      const charliePackage = await charlie.keyPackage();
      const addCharlie = await host.add(charliePackage.outbound!);
      hostSnapshot = addCharlie.snapshot;
      const bobAddCharlie = await bob.receive(addCharlie.outbound!);
      bobSnapshot = bobAddCharlie.snapshot;
      const joinCharlie = await charlie.join(addCharlie.welcome!, addCharlie.ratchetTree!);
      let charlieSnapshot = joinCharlie.snapshot;
      const staleCharlieSnapshot = charlieSnapshot.slice();

      // Deliberately leave one application ciphertext undelivered across the
      // epoch transition. Protocol v4 promises not to retain prior-epoch
      // decryptors merely to make late delivery convenient.
      const lateBeforeUpdate = await host.encrypt(encoder.encode("late before update"));
      hostSnapshot = lateBeforeUpdate.snapshot;

      const update = await host.selfUpdate();
      hostSnapshot = update.snapshot;
      const bobUpdate = await bob.receive(update.outbound!);
      bobSnapshot = bobUpdate.snapshot;
      const charlieUpdate = await charlie.receive(update.outbound!);
      charlieSnapshot = charlieUpdate.snapshot;
      const pastEpochRejected = await errorCode(() => charlie.receive(lateBeforeUpdate.outbound!));
      charlie = await mls.restore({ roomBinding, roomSecret, snapshot: charlieSnapshot });

      const postUpdate = await host.encrypt(encoder.encode("after recovery update"));
      hostSnapshot = postUpdate.snapshot;
      const bobPostUpdate = await bob.receive(postUpdate.outbound!);
      bobSnapshot = bobPostUpdate.snapshot;
      const charliePostUpdate = await charlie.receive(postUpdate.outbound!);
      charlieSnapshot = charliePostUpdate.snapshot;
      const staleCharlie = await mls.restore({ roomBinding, roomSecret, snapshot: staleCharlieSnapshot });
      const preUpdateStateRejected = await errorCode(() => staleCharlie.receive(postUpdate.outbound!));

      const bobIndex = host.roster().find((member) => member.identity.every((value) => value === 2))?.index;
      if (bobIndex === undefined) throw new Error("Bob missing from roster");
      const removeBob = await host.remove(bobIndex);
      hostSnapshot = removeBob.snapshot;
      const charlieRemove = await charlie.receive(removeBob.outbound!);
      charlieSnapshot = charlieRemove.snapshot;
      const bobRemove = await bob.receive(removeBob.outbound!);
      bobSnapshot = bobRemove.snapshot;
      const bobInactiveAfterCommit = !bob.isActive();

      const postRemoval = await host.encrypt(encoder.encode("after removal"));
      hostSnapshot = postRemoval.snapshot;
      const charliePostRemoval = await charlie.receive(postRemoval.outbound!);
      charlieSnapshot = charliePostRemoval.snapshot;
      const removedMemberRejected = await errorCode(() => bob.receive(postRemoval.outbound!));

      host.dispose();
      host = await mls.restore({ roomBinding, roomSecret, snapshot: hostSnapshot });
      const afterRestore = await host.encrypt(encoder.encode("after durable restore"));
      hostSnapshot = afterRestore.snapshot;
      const charlieAfterRestore = await charlie.receive(afterRestore.outbound!);
      charlieSnapshot = charlieAfterRestore.snapshot;

      const roster = host.roster();
      const signedPayload = encoder.encode("pillowfort:v4:event-signature-oracle");
      const signature = host.sign(signedPayload);
      const hostSignatureKey = roster.find((member) => member.identity.every((value) => value === 1))?.signatureKey;
      const charlieSignatureKey = roster.find((member) => member.identity.every((value) => value === 3))?.signatureKey;
      if (!hostSignatureKey || !charlieSignatureKey) throw new Error("roster signature key missing");
      const importVerificationKey = (raw: Uint8Array) => crypto.subtle.importKey(
        "raw",
        raw,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const ownSignatureVerifies = await crypto.subtle.verify(
        { name: "Ed25519" },
        await importVerificationKey(hostSignatureKey),
        signature,
        signedPayload,
      );
      const otherSignatureRejected = !await crypto.subtle.verify(
        { name: "Ed25519" },
        await importVerificationKey(charlieSignatureKey),
        signature,
        signedPayload,
      );
      const result = {
        suiteOneCiphertext: postRemoval.outbound![1] === 1,
        samePaddingBucket,
        skippedGenerationRejected,
        preAdmissionRejected,
        consumedGenerationRejected,
        pastEpochRejected,
        preUpdateStateRejected,
        removedMemberRejected,
        bobInactiveAfterCommit,
        epochOnePlaintext: decoder.decode(bobEpochOne.plaintext),
        postUpdatePlaintext: decoder.decode(charliePostUpdate.plaintext),
        postRemovalPlaintext: decoder.decode(charliePostRemoval.plaintext),
        restoredPlaintext: decoder.decode(charlieAfterRestore.plaintext),
        rosterIdentities: roster.map((member) => [...member.identity]),
        snapshotsAreWrapped: [hostSnapshot, bobSnapshot, charlieSnapshot].every(
          (snapshot) => decoder.decode(snapshot.slice(0, 8)) === "PFMLSWR1",
        ),
        ownSignatureVerifies,
        otherSignatureRejected,
      };
      host.dispose();
      charlie.dispose();
      return result;
    });

    expect(result.preAdmissionRejected).not.toBe("accepted");
    expect(result.samePaddingBucket).toBe(true);
    expect(result.skippedGenerationRejected).not.toBe("accepted");
    expect(result.consumedGenerationRejected).not.toBe("accepted");
    expect(result.pastEpochRejected).not.toBe("accepted");
    expect(result.preUpdateStateRejected).not.toBe("accepted");
    expect(result.removedMemberRejected).not.toBe("accepted");
    expect(result.bobInactiveAfterCommit).toBe(true);
    expect(result.epochOnePlaintext).toBe("epoch one");
    expect(result.postUpdatePlaintext).toBe("after recovery update");
    expect(result.postRemovalPlaintext).toBe("after removal");
    expect(result.restoredPlaintext).toBe("after durable restore");
    expect(result.rosterIdentities).toEqual([new Array(16).fill(1), new Array(16).fill(3)]);
    expect(result.snapshotsAreWrapped).toBe(true);
    expect(result.ownSignatureVerifies).toBe(true);
    expect(result.otherSignatureRejected).toBe(true);
  }, 120_000);

  it("authenticates persisted state against tamper, wrong secrets, and room swaps", async () => {
    const result = await page.evaluate(async () => {
      const mls = await import("/src/services/mlsCrypto.ts");
      const bytes = (value: number, length = 16) => new Uint8Array(length).fill(value);
      const base64Url = (value: Uint8Array) => {
        let binary = "";
        for (const byte of value) binary += String.fromCharCode(byte);
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      };
      const secret = (value: number) => `pf2_${base64Url(bytes(value, 32))}`;
      const roomBinding = bytes(21);
      const created = await mls.create({
        roomBinding,
        identity: bytes(22),
        roomSecret: secret(23),
        founder: true,
      });
      const first = created.snapshot;
      const second = await created.session.snapshot();
      created.session.dispose();

      const code = async (options: Parameters<typeof mls.restore>[0]) => {
        try {
          const restored = await mls.restore(options);
          restored.dispose();
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code || "error";
        }
      };
      const tampered = first.slice();
      tampered[tampered.length - 1] ^= 0x80;
      const trailing = new Uint8Array(first.length + 1);
      trailing.set(first);
      const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
      oversized.set(first.slice(0, Math.min(first.length, oversized.length)));
      return {
        freshEnvelope: first.some((byte, index) => byte !== second[index]),
        correct: await code({ roomBinding, roomSecret: secret(23), snapshot: first }),
        tampered: await code({ roomBinding, roomSecret: secret(23), snapshot: tampered }),
        wrongSecret: await code({ roomBinding, roomSecret: secret(24), snapshot: first }),
        roomSwap: await code({ roomBinding: bytes(25), roomSecret: secret(23), snapshot: first }),
        trailing: await code({ roomBinding, roomSecret: secret(23), snapshot: trailing }),
        oversized: await code({ roomBinding, roomSecret: secret(23), snapshot: oversized }),
      };
    });

    expect(result.freshEnvelope).toBe(true);
    expect(result.correct).toBe("accepted");
    expect(result.tampered).toBe("state-invalid");
    expect(result.wrongSecret).toBe("state-invalid");
    expect(result.roomSwap).toBe("state-invalid");
    expect(result.trailing).toBe("state-invalid");
    expect(result.oversized).toBe("invalid-input");
  }, 60_000);

  it("rejects malformed and oversized protocol inputs without panicking", async () => {
    const result = await page.evaluate(async () => {
      const mls = await import("/src/services/mlsCrypto.ts");
      const bytes = (value: number, length = 16) => new Uint8Array(length).fill(value);
      const base64Url = (value: Uint8Array) => {
        let binary = "";
        for (const byte of value) binary += String.fromCharCode(byte);
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      };
      const roomBinding = bytes(31);
      const roomSecret = `pf2_${base64Url(bytes(32, 32))}`;
      const createHost = () => mls.create({ roomBinding, identity: crypto.getRandomValues(new Uint8Array(16)), roomSecret, founder: true });
      const code = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          return "accepted";
        } catch (error) {
          return (error as { code?: string }).code || "error";
        }
      };

      const malformedMessageHost = await createHost();
      const malformedMessage = await code(() => malformedMessageHost.session.receive(new Uint8Array([255, 0, 1])));
      const poisonedAfterMalformed = await code(async () => malformedMessageHost.session.snapshot());

      const malformedPackageHost = await createHost();
      const malformedPackage = await code(() => malformedPackageHost.session.add(new Uint8Array([1, 2, 3])));

      const oversizedMessageHost = await createHost();
      const oversizedMessage = await code(() => oversizedMessageHost.session.receive(new Uint8Array(64 * 1024 + 1)));
      const stillActiveAfterBoundCheck = oversizedMessageHost.session.isActive();
      oversizedMessageHost.session.dispose();

      const oversizedPackageHost = await createHost();
      const oversizedPackage = await code(() => oversizedPackageHost.session.add(new Uint8Array(16 * 1024 + 1)));
      oversizedPackageHost.session.dispose();

      const emptyPlaintextHost = await createHost();
      const emptyPlaintext = await code(() => emptyPlaintextHost.session.encrypt(new Uint8Array()));
      emptyPlaintextHost.session.dispose();

      const oversizedSignatureHost = await createHost();
      const oversizedSignature = await code(async () => oversizedSignatureHost.session.sign(new Uint8Array(64 * 1024 + 1)));
      const zeroLengthSignature = oversizedSignatureHost.session.sign(new Uint8Array()).byteLength;
      oversizedSignatureHost.session.dispose();

      return {
        malformedMessage,
        poisonedAfterMalformed,
        malformedPackage,
        oversizedMessage,
        stillActiveAfterBoundCheck,
        oversizedPackage,
        emptyPlaintext,
        oversizedSignature,
        zeroLengthSignature,
      };
    });

    expect(result.malformedMessage).toBe("transition-failed");
    expect(result.poisonedAfterMalformed).toBe("session-closed");
    expect(result.malformedPackage).toBe("transition-failed");
    expect(result.oversizedMessage).toBe("invalid-input");
    expect(result.stillActiveAfterBoundCheck).toBe(true);
    expect(result.oversizedPackage).toBe("invalid-input");
    expect(result.emptyPlaintext).toBe("invalid-input");
    expect(result.oversizedSignature).toBe("invalid-input");
    expect(result.zeroLengthSignature).toBe(64);
  }, 60_000);
});
