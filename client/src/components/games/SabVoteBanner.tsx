import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { buddyIconColor } from "../../utils/nameColor";

export function SabVoteBanner() {
  const sabVoteActive = useGameStore((s) => s.sabVoteActive);
  const members = useGameStore((s) => s.members);
  const [remaining, setRemaining] = useState(30);

  useEffect(() => {
    if (!sabVoteActive) return;
    setRemaining(30);
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
  }, [sabVoteActive]);

  if (!sabVoteActive) return null;

  const vote = (suspect: string) => {
    send("sab-vote", { suspect });
    useGameStore.getState().setSabVoteActive(false);
    useGameStore.getState().addSystemMessage(`You voted for ${suspect}.`);
  };

  return (
    <div className="sab-vote-banner">
      <div>🕵 <strong>SABOTEUR VOTE!</strong> Who is the saboteur?</div>
      <div className="sab-vote-options">
        {members.map((name) => (
          <div
            key={name}
            className="member-picker-item"
            onClick={() => vote(name)}
          >
            <span className="buddy-icon" style={{ background: buddyIconColor(name) }} />
            <span>{name}</span>
          </div>
        ))}
      </div>
      <div className="vote-remaining">{remaining}s</div>
    </div>
  );
}
