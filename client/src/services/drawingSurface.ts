import { DRAWING_COLORS, type DrawingSurfaceSnapshot } from "../../../src/participant/drawing";

type DrawingSurface = {
  snapshot: () => DrawingSurfaceSnapshot;
  setColor: (color: string) => void;
  exportPng: () => Promise<string>;
};

let surface: DrawingSurface | null = null;
const listeners = new Set<() => void>();

export function notifyDrawingSurface(): void {
  for (const listener of listeners) listener();
}

export function registerDrawingSurface(next: DrawingSurface): () => void {
  surface = next;
  notifyDrawingSurface();
  return () => {
    if (surface !== next) return;
    surface = null;
    notifyDrawingSurface();
  };
}

export function getDrawingSurfaceSnapshot(): DrawingSurfaceSnapshot | null {
  return surface?.snapshot() ?? null;
}

export function setDrawingColor(color: string): boolean {
  if (!surface || !DRAWING_COLORS.some((entry) => entry.value === color)) return false;
  surface.setColor(color);
  return true;
}

export async function exportDrawingPng(): Promise<string> {
  if (!surface?.snapshot().canExport) throw new Error("The shared drawing is not ready to save.");
  return surface.exportPng();
}

export function subscribeDrawingSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
