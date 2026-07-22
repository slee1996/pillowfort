import { readByteLimitedText } from "./requestBody";

export const ANALYTICS_EVENTS = [
  "room_created",
  "room_joined",
  "guest_joined",
  "invite_copied",
  "first_message_sent",
  "game_started",
  "room_knocked_down",
  "activation_nudge_shown",
  "activation_nudge_clicked",
  "fort_pass_code_checked",
  "fort_pass_status_checked",
  "fort_pass_checkout_started",
  "fort_pass_checkout_failed",
  "fort_pass_checkout_returned",
  "discord_activity_detected",
  "probe_blocked",
  "stripe_webhook_failed",
  "ws_rejected",
  "room_setup_failed",
  "room_join_failed",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

// Only configuration/commerce events that happen outside a room may be
// submitted by a browser. Room lifecycle, membership, invitations, messages,
// and games are protected application metadata in protocol v4. Operational
// events below are emitted by trusted server code through opsLogLine instead.
export const PUBLIC_ANALYTICS_EVENTS = [
  "fort_pass_code_checked",
  "fort_pass_status_checked",
  "fort_pass_checkout_started",
  "fort_pass_checkout_failed",
  "fort_pass_checkout_returned",
  "discord_activity_detected",
] as const satisfies readonly AnalyticsEventName[];

export interface SanitizedAnalyticsEvent {
  event: AnalyticsEventName;
  props: Record<string, string | number | boolean>;
}

const EVENT_SET = new Set<string>(ANALYTICS_EVENTS);
const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_ANALYTICS_EVENTS);
const STRING_PROPS = new Set(["kind", "role", "source", "reason", "surface"]);
const NUMBER_PROPS = new Set(["memberCount", "queueDepth", "status"]);
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

export function sanitizePublicAnalyticsEvent(input: unknown): SanitizedAnalyticsEvent | null {
  const event = sanitizeAnalyticsEvent(input);
  return event && PUBLIC_EVENT_SET.has(event.event) ? event : null;
}

export async function readAnalyticsEvent(request: Request): Promise<SanitizedAnalyticsEvent | null> {
  const body = await readByteLimitedText(request, MAX_BODY_BYTES);
  if (!body.ok || !body.text) return null;

  try {
    return sanitizePublicAnalyticsEvent(JSON.parse(body.text));
  } catch {
    return null;
  }
}

export function analyticsLogLine(event: SanitizedAnalyticsEvent): string {
  return `[analytics] ${JSON.stringify(event)}`;
}

export function opsLogLine(event: AnalyticsEventName, props: Record<string, unknown> = {}): string {
  const sanitized = sanitizeAnalyticsEvent({ event, props });
  return analyticsLogLine(sanitized || { event, props: {} });
}
