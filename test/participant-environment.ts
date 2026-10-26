import { participantStore } from "../client/src/stores/gameStore";
import { participantEvents } from "../client/src/services/ws";
import { CryptoStateStore } from "../src/participant/cryptoStateStore";
import { RoomCryptoLockCoordinator } from "../src/participant/roomCryptoLock";
import type { SecureRoomControllerOptions } from "../src/participant/secureRoomController";

/** Loaded inside the page so controller effects reach the browser test surface. */
export function createControllerEnvironment(): SecureRoomControllerOptions {
  return {
    store: participantStore,
    events: participantEvents,
    cryptoStore: new CryptoStateStore(),
    lockCoordinator: new RoomCryptoLockCoordinator(),
    location,
    createWebSocket: (url) => new WebSocket(url),
    recoveryStorage: sessionStorage,
  };
}
