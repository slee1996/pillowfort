import { useGameStore } from "../../stores/gameStore";

const GAME_ORDER = [
  { key: "pillowFight", label: "Pillow Fight" },
  { key: "rps", label: "RPS" },
  { key: "ttt", label: "Tic-Tac-Toe" },
  { key: "saboteur", label: "Saboteur" },
  { key: "koth", label: "KOTH" },
] as const;

interface LeaderboardsPanelProps {
  compact?: boolean;
  hideTitle?: boolean;
}

export function LeaderboardsPanel({ compact = false, hideTitle = false }: LeaderboardsPanelProps) {
  const leaderboards = useGameStore((s) => s.leaderboards);

  return (
    <div
      className={`leaderboards-panel ${compact ? "leaderboards-panel-compact" : ""}`}
      id={compact ? undefined : "leaderboards-panel"}
    >
      {!hideTitle && <div className="leaderboards-title">Roomwide Leaderboards</div>}
      <div className="leaderboards-grid">
        {GAME_ORDER.map(({ key, label }) => {
          const entries = Object.entries(leaderboards[key])
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, 3);
          return (
            <div key={key} className="leaderboards-card">
              <div className="leaderboards-game">{label}</div>
              {entries.length === 0 ? (
                <div className="leaderboards-empty">No wins yet</div>
              ) : (
                entries.map(([name, score], idx) => (
                  <div key={name} className="leaderboards-entry">
                    <span className="leaderboards-rank">{idx + 1}.</span>
                    <span className="leaderboards-name">{name}</span>
                    <span className="leaderboards-score">{score}</span>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
