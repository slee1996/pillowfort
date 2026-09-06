import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";

export function RoomRoster() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const hostName = members[0];
  const available: string[] = [];
  const away: string[] = [];

  for (const name of members) {
    (memberPresence[name]?.status === "away" ? away : available).push(name);
  }

  const groups = [
    { label: "Available", names: available },
    { label: "Away", names: away },
  ];

  return (
    <aside id="room-roster" className="room-roster" aria-label="People in this fort">
      {(["desktop", "mobile"] as const).map((layout) => (
        <div
          key={layout}
          className={`roster-${layout}`}
          tabIndex={layout === "mobile" ? 0 : undefined}
          role={layout === "mobile" ? "group" : undefined}
          aria-label={layout === "mobile" ? "Room presence; scroll for more people" : undefined}
        >
          {layout === "desktop" && <h2 className="room-roster-title">Buddies ({members.length})</h2>}
          {groups.map(({ label, names }) => (
            <section key={label} className="roster-group" aria-label={`${label} people`}>
              <h3 className="roster-group-title">{label} ({names.length})</h3>
              <ul className={layout === "desktop" ? "roster-list" : "roster-mobile-list"}>
                {names.map((name) => (
                  <li key={name}>
                    <MemberEntry
                      name={name}
                      isHost={name === hostName}
                      isMuted={mutedNames.has(name)}
                      status={memberPresence[name]?.status}
                      awayText={memberPresence[name]?.awayText}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ))}
    </aside>
  );
}
