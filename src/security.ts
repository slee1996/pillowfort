import { opsLogLine } from "./analytics";
import type { AnalyticsEventName } from "./analytics";

export type SecurityHeaderMode = "default" | "discord-activity";

function contentSecurityPolicy(mode: SecurityHeaderMode): string {
  const frameAncestors = mode === "discord-activity"
    ? "frame-ancestors https://discord.com https://canary.discord.com https://ptb.discord.com"
    : "frame-ancestors 'none'";

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    frameAncestors,
    "form-action 'self' https://checkout.stripe.com",
    "navigate-to 'self' https://checkout.stripe.com",
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

function securityHeaderEntries(mode: SecurityHeaderMode): [string, string][] {
  const entries: [string, string][] = [
    ["content-security-policy", contentSecurityPolicy(mode)],
    ["cross-origin-opener-policy", "same-origin"],
    ["permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()"],
    ["origin-agent-cluster", "?1"],
    ["referrer-policy", "no-referrer"],
    ["strict-transport-security", "max-age=31536000; includeSubDomains; preload"],
    ["x-dns-prefetch-control", "off"],
    ["x-content-type-options", "nosniff"],
    ["x-permitted-cross-domain-policies", "none"],
    ["x-xss-protection", "0"],
  ];

  if (mode === "default") {
    entries.push(["cross-origin-resource-policy", "same-origin"]);
    entries.push(["x-frame-options", "DENY"]);
  }
  return entries;
}

const DOTFILE_SEGMENTS = new Set([
  ".env",
  ".env.dev",
  ".env.local",
  ".env.prod",
  ".env.production",
  ".env.stage",
  ".env.staging",
  ".env.bak",
  ".env.swp",
  ".git",
  ".htaccess",
  ".htpasswd",
  ".npmrc",
]);

const SECURITY_LOG_WINDOW_MS = 60_000;
const SECURITY_LOGS_PER_WINDOW = 20;
const MAX_SECURITY_LOG_BUCKETS = 64;
const securityLogBuckets = new Map<string, number[]>();

export function logRateLimitedOpsEvent(
  bucket: string,
  event: AnalyticsEventName,
  props: Record<string, unknown>,
  now = Date.now(),
): boolean {
  if (!/^[a-z0-9_-]{1,64}$/u.test(bucket)) return false;
  const cutoff = now - SECURITY_LOG_WINDOW_MS;
  for (const [key, timestamps] of securityLogBuckets) {
    const recent = timestamps.filter(timestamp => Number.isFinite(timestamp) && timestamp > cutoff && timestamp <= now);
    if (recent.length) securityLogBuckets.set(key, recent);
    else securityLogBuckets.delete(key);
  }
  const recent = securityLogBuckets.get(bucket) || [];
  if (recent.length >= SECURITY_LOGS_PER_WINDOW
    || (!securityLogBuckets.has(bucket) && securityLogBuckets.size >= MAX_SECURITY_LOG_BUCKETS)) return false;
  securityLogBuckets.set(bucket, [...recent, now]);
  console.log(opsLogLine(event, props));
  return true;
}

function decodePathname(pathname: string): string {
  let current = pathname;
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

export function probeReasonForPath(pathname: string): string | null {
  const path = decodePathname(pathname).replace(/\\/g, "/").toLowerCase();
  const segments = path.split("/").filter(Boolean);

  if (path.includes("..")) return "traversal";
  if (segments.some((segment) => segment.startsWith(".") || DOTFILE_SEGMENTS.has(segment) || segment.startsWith(".env."))) {
    return "dotfile";
  }
  if (segments.includes("wp-admin") || segments.includes("wp-content") || segments.includes("wp-includes")) {
    return "wordpress";
  }
  if (segments.includes("cgi-bin")) return "cgi";
  if (segments.includes("_profiler") || path.includes("phpinfo")) return "profiler";
  if (segments.some((segment) => segment.endsWith(".php"))) return "php";
  if (segments.includes("server-status") || segments.includes("vendor")) return "scanner";
  return null;
}

export function blockedProbeResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export function logBlockedProbe(pathname: string, surface = "http"): boolean {
  const reason = probeReasonForPath(pathname);
  if (!reason) return false;
  return logRateLimitedOpsEvent(
    `probe-${surface.replace(/[^a-z0-9_-]/giu, "-").slice(0, 40)}`,
    "probe_blocked",
    { reason, surface, status: 404 },
  );
}

export function isDiscordActivityRequest(request: Request): boolean {
  const url = new URL(request.url);
  // Framing is a server-side trust decision, so never derive it from
  // attacker-controlled launch-looking query parameters. Discord embeds must
  // use the dedicated route; ordinary room and home pages remain unframeable
  // even when a caller appends frame_id or discord_activity.
  return url.pathname === "/activity";
}

export function withSecurityHeaders(response: Response, mode: SecurityHeaderMode = "default"): Response {
  // `webSocket` is a Cloudflare Response extension, not part of the standard
  // ResponseInit copy algorithm. Passing a Response object as ResponseInit can
  // therefore turn an accepted upgrade into a 101 response with no socket.
  const acceptedWebSocket = response.webSocket;
  const next = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    ...(acceptedWebSocket ? { webSocket: acceptedWebSocket } : {}),
  });
  // Bun's test Response currently accepts but does not expose the Cloudflare
  // extension. Keep its observable contract faithful without changing the
  // Cloudflare path, where the constructor above preserves the native socket.
  if (acceptedWebSocket && next.webSocket !== acceptedWebSocket) {
    Object.defineProperty(next, "webSocket", {
      configurable: true,
      value: acceptedWebSocket,
    });
  }
  for (const [key, value] of securityHeaderEntries(mode)) {
    next.headers.set(key, value);
  }
  if ((next.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
    // Protocol upgrades deliberately invalidate old clients. Never let an HTML
    // shell pin stale cryptographic code while immutable hashed assets remain
    // cacheable under their own response metadata.
    next.headers.set("cache-control", "no-store");
  }
  if (mode === "discord-activity") next.headers.delete("x-frame-options");
  return next;
}
