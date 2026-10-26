import { createBreakout, moveBreakoutPaddle, stepBreakout, breakoutResultMessage, type BreakoutSnapshot } from "./breakout";
import { DrawingBitmap, DrawingModel, DRAWING_COLORS, DRAWING_WIDTH, DRAWING_HEIGHT, type DrawingSurfaceSnapshot } from "./drawing";
import type { ParticipantStore } from "./gameStore";
import type { ParticipantEvents } from "./events";
import type { SecureRoomController } from "./secureRoomController";
export type ActivityMode = "conversation" | "drawing" | "breakout";
export interface ParticipantActivities {
  selectRoomActivity(mode: ActivityMode): boolean;
  breakoutSnapshot(): BreakoutSnapshot | null;
  moveBreakout(x: number): boolean;
  resetBreakout(): boolean;
  subscribeBreakout(listener: () => void): () => void;
  getDrawingSurfaceSnapshot(): DrawingSurfaceSnapshot | null;
  setDrawingColor(color: string): boolean;
  exportDrawingPng(): Promise<string>;
  subscribeDrawingSurface(listener: () => void): () => void;
  dispose(): void;
}

export function createParticipantActivities({ store, events, controller }: {
  store: ParticipantStore; events: ParticipantEvents; controller: SecureRoomController;
}): ParticipantActivities {
  let mode: ActivityMode = "conversation";
  let game: BreakoutSnapshot | null = null;
  let bitmap: DrawingBitmap | null = null;
  let drawing: DrawingModel | null = null;
  let color = "#000000";
  let notice: string | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const breakoutListeners = new Set<() => void>();
  const drawingListeners = new Set<() => void>();
  const notifyBreakout = () => { for (const listener of breakoutListeners) listener(); };
  const notifyDrawing = () => { for (const listener of drawingListeners) listener(); };
  const stop = () => { clearInterval(timer); timer = undefined; game = null; };
  const initializeDrawing = () => {
    if (!bitmap) { bitmap = new DrawingBitmap(); drawing = new DrawingModel(bitmap); }
  };
  if (store.getState().roomId) initializeDrawing();
  const subscriptions = [
    store.subscribe((state, previous) => {
      if (state.roomId !== previous.roomId) {
        stop(); mode = "conversation"; bitmap = null; drawing = null; color = "#000000"; notice = null;
        if (state.roomId) initializeDrawing();
        notifyBreakout(); notifyDrawing();
      }
      if (state.members !== previous.members) drawing?.retainMembers(state.members);
    }),
    events.on("pf-draw", value => {
      if (store.getState().roomId && drawing?.apply(value, store.getState().members)) notifyDrawing();
    }),
    events.on("pf-drawing-error", () => {
      notice = "Some ink could not be shared. Wait for secure delivery or device approval to finish, then start a new stroke.";
      notifyDrawing();
    }),
  ];
  const start = () => {
    stop(); game = createBreakout(800, 600);
    let last = performance.now();
    let accumulated = 0;
    let lastNotify = last;
    timer = setInterval(() => {
      const now = performance.now();
      accumulated += now - last; last = now;
      while (game && accumulated >= 1000 / 60) {
        accumulated -= 1000 / 60;
        stepBreakout(game, effect => {
          if ((effect === "won" || effect === "lost") && game) controller.sendUiAction("chat", { text: breakoutResultMessage(game) });
        });
        if (game.won || game.lost) { clearInterval(timer); timer = undefined; notifyBreakout(); break; }
      }
      if (now - lastNotify >= 100) { lastNotify = now; notifyBreakout(); }
    }, 1000 / 60);
    notifyBreakout();
  };
  return {
    selectRoomActivity(next) {
      if (disposed || !store.getState().roomId) return false;
      if (next !== mode) {
        if (next === "breakout") start(); else { stop(); notifyBreakout(); }
        mode = next; notifyDrawing();
      }
      return true;
    },
    breakoutSnapshot: () => game ? { ...game, ball: { ...game.ball }, paddle: { ...game.paddle }, bricks: game.bricks.map(brick => ({ ...brick })) } : null,
    moveBreakout(x) { if (!game?.running || disposed) return false; moveBreakoutPaddle(game, x); notifyBreakout(); return true; },
    resetBreakout() { if (!game || disposed) return false; start(); return true; },
    subscribeBreakout(listener) { breakoutListeners.add(listener); return () => { breakoutListeners.delete(listener); }; },
    getDrawingSurfaceSnapshot: () => bitmap ? { active: mode === "drawing", color, width: DRAWING_WIDTH, height: DRAWING_HEIGHT, canExport: !disposed, notice } : null,
    setDrawingColor(value) { if (!bitmap || disposed || !DRAWING_COLORS.some(entry => entry.value === value)) return false; color = value; notifyDrawing(); return true; },
    async exportDrawingPng() { if (!bitmap || disposed) throw new Error("The shared drawing is not ready to save."); return bitmap.exportPng(); },
    subscribeDrawingSurface(listener) { drawingListeners.add(listener); return () => { drawingListeners.delete(listener); }; },
    dispose() {
      if (disposed) return;
      disposed = true; stop(); bitmap = null; drawing = null;
      for (const unsubscribe of subscriptions) unsubscribe();
      breakoutListeners.clear(); drawingListeners.clear();
    },
  };
}
