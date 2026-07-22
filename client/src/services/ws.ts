import { RoomCryptoLockCoordinator } from "./roomCryptoLock";
import {
  SecureRoomController,
  type SecureRoomConnectResult,
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

export function disconnect(): void {
  controller.disconnect();
}

export function getWs(): WebSocket | null {
  return controller.webSocket;
}

export function setRoomCryptoLockCoordinatorForTests(coordinator?: RoomCryptoLockCoordinator): void {
  controller.replaceLockCoordinatorForTests(coordinator ?? new RoomCryptoLockCoordinator());
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") controller.reconnectIfNeeded();
  });
}
