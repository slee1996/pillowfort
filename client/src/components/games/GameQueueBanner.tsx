import { useGameStore } from "../../stores/gameStore";
import type { GameQueueItem } from "../../services/protocol";

function describe(item: GameQueueItem): string {
  switch (item.kind) {
    case "vote":
      return `Pillow Fight: ${item.by} vs ${item.target || "?"}`;
    case "rps":
      return `RPS: ${item.by} vs ${item.target || "?"}`;
    case "ttt":
      return `TTT: ${item.by} vs ${item.target || "?"}`;
    case "saboteur":
      return `Saboteur started by ${item.by}`;
    case "koth":
      return `KOTH challenge by ${item.by}`;
  }
}

export function GameQueueBanner() {
  const gameQueue = useGameStore((s) => s.gameQueue);
  if (!gameQueue.current && gameQueue.queue.length === 0) return null;

  return (
    <div className="game-queue-banner" id="game-queue-banner">
      <div className="game-queue-now">
        {gameQueue.current ? (
          <>Now playing: <strong>{describe(gameQueue.current)}</strong></>
        ) : (
          <>No active game.</>
        )}
      </div>
      {gameQueue.queue.length > 0 && (
        <div className="game-queue-next">
          Up next: {gameQueue.queue.map(describe).join(" • ")}
        </div>
      )}
    </div>
  );
}
