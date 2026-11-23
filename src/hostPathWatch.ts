import { canonicalBase64UrlByteLength } from "./protocolV4";
import type { SecureRelayStateV4 } from "./secureRelayV4";

// Timings start at the actual send attempt, not a nominal alarm time. The relay
// cannot distinguish a partitioned device from one whose execution is suspended.
const QUIET_MS = 10_000;
const RETRY_MS = 5_000;
const FINAL_WAIT_MS = 10_000;

export interface HostPathWatch {
  deviceId: string;
  connectionId: string;
  dueAt: number;
  phase: "quiet" | "retry" | "expire";
  nonce: string | null;
}

export function validHostPathWatch(value: unknown): value is HostPathWatch {
  if (typeof value !== "object" || value === null) return false;
  const w = value as HostPathWatch;
  return canonicalBase64UrlByteLength(w.deviceId) === 16 && canonicalBase64UrlByteLength(w.connectionId) === 16 &&
    Number.isSafeInteger(w.dueAt) && w.dueAt >= 0 && (w.phase === "quiet" ? w.nonce === null :
      (w.phase === "retry" || w.phase === "expire") && canonicalBase64UrlByteLength(w.nonce) === 16);
}

// No monitoring or periodic writes in an empty/solo room. A pending guest
// counts: a host may disappear while another device is waiting for admission.
export function reconcileHostPath(w: HostPathWatch | null, room: SecureRelayStateV4, now: number,
  supports: (deviceId: string, connectionId: string) => boolean): HostPathWatch | null {
  if (room.lifecycle !== "open" || !room.hostDeviceId ||
      !room.members.some(m => m.deviceId !== room.hostDeviceId && m.connectionId !== null)) return null;
  const h = room.members.find(m => m.deviceId === room.hostDeviceId);
  if (!h?.connectionId) return null;
  if (w && w.deviceId === h.deviceId && w.connectionId === h.connectionId) return w;
  return supports(h.deviceId, h.connectionId)
    ? { deviceId: h.deviceId, connectionId: h.connectionId, phase: "quiet", nonce: null, dueAt: now + QUIET_MS }
    : null;
}

// Called only on a due watch. Null means fence this exact socket through the
// existing disconnect transition. No probe, timeout or ACK can change host.
export function advanceHostPath(w: HostPathWatch, now: number, nonce: () => string): HostPathWatch | null {
  if (now < w.dueAt) return w;
  if (w.phase === "expire") return null;
  return w.phase === "quiet"
    ? { ...w, phase: "retry", nonce: nonce(), dueAt: now + RETRY_MS }
    : { ...w, phase: "expire", dueAt: now + FINAL_WAIT_MS };
}

export function acknowledgeHostPath(w: HostPathWatch | null, device: string, connection: string, nonce: string, now: number): HostPathWatch | null {
  if (!w || w.deviceId !== device || w.connectionId !== connection || w.nonce !== nonce ||
      (w.phase === "expire" && now >= w.dueAt)) return w;
  return { ...w, phase: "quiet", nonce: null, dueAt: now + QUIET_MS };
}
