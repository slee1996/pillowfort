import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";

export function SabVoteBanner() {
  const sabVote = useGameStore((s) => s.sabVote);
  const [remaining, setRemaining] = useState(30);

  useEffect(() => {
    if (!sabVote) return;
    const totalSeconds = Math.max(1, Math.ceil(sabVote.duration / 1000));
    setRemaining(totalSeconds);
    const timer = setInterval(() => {
      const next = Math.max(0, Math.ceil((sabVote.endsAt - Date.now()) / 1000));
      setRemaining(next);
      if (next <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [sabVote?.endsAt, sabVote?.duration]);

  if (!sabVote) return null;

  const vote = (choice: "yes" | "no") => {
    send("sab-vote", { vote: choice });
    useGameStore.getState().setSabVoteChoice(choice);
    useGameStore.getState().addSystemMessage(`You voted ${choice.toUpperCase()} on accusing ${sabVote.suspect}.`);
  };

  return (
    <div id="sab-vote-banner" className="sab-vote-banner visible">
      <div>🕵 <strong>ACCUSATION VOTE!</strong> {sabVote.accuser} accused <strong>{sabVote.suspect}</strong>.</div>
      <div id="sab-vote-list" className="sab-vote-options">
        <button className="xp-btn" onClick={() => vote("yes")} disabled={sabVote.myVote === "yes"}>
          ✅ Yes, guilty
        </button>
        <button className="xp-btn" onClick={() => vote("no")} disabled={sabVote.myVote === "no"}>
          ❌ No, not them
        </button>
      </div>
      <div className="vote-remaining">{remaining}s remaining</div>
    </div>
  );
}
