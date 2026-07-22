export type RoomAlarmKind = "idle" | "sab-bomb" | "auth-sockets" | "secure-relay";
export type RoomAlarmSchedule = Partial<Record<RoomAlarmKind, number>>;

const DUE_PRIORITY: RoomAlarmKind[] = ["sab-bomb", "auth-sockets", "secure-relay", "idle"];

export function normalizeRoomAlarmSchedule(input: unknown): RoomAlarmSchedule {
  const raw = input && typeof input === "object" ? input as RoomAlarmSchedule : {};
  const schedule: RoomAlarmSchedule = {};
  if (typeof raw.idle === "number" && Number.isFinite(raw.idle)) schedule.idle = raw.idle;
  if (typeof raw["sab-bomb"] === "number" && Number.isFinite(raw["sab-bomb"])) {
    schedule["sab-bomb"] = raw["sab-bomb"];
  }
  if (typeof raw["auth-sockets"] === "number" && Number.isFinite(raw["auth-sockets"])) {
    schedule["auth-sockets"] = raw["auth-sockets"];
  }
  if (typeof raw["secure-relay"] === "number" && Number.isFinite(raw["secure-relay"])) {
    schedule["secure-relay"] = raw["secure-relay"];
  }
  return schedule;
}

export function nextRoomAlarmDeadline(schedule: RoomAlarmSchedule): number | null {
  const deadlines = Object.values(normalizeRoomAlarmSchedule(schedule));
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function firstDueRoomAlarm(schedule: RoomAlarmSchedule, now: number): RoomAlarmKind | null {
  const clean = normalizeRoomAlarmSchedule(schedule);
  for (const kind of DUE_PRIORITY) {
    const deadline = clean[kind];
    if (typeof deadline === "number" && deadline <= now) return kind;
  }
  return null;
}
