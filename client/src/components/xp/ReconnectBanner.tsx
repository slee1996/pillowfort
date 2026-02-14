import { useGameStore } from "../../stores/gameStore";

export function ReconnectBanner() {
  const reconnecting = useGameStore((s) => s.reconnecting);
  const attempts = useGameStore((s) => s.reconnectAttempts);

  if (!reconnecting) return null;

  return (
    <div className="reconnect-banner">
      Reconnecting... (attempt {attempts}/3)
    </div>
  );
}
