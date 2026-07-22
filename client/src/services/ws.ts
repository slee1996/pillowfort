import { RoomCryptoLockCoordinator } from "./roomCryptoLock";
import {
  SecureRoomController,
  type SecureRoomConnectResult,
  type SecureRoomRecoveryHint,
  type SecureRoomStartOptions,
} from "./secureRoomController";

const controller = new SecureRoomController();

export type SecureConnectResult = SecureRoomConnectResult;

export function setupSecureRoom(options: SecureRoomStartOptions): Promise<SecureRoomConnectResult> {
  return controller.setup(options);
}

export function joinSecureRoom(options: SecureRoomStartOptions): Promise<SecureRoomConnectResult> {
  return controller.join(options);
}

export function send(type: string, payload: Record<string, unknown> = {}): boolean {
  return controller.sendUiAction(type, payload);
}

export function disconnect(): Promise<void> {
  return controller.disconnect();
}

export function cancelSecureRoomConnection(): Promise<boolean> {
  return controller.cancelPendingConnection();
}

export function getWs(): WebSocket | null {
  return controller.webSocket;
}

export function getSecureRoomRecovery(): SecureRoomRecoveryHint | null {
  return controller.pendingRecovery;
}

export function setRoomCryptoLockCoordinatorForTests(coordinator?: RoomCryptoLockCoordinator): Promise<void> {
  return controller.replaceLockCoordinatorForTests(coordinator ?? new RoomCryptoLockCoordinator());
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") controller.reconnectIfNeeded();
  });
}
