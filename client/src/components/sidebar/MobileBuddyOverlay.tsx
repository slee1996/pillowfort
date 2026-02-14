import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";

export function MobileBuddyOverlay() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("pf-show-mobile-buddies", handler);
    return () => window.removeEventListener("pf-show-mobile-buddies", handler);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="bg-[#ECE9D8] rounded-t-lg rounded-b overflow-hidden shadow-xl w-[260px] max-h-[70vh] flex flex-col">
        <div className="bg-[#ECE9D8] p-1.5 px-2.5 font-bold text-[11px] text-[#333] border-b border-[#ACA899] flex items-center justify-between">
          <span>Buddies ({members.length})</span>
          <button
            className="bg-transparent border-none text-sm cursor-pointer text-[#666] p-0 px-0.5"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-1 flex-1">
          {members.map((name, i) => (
            <MemberEntry
              key={name}
              name={name}
              isHost={i === 0}
              isMuted={mutedNames.has(name)}
              status={memberPresence[name]?.status}
              awayText={memberPresence[name]?.awayText}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
