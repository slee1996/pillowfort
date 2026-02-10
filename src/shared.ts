export const MAX_NAME_LEN = 24;
export const MAX_MSG_LEN = 2000;
export const STYLE_COLORS = new Set([
  '#FF0000', '#0000FF', '#008000', '#FF8C00',
  '#800080', '#000000', '#FF69B4', '#8B4513',
]);

// Allow test override via env
export const GRACE_MS = (() => {
  try { return parseInt(process.env.PILLOWFORT_GRACE_MS || "15000"); }
  catch { return 15_000; }
})();

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
