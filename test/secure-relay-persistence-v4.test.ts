import { describe, expect, it } from "bun:test";
import {
  MAX_SECURE_RELAY_CHUNKS_V4,
  SECURE_RELAY_CHUNK_CHARS_V4,
  parseSecureRelayPersistenceManifestV4,
  prepareSecureRelayPersistenceV4,
  restoreSecureRelayPersistenceV4,
  secureRelayChunkKeyV4,
} from "../src/secureRelayPersistenceV4";
import { createSecureRelayStateV4, type SecureRelayStateV4 } from "../src/secureRelayV4";
import { toBase64Url } from "../src/roomAuth";
import { ROOM_INVITATION_AUTH_KDF_V4 } from "../src/roomInvitationAuthV4";
import { roomInvitationKeyPackageDigestV4 } from "../src/roomInvitationMemberBindingV4";

function id(fill: number, bytes = 16): string {
  return toBase64Url(new Uint8Array(bytes).fill(fill));
}

async function state(): Promise<SecureRelayStateV4> {
  const keyPackage = id(6, 64);
  const created = await createSecureRelayStateV4({
    deviceId: id(2),
    connectionId: id(3),
    authentication: "invitation",
  }, {
    kind: "setup",
    requestId: id(4),
    signaturePublicKey: id(5, 32),
    hello: {
      v: 4,
      suite: 1,
      roomInstance: id(1),
      deviceId: id(2),
      keyPackage,
    },
    memberBinding: {
      v: 4,
      kdf: ROOM_INVITATION_AUTH_KDF_V4,
      mode: "founder",
      roomId: "pillowfort",
      roomInstance: id(1),
      deviceId: id(2),
      admissionId: id(4),
      signaturePublicKey: id(5, 32),
      keyPackageDigest: await roomInvitationKeyPackageDigestV4(keyPackage),
      proof: id(9, 64),
    },
  }, 1);
  if (!created.ok) throw new Error(created.code);
  return created.state;
}

describe("secure relay Durable Object persistence", () => {
  it("round-trips a strict, integrity-checked snapshot", async () => {
    const original = await state();
    const prepared = await prepareSecureRelayPersistenceV4({
      roomId: "pillowfort",
      roomAuthPublicKey: id(7, 32),
      state: original,
      generation: 1,
    });
    const restored = await restoreSecureRelayPersistenceV4(prepared.manifest, prepared.chunks);
    expect(restored).not.toBeNull();
    expect(restored?.state).toEqual(original);
    expect(restored?.manifest.generation).toBe(1);

    const tampered = [...prepared.chunks];
    tampered[0] = tampered[0].replace("open", "xpen");
    expect(await restoreSecureRelayPersistenceV4(prepared.manifest, tampered)).toBeNull();
    expect(await restoreSecureRelayPersistenceV4({
      ...prepared.manifest,
      roomAuthPublicKey: id(8, 32),
    }, prepared.chunks)).toBeNull();
    expect(await restoreSecureRelayPersistenceV4(prepared.manifest, [])).toBeNull();
    expect(await restoreSecureRelayPersistenceV4(prepared.manifest, [...prepared.chunks, "extra"])).toBeNull();
    expect(await restoreSecureRelayPersistenceV4(
      { ...prepared.manifest, stateRevision: prepared.manifest.stateRevision + 1 },
      prepared.chunks,
    )).toBeNull();
    expect(await restoreSecureRelayPersistenceV4(
      { ...prepared.manifest, byteLength: prepared.manifest.byteLength + 1 },
      prepared.chunks,
    )).toBeNull();
    expect(await restoreSecureRelayPersistenceV4(prepared.manifest, [{ malicious: true }])).toBeNull();
  });

  it("rejects malformed manifests and out-of-range chunk keys", async () => {
    const prepared = await prepareSecureRelayPersistenceV4({
      roomId: "pillowfort",
      roomAuthPublicKey: id(7, 32),
      state: await state(),
      generation: 0,
    });
    expect(parseSecureRelayPersistenceManifestV4({ ...prepared.manifest, extra: true })).toBeNull();
    expect(parseSecureRelayPersistenceManifestV4({ ...prepared.manifest, chunkCount: MAX_SECURE_RELAY_CHUNKS_V4 + 1 })).toBeNull();
    expect(() => secureRelayChunkKeyV4(0, MAX_SECURE_RELAY_CHUNKS_V4)).toThrow();
    expect(prepared.chunks.every((chunk) => chunk.length <= SECURE_RELAY_CHUNK_CHARS_V4)).toBe(true);
  });
});
