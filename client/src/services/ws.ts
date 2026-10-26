import { RoomCryptoLockCoordinator } from "../../../src/participant/roomCryptoLock";
import { CryptoStateStore } from "../../../src/participant/cryptoStateStore";
import { ParticipantEvents } from "../../../src/participant/events";
import { participantStore } from "../stores/gameStore";
import { playDoorClose, playDoorOpen, playMsgSound } from "../hooks/useSound";
import { requestWakeLock } from "../hooks/useWakeLock";
import {
  SecureRoomController,
  type SecureRoomConnectResult,
  type SecureRoomRecoveryHint,
  type SecureRoomStartOptions,
} from "../../../src/participant/secureRoomController";

export const participantEvents = new ParticipantEvents();
for (const name of ["pf-typing", "pf-draw", "pf-drawing-error"]) {
  participantEvents.on(name, (detail) => window.dispatchEvent(new CustomEvent(name, { detail })));
}
participantEvents.on("pf-sound", (detail) => {
  if (!detail || typeof detail !== "object" || !("kind" in detail)) return;
  const kind = detail.kind;
  if (kind === "door-open") playDoorOpen();
  else if (kind === "door-close") playDoorClose();
  else if (kind === "message") playMsgSound();
});
participantEvents.on("pf-wake-lock", () => { void requestWakeLock(); });

function recoveryStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export const participantController = new SecureRoomController({
  store: participantStore,
  events: participantEvents,
  cryptoStore: new CryptoStateStore(),
  lockCoordinator: new RoomCryptoLockCoordinator(),
  location: { get protocol() { return location.protocol; }, get host() { return location.host; } },
  createWebSocket: (url) => new WebSocket(url),
  recoveryStorage: recoveryStorage(),
});

export type SecureConnectResult = SecureRoomConnectResult;

export function setupSecureRoom(options: SecureRoomStartOptions): Promise<SecureRoomConnectResult> {
  return participantController.setup(options);
}

export function joinSecureRoom(options: SecureRoomStartOptions): Promise<SecureRoomConnectResult> {
  return participantController.join(options);
}

export function send(type: string, payload: Record<string, unknown> = {}): boolean {
  return participantController.sendUiAction(type, payload);
}

export function disconnect(): Promise<void> {
  return participantController.disconnect();
}

export function cancelSecureRoomConnection(): Promise<boolean> {
  return participantController.cancelPendingConnection();
}

export function getWs(): WebSocket | null {
  return participantController.webSocket;
}

export function getSecureRoomRecovery(): SecureRoomRecoveryHint | null {
  return participantController.pendingRecovery;
}

export function setRoomCryptoLockCoordinatorForTests(coordinator?: RoomCryptoLockCoordinator): Promise<void> {
  return participantController.replaceLockCoordinatorForTests(coordinator ?? new RoomCryptoLockCoordinator());
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") participantController.reconnectIfNeeded();
  });
}
