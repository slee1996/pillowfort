import { describe, expect, it } from "bun:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  secureDeviceResumeProofBytesV4,
  signSecureDeviceResumeProofV4,
  verifySecureDeviceResumeProofV4,
} from "../src/deviceAuthV4";
import { toBase64Url } from "../src/roomAuth";

function encoded(bytes: number, fill: number): string {
  return toBase64Url(new Uint8Array(bytes).fill(fill));
}

const CONTEXT = {
  roomId: "fort-1",
  roomInstance: encoded(16, 1),
  deviceId: encoded(16, 2),
  connectionId: encoded(16, 3),
  requestId: encoded(16, 4),
  challenge: encoded(32, 5),
};

describe("protocol-v4 device resume authentication", () => {
  it("binds proof of the MLS credential key to room, socket, request, and challenge", async () => {
    const secret = new Uint8Array(32).fill(9);
    const publicKey = toBase64Url(await getPublicKeyAsync(secret));
    const proof = await signSecureDeviceResumeProofV4(
      CONTEXT,
      (bytes) => signAsync(bytes, secret),
    );

    expect(await verifySecureDeviceResumeProofV4(CONTEXT, proof, publicKey)).toBe(true);
    for (const changed of [
      { ...CONTEXT, roomId: "fort-2" },
      { ...CONTEXT, roomInstance: encoded(16, 6) },
      { ...CONTEXT, deviceId: encoded(16, 7) },
      { ...CONTEXT, connectionId: encoded(16, 8) },
      { ...CONTEXT, requestId: encoded(16, 9) },
      { ...CONTEXT, challenge: encoded(32, 10) },
    ]) {
      expect(await verifySecureDeviceResumeProofV4(changed, proof, publicKey)).toBe(false);
    }
    expect(secureDeviceResumeProofBytesV4(CONTEXT)).toEqual(
      secureDeviceResumeProofBytesV4({ ...CONTEXT }),
    );
  });

  it("rejects malformed encodings, wrong keys, and noncanonical room flags", async () => {
    const secret = new Uint8Array(32).fill(11);
    const proof = await signSecureDeviceResumeProofV4(CONTEXT, (bytes) => signAsync(bytes, secret));
    expect(await verifySecureDeviceResumeProofV4(CONTEXT, proof, encoded(32, 12))).toBe(false);
    expect(await verifySecureDeviceResumeProofV4(CONTEXT, `${proof}=`, toBase64Url(await getPublicKeyAsync(secret)))).toBe(false);
    expect(await verifySecureDeviceResumeProofV4({ ...CONTEXT, roomId: " Fort-1 " }, proof, encoded(32, 12))).toBe(false);
    expect(() => secureDeviceResumeProofBytesV4({ ...CONTEXT, requestId: "short" })).toThrow(TypeError);
  });
});
