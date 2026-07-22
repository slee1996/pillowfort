export const SECURE_ROOM_PROTOCOL_VERSION = 4 as const;
export const SECURE_ROOM_MLS_CIPHERSUITE = 1 as const;
export const SECURE_ROOM_MLS_CIPHERSUITE_NAME =
  "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
export const SECURE_ROOM_MLS_IMPLEMENTATION = "openmls-0.8.1" as const;

export const SECURE_ROOM_ID_BYTES = 16;
export const SECURE_DEVICE_ID_BYTES = 16;
export const SECURE_MESSAGE_ID_BYTES = 16;
export const MAX_MLS_KEY_PACKAGE_BYTES = 16 * 1024;
export const MAX_MLS_RELAY_PAYLOAD_BYTES = 64 * 1024;
export const MAX_SECURE_WEBSOCKET_FRAME_BYTES = 96 * 1024;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type SecureRelayRouteV4 = "host" | "group" | "device";

/**
 * Sent with setup, join, and rejoin authentication. The key package is public
 * MLS admission material; it is not a room secret and must be single-use.
 */
export interface SecureMemberHelloV4 {
  v: 4;
  suite: 1;
  roomInstance: string;
  deviceId: string;
  keyPackage: string;
}

/**
 * The relay can see only the minimum routing data. `payload` is one complete,
 * canonically encoded MLS wire message. Its application content and message
 * kind remain opaque to the relay.
 */
export interface SecureRelayEnvelopeV4 {
  v: 4;
  suite: 1;
  roomInstance: string;
  messageId: string;
  route: SecureRelayRouteV4;
  to?: string;
  payload: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key));
}

/** Returns the decoded length only for canonical, unpadded base64url. */
export function canonicalBase64UrlByteLength(value: unknown): number | null {
  if (typeof value !== "string" || !value || !BASE64URL_RE.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  const decoded = Math.floor((value.length * 6) / 8);
  // Canonical encodings cannot carry non-zero unused bits.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(value[value.length - 1]);
  if (last < 0) return null;
  if (remainder === 2 && (last & 0x0f) !== 0) return null;
  if (remainder === 3 && (last & 0x03) !== 0) return null;
  return decoded;
}

function isFixedBase64Url(value: unknown, byteLength: number): value is string {
  return canonicalBase64UrlByteLength(value) === byteLength;
}

function isBoundedBase64Url(value: unknown, minBytes: number, maxBytes: number): value is string {
  const length = canonicalBase64UrlByteLength(value);
  return length !== null && length >= minBytes && length <= maxBytes;
}

export function isSecureMemberHelloV4(value: unknown): value is SecureMemberHelloV4 {
  if (!isRecord(value) || !hasExactKeys(value, ["v", "suite", "roomInstance", "deviceId", "keyPackage"])) return false;
  return value.v === SECURE_ROOM_PROTOCOL_VERSION &&
    value.suite === SECURE_ROOM_MLS_CIPHERSUITE &&
    isFixedBase64Url(value.roomInstance, SECURE_ROOM_ID_BYTES) &&
    isFixedBase64Url(value.deviceId, SECURE_DEVICE_ID_BYTES) &&
    isBoundedBase64Url(value.keyPackage, 1, MAX_MLS_KEY_PACKAGE_BYTES);
}

export interface SecureRelayValidationOptions {
  expectedRoomInstance?: string;
  allowedRoutes?: ReadonlySet<SecureRelayRouteV4>;
}

export function isSecureRelayEnvelopeV4(
  value: unknown,
  options: SecureRelayValidationOptions = {},
): value is SecureRelayEnvelopeV4 {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["v", "suite", "roomInstance", "messageId", "route", "payload"],
    ["to"],
  )) return false;
  if (value.v !== SECURE_ROOM_PROTOCOL_VERSION || value.suite !== SECURE_ROOM_MLS_CIPHERSUITE) return false;
  if (!isFixedBase64Url(value.roomInstance, SECURE_ROOM_ID_BYTES)) return false;
  if (options.expectedRoomInstance !== undefined && value.roomInstance !== options.expectedRoomInstance) return false;
  if (!isFixedBase64Url(value.messageId, SECURE_MESSAGE_ID_BYTES)) return false;
  if (value.route !== "host" && value.route !== "group" && value.route !== "device") return false;
  if (options.allowedRoutes && !options.allowedRoutes.has(value.route)) return false;
  if (!isBoundedBase64Url(value.payload, 1, MAX_MLS_RELAY_PAYLOAD_BYTES)) return false;

  if (value.route === "device") return isFixedBase64Url(value.to, SECURE_DEVICE_ID_BYTES);
  return value.to === undefined;
}

export function parseSecureMemberHelloV4(value: unknown): SecureMemberHelloV4 | null {
  return isSecureMemberHelloV4(value) ? value : null;
}

export function parseSecureRelayEnvelopeV4(
  value: unknown,
  options: SecureRelayValidationOptions = {},
): SecureRelayEnvelopeV4 | null {
  return isSecureRelayEnvelopeV4(value, options) ? value : null;
}
