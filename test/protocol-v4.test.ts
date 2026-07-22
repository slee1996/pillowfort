import { describe, expect, it } from "bun:test";
import {
  MAX_MLS_KEY_PACKAGE_BYTES,
  MAX_MLS_RELAY_PAYLOAD_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE_NAME,
  SECURE_ROOM_MLS_IMPLEMENTATION,
  canonicalBase64UrlByteLength,
  isSecureMemberHelloV4,
  isSecureRelayEnvelopeV4,
} from "../src/protocolV4";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomId(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

describe("protocol v4 bounded wire contract", () => {
  it("pins the reviewed MLS core and mandatory RFC 9420 ciphersuite", () => {
    expect(SECURE_ROOM_MLS_IMPLEMENTATION).toBe("openmls-0.8.1");
    expect(SECURE_ROOM_MLS_CIPHERSUITE_NAME).toBe(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
    );
  });

  it("accepts only canonical unpadded base64url", () => {
    expect(canonicalBase64UrlByteLength("AA")).toBe(1);
    expect(canonicalBase64UrlByteLength("AAA")).toBe(2);
    expect(canonicalBase64UrlByteLength("AQ")).toBe(1);
    expect(canonicalBase64UrlByteLength("AB")).toBeNull();
    expect(canonicalBase64UrlByteLength("AAF")).toBeNull();
    expect(canonicalBase64UrlByteLength("AA==")).toBeNull();
    expect(canonicalBase64UrlByteLength("A")).toBeNull();
    expect(canonicalBase64UrlByteLength(4)).toBeNull();
  });

  it("rejects legacy, cross-version, unknown-field, and oversized member hellos", () => {
    const valid = {
      v: 4,
      suite: 1,
      roomInstance: randomId(),
      deviceId: randomId(),
      keyPackage: base64Url(new Uint8Array([1, 2, 3])),
    };
    expect(isSecureMemberHelloV4(valid)).toBe(true);
    expect(isSecureMemberHelloV4({ ...valid, v: 3 })).toBe(false);
    expect(isSecureMemberHelloV4({ ...valid, suite: 3 })).toBe(false);
    expect(isSecureMemberHelloV4({ ...valid, downgrade: true })).toBe(false);
    expect(isSecureMemberHelloV4(Object.assign(Object.create({ v: 4 }), valid))).toBe(false);
    expect(isSecureMemberHelloV4(new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } }))).toBe(false);
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "deviceId", { enumerable: true, get: () => valid.deviceId });
    expect(isSecureMemberHelloV4(accessor)).toBe(false);
    expect(isSecureMemberHelloV4({ ...valid, roomInstance: `${valid.roomInstance}=` })).toBe(false);
    expect(isSecureMemberHelloV4({
      ...valid,
      keyPackage: base64Url(new Uint8Array(MAX_MLS_KEY_PACKAGE_BYTES + 1)),
    })).toBe(false);
  });

  it("enforces exact relay routes, target rules, room binding, and payload limits", () => {
    const roomInstance = randomId();
    const valid = {
      v: 4,
      suite: 1,
      roomInstance,
      messageId: randomId(),
      route: "group",
      payload: base64Url(new Uint8Array([9])),
    };
    expect(isSecureRelayEnvelopeV4(valid, { expectedRoomInstance: roomInstance })).toBe(true);
    expect(isSecureRelayEnvelopeV4({ ...valid, to: randomId() })).toBe(false);
    expect(isSecureRelayEnvelopeV4({ ...valid, route: "device" })).toBe(false);
    expect(isSecureRelayEnvelopeV4({ ...valid, route: "device", to: randomId() })).toBe(true);
    expect(isSecureRelayEnvelopeV4(valid, { expectedRoomInstance: randomId() })).toBe(false);
    expect(isSecureRelayEnvelopeV4(valid, { allowedRoutes: new Set(["host"]) })).toBe(false);
    expect(isSecureRelayEnvelopeV4({ ...valid, type: "chat" })).toBe(false);
    expect(isSecureRelayEnvelopeV4({
      ...valid,
      payload: base64Url(new Uint8Array(MAX_MLS_RELAY_PAYLOAD_BYTES + 1)),
    })).toBe(false);
  });
});
