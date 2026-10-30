import { createParticipantAgent, type PillowfortAgent } from './agent';
import { createParticipantStore } from './gameStore';
import { ParticipantEvents } from './events';
import { MemoryCryptoStateStore } from './cryptoStateStore';
import { MemoryRoomCryptoLockCoordinator } from './roomCryptoLock';
import { SecureRoomController } from './secureRoomController';

export interface ParticipantRuntimeOptions {
  baseURL: string;
  createWebSocket: (url: string) => WebSocket;
}

export interface ParticipantRuntime {
  agent: PillowfortAgent;
  controller: SecureRoomController;
  close(): Promise<void>;
}

/** One in-memory identity, using the same controller, MLS engine and actions as the UI. */
export async function createParticipantRuntime({ baseURL, createWebSocket }: ParticipantRuntimeOptions): Promise<ParticipantRuntime> {
  const location = new URL(baseURL);
  const store = createParticipantStore();
  const initialState = store.getState();
  const events = new ParticipantEvents();
  const cryptoStore = new MemoryCryptoStateStore();
  const lockCoordinator = new MemoryRoomCryptoLockCoordinator();
  const sockets = new Set<WebSocket>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const controller = new SecureRoomController({
    store, events, cryptoStore, lockCoordinator,
    location: { protocol: location.protocol, host: location.host },
    recoveryStorage: null,
    createWebSocket(url) {
      if (closed) throw new Error('Participant runtime is closed.');
      const socket = createWebSocket(url);
      sockets.add(socket);
      socket.addEventListener('close', () => sockets.delete(socket), { once: true });
      return socket;
    },
  });
  const agent = createParticipantAgent({ store, controller, events, origin: location.origin, identityStorage: 'isolated-memory' });
  return {
    agent,
    controller,
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        agent.dispose();
        // Invalidate controller generations before delivering socket close callbacks.
        const disconnected = controller.dispose();
        for (const socket of sockets) {
          try { socket.close(1000, 'Participant closed'); } catch { /* Already closed. */ }
        }
        sockets.clear();
        lockCoordinator.close();
        const erased = cryptoStore.close();
        events.clear();
        closing = Promise.all([disconnected, erased]).finally(() => {
          clearTimeout(store.getState().errorTimer ?? undefined);
          store.setState(initialState, true);
        }).then(() => {});
      }
      return closing;
    },
  };
}
