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
    const update = () => setRemaining(Math.max(0, Math.ceil((vote.endsAt - Date.now()) / 1000)));
    update();
    setMyVote(null);
    const timer = setInterval(() => {
      update();
      if (Date.now() >= vote.endsAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [vote?.target, vote?.endsAt]);

  if (!vote) return null;

  const isTarget = vote.target === name;

  const castVote = (v: "yes" | "no") => {
    send("cast-vote", { vote: v });
    setMyVote(v);
  };

  return (
    <div id="vote-banner" className="vote-banner visible">
      <div>⚔ <strong>PILLOW FIGHT!</strong> Vote to kick <span className="vote-target-name">{vote.target}</span></div>
      <div id="vote-buttons" className="vote-status">
        {myVote ? (
          <span className={`vote-choice ${myVote === "yes" ? "yes" : "no"}`}>
            Voted: {myVote === "yes" ? "Kick" : "Keep"}
          </span>
        ) : null}
      </div>
      <div className="vote-remaining">{remaining}s remaining</div>
      {!isTarget && !myVote && (
        <div className="auth-actions">
          <Button
            id="vote-yes"
            onClick={() => castVote("yes")}
            style={{ background: "linear-gradient(180deg,#fff,#D4E8D4)", borderColor: "#060" }}
          >
            ✔ Kick
          </Button>
          <Button
            id="vote-no"
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
