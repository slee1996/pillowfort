import { useGameStore } from "../stores/gameStore";
import { handleMessage } from "./messageHandler";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connect(roomId: string, onOpen: () => void) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?room=${roomId}`);
  ws.onopen = onOpen;
  ws.onclose = () => onDisconnect();
  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch {}
  };
}

export function send(type: string, payload: Record<string, unknown> = {}) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

export function disconnect() {
  try {
    ws?.close();
  } catch {}
  ws = null;
}

export function getWs(): WebSocket | null {
  return ws;
}

function onDisconnect() {
  const store = useGameStore.getState();

  if (store.intentionalLeave || !store.roomId) {
    if (store.roomId) {
      store.setScreen("knocked");
    }
    store.cleanup();
    return;
  }

  // unexpected disconnect — try reconnecting
  if (!store.reconnecting) {
    store.setReconnecting(true);
    store.setReconnectAttempts(0);
    attemptReconnect();
  }
}

function attemptReconnect() {
  const store = useGameStore.getState();

  if (store.reconnectAttempts >= 3) {
    store.setReconnecting(false);
    store.setScreen("knocked");
    store.cleanup();
    return;
  }

  const delay = Math.pow(2, store.reconnectAttempts) * 1000;
  store.setReconnectAttempts(store.reconnectAttempts + 1);

  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(() => {
    const s = useGameStore.getState();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const newWs = new WebSocket(`${proto}//${location.host}/ws?room=${s.roomId}`);

    newWs.onopen = () => {
      ws = newWs;
      newWs.onmessage = (e) => {
        try {
          handleMessage(JSON.parse(e.data));
        } catch {}
      };
      newWs.onclose = () => onDisconnect();
      newWs.send(
        JSON.stringify({
          type: "rejoin",
          name: s.name,
          password: s.password,
          room: s.roomId,
        })
      );
    };

    newWs.onerror = () => {};
    newWs.onclose = () => {
      if (useGameStore.getState().reconnecting) attemptReconnect();
    };
  }, delay);
}

// Re-check connection on visibility change
document.addEventListener("visibilitychange", () => {
  const store = useGameStore.getState();
  if (document.visibilityState === "visible" && store.roomId) {
    if (ws?.readyState !== WebSocket.OPEN && !store.reconnecting) {
      store.setReconnecting(true);
      store.setReconnectAttempts(0);
      attemptReconnect();
    }
  }
});
