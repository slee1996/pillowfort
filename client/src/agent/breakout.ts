export interface BreakoutSnapshot {
  width: number; height: number;
  ball: { x: number; y: number; dx: number; dy: number };
  paddle: { x: number; y: number; w: number; h: number };
  bricks: { x: number; y: number; w: number; h: number; alive: boolean; color: string }[];
  lives: number; score: number; won: boolean; lost: boolean; running: boolean;
}
interface Controls { move(x: number): void; reset(): void; snapshot(): BreakoutSnapshot | null }
let controls: Controls | null = null;
export type ActivityMode = "conversation" | "drawing" | "breakout";
let activity: { drawing(): void; breakout(): void; conversation(): void } | null = null;
export function registerRoomActivities(value: NonNullable<typeof activity>): () => void {
  activity = value;
  return () => { if (activity === value) activity = null; };
}
export function selectRoomActivity(mode: ActivityMode): boolean {
  if (!activity) return false;
  activity[mode]();
  return true;
}
const listeners = new Set<() => void>();
export const agentMode = () => new URLSearchParams(location.search).get("agent") === "1";
export function registerBreakout(value: Controls): () => void {
  controls = value;
  notifyBreakout();
  return () => { if (controls === value) { controls = null; notifyBreakout(); } };
}
export function notifyBreakout(): void { for (const listener of listeners) listener(); }
export function subscribeBreakout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function breakoutSnapshot(): BreakoutSnapshot | null { return controls?.snapshot() ?? null; }
export function moveBreakout(x: number): boolean {
  if (!controls?.snapshot()?.running) return false;
  controls.move(x);
  notifyBreakout();
  return true;
}
export function resetBreakout(): boolean {
  if (!controls) return false;
  controls.reset();
  notifyBreakout();
  return true;
}
