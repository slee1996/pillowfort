import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { Button } from "../xp/Button";

export function VoteBanner() {
  const vote = useGameStore((s) => s.activeVote);
  const name = useGameStore((s) => s.name);
  const [remaining, setRemaining] = useState(30);
  const [myVote, setMyVote] = useState<string | null>(null);

  useEffect(() => {
    if (!vote) {
      setMyVote(null);
      return;
    }
    setRemaining(30);
    setMyVote(null);
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(timer);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [vote?.target]);

  if (!vote) return null;

  const isTarget = vote.target === name;

  const castVote = (v: "yes" | "no") => {
    send("cast-vote", { vote: v });
    setMyVote(v);
  };

  return (
    <div className="vote-banner">
      <div>⚔ <strong>PILLOW FIGHT!</strong> Vote to kick <span className="font-bold text-[#B22222]">{vote.target}</span></div>
      <div className="text-[11px] text-[#666] my-1.5">
        {myVote ? (
          <span className={`font-bold ${myVote === "yes" ? "text-[#060]" : "text-[#800]"}`}>
            Voted: {myVote === "yes" ? "Kick" : "Keep"}
          </span>
        ) : null}
      </div>
      <div className="text-[10px] text-[#999]">{remaining}s remaining</div>
      {!isTarget && !myVote && (
        <div className="flex gap-2 mt-3 justify-center">
          <Button
            onClick={() => castVote("yes")}
            style={{ background: "linear-gradient(180deg,#fff,#D4E8D4)", borderColor: "#060" }}
          >
            ✔ Kick
          </Button>
          <Button
            onClick={() => castVote("no")}
            style={{ background: "linear-gradient(180deg,#fff,#E8D4D4)", borderColor: "#800" }}
          >
            ✘ Keep
          </Button>
        </div>
      )}
    </div>
  );
}
