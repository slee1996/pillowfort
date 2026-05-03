export const ANALYTICS_EVENTS = [
  "room_created",
  "room_joined",
  "guest_joined",
  "invite_copied",
  "first_message_sent",
  "game_started",
  "room_knocked_down",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export interface SanitizedAnalyticsEvent {
  event: AnalyticsEventName;
  props: Record<string, string | number | boolean>;
}

const EVENT_SET = new Set<string>(ANALYTICS_EVENTS);
const STRING_PROPS = new Set(["kind", "role", "source"]);
const NUMBER_PROPS = new Set(["memberCount", "queueDepth"]);
const BOOLEAN_PROPS = new Set(["mobile"]);
const MAX_BODY_BYTES = 2048;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function cleanNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  if (n < 0 || n > 1000) return null;
  return n;
}

export function sanitizeAnalyticsEvent(input: unknown): SanitizedAnalyticsEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { event?: unknown; props?: unknown };
  const event = cleanString(raw.event);
  if (!event || !EVENT_SET.has(event)) return null;

  const props: Record<string, string | number | boolean> = {};
  const rawProps = raw.props && typeof raw.props === "object"
    ? raw.props as Record<string, unknown>
    : {};

  for (const [key, value] of Object.entries(rawProps)) {
    if (STRING_PROPS.has(key)) {
      const clean = cleanString(value);
      if (clean) props[key] = clean;
      continue;
    }

    if (NUMBER_PROPS.has(key)) {
      const clean = cleanNumber(value);
      if (clean !== null) props[key] = clean;
      continue;
    }

    if (BOOLEAN_PROPS.has(key) && typeof value === "boolean") {
      props[key] = value;
    }
  }

  return { event: event as AnalyticsEventName, props };
}

export async function readAnalyticsEvent(request: Request): Promise<SanitizedAnalyticsEvent | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return null;

  const text = await request.text();
  if (!text || text.length > MAX_BODY_BYTES) return null;

  try {
    return sanitizeAnalyticsEvent(JSON.parse(text));
  } catch {
    return null;
  }
}

export function analyticsLogLine(event: SanitizedAnalyticsEvent): string {
  return `[analytics] ${JSON.stringify(event)}`;
}
