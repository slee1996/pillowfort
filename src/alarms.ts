export type RoomAlarmKind = "idle" | "sab-bomb" | "auth-sockets" | "secure-relay" | "offer-delivery";
export type RoomAlarmSchedule = Partial<Record<RoomAlarmKind, number>>;

const DUE_PRIORITY: RoomAlarmKind[] = ["sab-bomb", "auth-sockets", "secure-relay", "offer-delivery", "idle"];

export function normalizeRoomAlarmSchedule(input: unknown): RoomAlarmSchedule {
  const raw = input && typeof input === "object" ? input as RoomAlarmSchedule : {};
  const schedule: RoomAlarmSchedule = {};
  for (const kind of DUE_PRIORITY) {
    const deadline = raw[kind];
    if (typeof deadline === "number" && Number.isFinite(deadline)) schedule[kind] = deadline;
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
