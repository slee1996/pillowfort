import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";
import { LeaderboardsPanel } from "../games/LeaderboardsPanel";

interface PeopleDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PeopleDialog({ open, onClose }: PeopleDialogProps) {
  const roomId = useGameStore((s) => s.roomId);
  return open ? <PeopleDialogContent key={roomId} onClose={onClose} /> : null;
}

function PeopleDialogContent({ onClose }: Pick<PeopleDialogProps, "onClose">) {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const [tab, setTab] = useState<"people" | "leaderboard">("people");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const peopleTabRef = useRef<HTMLButtonElement>(null);
  const leaderboardTabRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    peopleTabRef.current?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: typeof tab;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      next = tab === "people" ? "leaderboard" : "people";
    } else if (event.key === "Home") {
      next = "people";
    } else if (event.key === "End") {
      next = "leaderboard";
    } else {
      return;
    }
    event.preventDefault();
    setTab(next);
    (next === "people" ? peopleTabRef : leaderboardTabRef).current?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      className="product-dialog people-dialog"
      aria-labelledby="people-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div className="product-dialog-header">
        <h2 id="people-dialog-title">People in this fort</h2>
        <button type="button" id="btn-close-people" onClick={close}>Close</button>
      </div>
      <div className="product-dialog-body">
        <div className="member-panel-tabs" role="tablist" aria-label="People and leaderboard" onKeyDown={moveTab}>
          <button
            ref={peopleTabRef}
            type="button"
            id="people-tab"
            role="tab"
            aria-selected={tab === "people"}
            aria-controls="people-panel"
            tabIndex={tab === "people" ? 0 : -1}
            className={`member-panel-tab ${tab === "people" ? "active" : ""}`}
            onClick={() => setTab("people")}
          >
            People
          </button>
          <button
            ref={leaderboardTabRef}
            type="button"
            id="leaderboard-tab"
            role="tab"
            aria-selected={tab === "leaderboard"}
            aria-controls="people-leaderboard-panel"
            tabIndex={tab === "leaderboard" ? 0 : -1}
            className={`member-panel-tab ${tab === "leaderboard" ? "active" : ""}`}
            onClick={() => setTab("leaderboard")}
          >
            Leaderboard
          </button>
        </div>
        <div id="people-panel" role="tabpanel" aria-labelledby="people-tab" hidden={tab !== "people"} tabIndex={0}>
          <ul className="people-list">
            {members.map((name, index) => (
              <li key={name} className="people-member">
                <MemberEntry
                  name={name}
                  isHost={index === 0}
                  isMuted={mutedNames.has(name)}
                  status={memberPresence[name]?.status}
                  awayText={memberPresence[name]?.awayText}
                />
                <p>
                  {index === 0 ? "Host · " : ""}
                  {memberPresence[name]?.status === "away" ? "Away" : "Available"}
                  {mutedNames.has(name) ? " · Muted on this device" : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div id="people-leaderboard-panel" role="tabpanel" aria-labelledby="leaderboard-tab" hidden={tab !== "leaderboard"} tabIndex={0}>
          <LeaderboardsPanel compact hideTitle />
        </div>
      </div>
    </dialog>
  );
}
