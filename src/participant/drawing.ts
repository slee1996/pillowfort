export const DRAWING_WIDTH = 1200;
export const DRAWING_HEIGHT = 800;
export const DRAWING_COLORS: readonly { name: string; value: string }[] = [
  { name: "Black", value: "#000000" }, { name: "Red", value: "#FF0000" },
  { name: "Blue", value: "#0000FF" }, { name: "Green", value: "#008000" },
  { name: "Orange", value: "#FF8C00" }, { name: "Purple", value: "#800080" },
  { name: "Pink", value: "#FF69B4" }, { name: "Brown", value: "#8B4513" },
];
export type Point = [number, number];
export type DrawingBatch = { from: string; color: string; pts: Point[]; s?: 1 };
export type DrawingSurfaceSnapshot = { active: boolean; color: string; width: number; height: number; canExport: boolean; notice: string | null };
export interface DrawingInk {
  dot(point: Point, color: string): void;
  path(origin: Point, points: readonly Point[], color: string, skipFirst: boolean): void;
}

/** Applied-event stroke continuity, shared by canvas and bitmap renderers. */
export class DrawingModel {
  private drawers = new Map<string, { point: Point; color: string }>();
  constructor(private ink: DrawingInk) {}
  retainMembers(members: readonly string[]): void {
    for (const name of this.drawers.keys()) if (!members.includes(name)) this.drawers.delete(name);
  }
  apply(value: unknown, members: readonly string[]): boolean {
    if (!value || typeof value !== "object") return false;
    const message = value as DrawingBatch;
    if (typeof message.from !== "string" || !members.includes(message.from) || typeof message.color !== "string" || !validDrawingColor(message.color) ||
        !Array.isArray(message.pts) || message.pts.length < 1 || message.pts.length > 128) return false;
    for (const point of message.pts) if (!Array.isArray(point) || point.length !== 2 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) return false;
    const previous = this.drawers.get(message.from);
    const start = message.s === 1 || !previous || previous.color !== message.color;
    const first = message.pts[0];
    if (start) this.ink.dot(first, message.color);
    this.ink.path(!start && previous ? previous.point : first, message.pts, message.color, start);
    const end = message.pts[message.pts.length - 1];
    this.drawers.set(message.from, { point: [end[0], end[1]], color: message.color });
    return true;
  }
}

export function validDrawingColor(color: string): boolean {
  const hsl = /^hsl\((\d{1,3}), 80%, 65%\)$/u.exec(color);
  return DRAWING_COLORS.some(entry => entry.value === color) || !!hsl && Number(hsl[1]) <= 359;
}

function rgb(color: string): number[] {
  if (color.startsWith("#")) return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const hue = Number(/^hsl\((\d+)/u.exec(color)![1]) / 60;
  const chroma = (1 - Math.abs(2 * 0.65 - 1)) * 0.8;
  const x = chroma * (1 - Math.abs(hue % 2 - 1));
  const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return channels.map(channel => Math.round((channel + 0.65 - chroma / 2) * 255));
}

/** Fixed-size paper, not a DOM/canvas emulation. Round ink uses analytic pixel coverage. */
export class DrawingBitmap implements DrawingInk {
  readonly pixels = new Uint8Array(DRAWING_WIDTH * DRAWING_HEIGHT * 3).fill(255);
  dot(point: Point, color: string): void { this.segment(point, point, rgb(color)); }
  path(origin: Point, points: readonly Point[], color: string, skipFirst: boolean): void {
    const channels = rgb(color);
    let previous = origin;
    for (let index = skipFirst ? 1 : 0; index < points.length; index++) {
      this.segment(previous, points[index], channels);
      previous = points[index];
    }
  }
  private segment(from: Point, to: Point, color: number[]): void {
    const ax = from[0] * DRAWING_WIDTH, ay = from[1] * DRAWING_HEIGHT;
    const bx = to[0] * DRAWING_WIDTH, by = to[1] * DRAWING_HEIGHT;
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const left = Math.max(0, Math.floor(Math.min(ax, bx) - 2));
    const right = Math.min(DRAWING_WIDTH - 1, Math.ceil(Math.max(ax, bx) + 2));
    const top = Math.max(0, Math.floor(Math.min(ay, by) - 2));
    const bottom = Math.min(DRAWING_HEIGHT - 1, Math.ceil(Math.max(ay, by) + 2));
    for (let y = top; y <= bottom; y++) {
      // Only visit this row's capsule extent, not the whole diagonal's rectangle.
      const ta = dy ? Math.max(0, Math.min(1, (y - 1.5 - ay) / dy)) : 0;
      const tb = dy ? Math.max(0, Math.min(1, (y + 2.5 - ay) / dy)) : 1;
      const rowLeft = Math.max(left, Math.floor(Math.min(ax + ta * dx, ax + tb * dx) - 2));
      const rowRight = Math.min(right, Math.ceil(Math.max(ax + ta * dx, ax + tb * dx) + 2));
      for (let x = rowLeft; x <= rowRight; x++) {
        const t = length ? Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / length)) : 0;
        const coverage = Math.max(0, Math.min(1, 2 - Math.hypot(x + 0.5 - ax - t * dx, y + 0.5 - ay - t * dy)));
        if (!coverage) continue;
        const offset = (y * DRAWING_WIDTH + x) * 3;
        for (let c = 0; c < 3; c++) this.pixels[offset + c] = Math.round(this.pixels[offset + c] * (1 - coverage) + color[c] * coverage);
      }
    }
  }
  async exportPng(): Promise<string> {
    const stride = DRAWING_WIDTH * 3;
    const rows = new Uint8Array((stride + 1) * DRAWING_HEIGHT);
    for (let y = 0; y < DRAWING_HEIGHT; y++) rows.set(this.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    const compressed = await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, DRAWING_WIDTH); view.setUint32(4, DRAWING_HEIGHT); header[8] = 8; header[9] = 2;
    const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", new Uint8Array(compressed)), pngChunk("IEND", new Uint8Array())];
    let binary = "";
    for (const chunk of chunks) for (let offset = 0; offset < chunk.length; offset += 8192) binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
    return `data:image/png;base64,${btoa(binary)}`;
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}
