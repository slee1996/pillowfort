export const MAX_NAME_LEN = 24;
export const MAX_MSG_LEN = 2000;
export const STYLE_COLORS = new Set([
  '#FF0000', '#0000FF', '#008000', '#FF8C00',
  '#800080', '#000000', '#FF69B4', '#8B4513',
]);

export const GRACE_MS = 15_000;
export const MAX_DRAW_POINTS = 128;
export const MAX_DRAW_EVENTS_PER_5S = 40;

export interface SanitizedDraw {
  color: string;
  pts: number[][];
  s?: 1;
}

function validDrawColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (STYLE_COLORS.has(value)) return true;
  const match = /^hsl\((\d{1,3}), 80%, 65%\)$/.exec(value);
  return !!match && Number(match[1]) <= 359;
}

export function sanitizeDraw(input: any): SanitizedDraw | null {
  if (!input || !Array.isArray(input.pts) || input.pts.length < 1 || input.pts.length > MAX_DRAW_POINTS) return null;
  if (!validDrawColor(input.color)) return null;
  const pts: number[][] = [];
  for (const point of input.pts) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    pts.push([x, y]);
  }
  return { color: input.color, pts, ...(input.s === 1 ? { s: 1 as const } : {}) };
}

export function sanitizeStyle(s: any): Record<string, any> | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: Record<string, any> = {};
  if (s.bold === true) out.bold = true;
  if (s.italic === true) out.italic = true;
  if (s.underline === true) out.underline = true;
  if (typeof s.color === 'string' && STYLE_COLORS.has(s.color)) out.color = s.color;
  return Object.keys(out).length ? out : undefined;
}

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (true) {
    const suffix = String(i);
    const candidate = base.slice(0, MAX_NAME_LEN - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
    i++;
  }
}
