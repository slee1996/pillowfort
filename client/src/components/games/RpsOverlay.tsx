import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { Button } from "../xp/Button";
import type { RpsPick } from "../../services/protocol";

const RPS_EMOJI: Record<string, string> = { rock: "✊", paper: "🖐️", scissors: "✌️" };

export function RpsOverlay() {
  const rps = useGameStore((s) => s.rpsState);
  const name = useGameStore((s) => s.name);

  if (!rps) return null;

  const close = () => useGameStore.getState().setRpsState(null);

  // Phase: challenged (accept/decline)
  if (rps.phase === "challenged" && rps.challengedBy) {
    return (
      <div className="game-overlay">
        <div className="game-dialog">
          <div className="xp-title-bar"><div className="xp-title-text">✊ Rock Paper Scissors</div></div>
          <div className="game-dialog-body">
            <div>{rps.challengedBy} challenges you to RPS!</div>
            <div className="flex gap-2 mt-3.5 justify-center">
              <Button primary onClick={() => send("rps-accept")}>Accept</Button>
              <Button onClick={() => { send("rps-decline"); close(); }}>Decline</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Phase: picking
  if (rps.phase === "picking") {
    const opponent = rps.p1 === name ? rps.p2 : rps.p1;
    return (
      <div className="game-overlay">
        <div className="game-dialog">
          <div className="xp-title-bar"><div className="xp-title-text">✊ Rock Paper Scissors</div></div>
          <div className="game-dialog-body">
            <div>RPS vs {opponent}{rps.koth ? " 👑 for the crown!" : ""} — pick your weapon!</div>
            {!rps.myPick ? (
              <div className="my-3">
                {(["rock", "paper", "scissors"] as RpsPick[]).map((pick) => (
                  <span
                    key={pick}
                    className="rps-pick"
                    title={pick}
                    onClick={() => {
                      useGameStore.getState().setRpsState({ ...rps, myPick: pick });
                      send("rps-pick", { pick });
                    }}
                  >
                    {RPS_EMOJI[pick]}
                  </span>
                ))}
              </div>
            ) : (
              <div className="my-3 text-[#888] italic">Waiting for opponent...</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Phase: result
  if (rps.phase === "result" && rps.result) {
    const { pick1, pick2, winner } = rps.result;
    const line = `${rps.p1} ${RPS_EMOJI[pick1]} vs ${RPS_EMOJI[pick2]} ${rps.p2}`;
    return (
      <div className="game-overlay">
        <div className="game-dialog">
          <div className="xp-title-bar"><div className="xp-title-text">✊ Rock Paper Scissors</div></div>
          <div className="game-dialog-body">
            <div className="text-base font-bold my-2">
              {line}<br />{winner ? `${winner} wins!${rps.koth ? " 👑" : ""}` : "Draw!"}
            </div>
            <div className="flex gap-2 mt-3.5 justify-center">
              <Button onClick={close}>OK</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
