import { describe, expect, test } from "bun:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  ROOM_INVITATION_AUTH_KDF_V4,
  roomInvitationAuthProofBytesV4,
  verifyRoomInvitationAuthV4,
  type RoomInvitationAuthContextV4,
} from "../src/roomInvitationAuthV4";
import {
  roomInvitationMemberBindingProofBytesV4,
  secureKeyPackageDigestV4,
  verifyRoomInvitationMemberBindingV4,
  type RoomInvitationMemberBindingContextV4,
} from "../src/roomInvitationMemberBindingV4";
import { toBase64Url } from "../src/roomAuth";

const id = (byte: number) => toBase64Url(new Uint8Array(16).fill(byte));

describe("protocol-v4 room invitation authentication", () => {
  test("binds setup and join proofs to the complete socket and room context", async () => {
    const seed = new Uint8Array(32).fill(77);
    const publicKey = toBase64Url(await getPublicKeyAsync(seed));
    const base: Omit<RoomInvitationAuthContextV4, "mode"> = {
      roomId: "abcdefghij",
      roomInstance: id(1),
      deviceId: id(2),
      connectionId: id(3),
      requestId: id(4),
      challenge: toBase64Url(new Uint8Array(32).fill(5)),
    };
    const setupContext = { ...base, mode: "setup" as const };
    const setupAuth = {
      v: 4 as const,
      kdf: ROOM_INVITATION_AUTH_KDF_V4,
      challenge: base.challenge,
      proof: toBase64Url(await signAsync(roomInvitationAuthProofBytesV4(setupContext, publicKey), seed)),
      publicKey,
    };
    expect(await verifyRoomInvitationAuthV4({ context: setupContext, auth: setupAuth })).toBeTrue();

    for (const altered of [
      { ...setupContext, roomInstance: id(6) },
      { ...setupContext, deviceId: id(6) },
      { ...setupContext, connectionId: id(6) },
      { ...setupContext, requestId: id(6) },
      { ...setupContext, challenge: toBase64Url(new Uint8Array(32).fill(6)) },
      { ...setupContext, roomId: "jihgfedcba" },
    ]) expect(await verifyRoomInvitationAuthV4({ context: altered, auth: setupAuth })).toBeFalse();

    const joinContext = { ...base, deviceId: id(7), requestId: id(8), mode: "join" as const };
    const joinAuth = {
      v: 4 as const,
      kdf: ROOM_INVITATION_AUTH_KDF_V4,
      challenge: base.challenge,
      proof: toBase64Url(await signAsync(roomInvitationAuthProofBytesV4(joinContext, publicKey), seed)),
    };
    expect(await verifyRoomInvitationAuthV4({ context: joinContext, auth: joinAuth, storedPublicKey: publicKey })).toBeTrue();
    expect(await verifyRoomInvitationAuthV4({ context: joinContext, auth: { ...joinAuth, publicKey }, storedPublicKey: publicKey })).toBeFalse();
  });

  test("binds founder and admission authorization to the exact MLS credential and KeyPackage", async () => {
    const seed = new Uint8Array(32).fill(78);
    const invitationPublicKey = toBase64Url(await getPublicKeyAsync(seed));
    const keyPackage = new Uint8Array([1, 2, 3, 4, 5]);
    const context: RoomInvitationMemberBindingContextV4 = {
      mode: "admission",
      roomId: "abcdefghij",
      roomInstance: id(10),
      deviceId: id(11),
      admissionId: id(12),
      signaturePublicKey: toBase64Url(new Uint8Array(32).fill(13)),
      keyPackageDigest: await secureKeyPackageDigestV4(keyPackage),
    };
    const binding = {
      v: 4 as const,
      kdf: ROOM_INVITATION_AUTH_KDF_V4,
      ...context,
      proof: toBase64Url(await signAsync(roomInvitationMemberBindingProofBytesV4(context), seed)),
    };
    expect(await verifyRoomInvitationMemberBindingV4({ binding, invitationPublicKey, expected: context })).toBeTrue();

    const replacementDigest = await secureKeyPackageDigestV4(new Uint8Array([9, 8, 7, 6]));
    for (const expected of [
      { ...context, keyPackageDigest: replacementDigest },
      { ...context, signaturePublicKey: toBase64Url(new Uint8Array(32).fill(99)) },
      { ...context, deviceId: id(99) },
      { ...context, admissionId: id(98) },
    ]) {
      expect(await verifyRoomInvitationMemberBindingV4({ binding, invitationPublicKey, expected })).toBeFalse();
    }

    const founderContext = { ...context, mode: "founder" as const };
    const founderBinding = {
      ...binding,
      mode: "founder" as const,
      proof: toBase64Url(await signAsync(roomInvitationMemberBindingProofBytesV4(founderContext), seed)),
    };
    expect(await verifyRoomInvitationMemberBindingV4({
      binding: founderBinding,
      invitationPublicKey,
      expected: founderContext,
    })).toBeTrue();
    expect(await verifyRoomInvitationMemberBindingV4({
      binding: founderBinding,
      invitationPublicKey,
      expected: context,
    })).toBeFalse();
  });
});
