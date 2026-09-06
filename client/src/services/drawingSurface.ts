export const DRAWING_WIDTH = 1200;
export const DRAWING_HEIGHT = 800;
export const DRAWING_COLORS: readonly { name: string; value: string }[] = [
  { name: "Black", value: "#000000" },
  { name: "Red", value: "#FF0000" },
  { name: "Blue", value: "#0000FF" },
  { name: "Green", value: "#008000" },
  { name: "Orange", value: "#FF8C00" },
  { name: "Purple", value: "#800080" },
  { name: "Pink", value: "#FF69B4" },
  { name: "Brown", value: "#8B4513" },
];

export type DrawingSurfaceSnapshot = {
  active: boolean;
  color: string;
  width: number;
  height: number;
  canExport: boolean;
  notice: string | null;
};

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
