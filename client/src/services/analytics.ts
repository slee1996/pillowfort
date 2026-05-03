type AnalyticsEventName =
  | "room_created"
  | "room_joined"
  | "guest_joined"
  | "invite_copied"
  | "first_message_sent"
  | "game_started"
  | "room_knocked_down"
  | "fort_pass_code_checked"
  | "fort_pass_checkout_started"
  | "fort_pass_checkout_failed"
  | "fort_pass_checkout_returned";

type AnalyticsProps = {
  kind?: string;
  role?: "host" | "guest";
  source?: string;
  reason?: string;
  surface?: string;
  memberCount?: number;
  queueDepth?: number;
  status?: number;
  mobile?: boolean;
};

const sentOnce = new Set<string>();

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  if (n < 0 || n > 1000) return undefined;
  return n;
}

function cleanProps(props: AnalyticsProps = {}): AnalyticsProps {
  const out: AnalyticsProps = {};
  const kind = cleanString(props.kind);
  const role = cleanString(props.role);
  const source = cleanString(props.source);
  const reason = cleanString(props.reason);
  const surface = cleanString(props.surface);
  const memberCount = cleanNumber(props.memberCount);
  const queueDepth = cleanNumber(props.queueDepth);
  const status = cleanNumber(props.status);

  if (kind) out.kind = kind;
  if (role === "host" || role === "guest") out.role = role;
  if (source) out.source = source;
  if (reason) out.reason = reason;
  if (surface) out.surface = surface;
  if (memberCount !== undefined) out.memberCount = memberCount;
  if (queueDepth !== undefined) out.queueDepth = queueDepth;
  if (status !== undefined) out.status = status;
  if (typeof props.mobile === "boolean") out.mobile = props.mobile;
  return out;
}

function isMobileViewport(): boolean {
  try {
    return window.matchMedia("(max-width: 600px)").matches;
  } catch {
    return false;
  }
}

export function track(event: AnalyticsEventName, props: AnalyticsProps = {}) {
  const body = JSON.stringify({
    event,
    props: {
      ...cleanProps(props),
      mobile: props.mobile ?? isMobileViewport(),
    },
  });

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/analytics", blob);
      return;
    }
  } catch {}

  try {
    void fetch("/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {}
}

export function trackOnce(key: string, event: AnalyticsEventName, props: AnalyticsProps = {}) {
  if (sentOnce.has(key)) return;
  sentOnce.add(key);
  track(event, props);
}
