import { detectNativeWebMcp } from "./webmcp";

import type { BreakoutSnapshot } from "../../../src/participant/breakout";
import type { ActivityMode } from "../../../src/participant/activities";
interface Controls { move(x: number): void; reset(): void; snapshot(): BreakoutSnapshot | null }
let controls: Controls | null = null;
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
export const agentMode = () => new URLSearchParams(location.search).get("agent") === "1" || detectNativeWebMcp() !== null;
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
