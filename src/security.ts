import { opsLogLine } from "./analytics";

const SECURITY_HEADER_ENTRIES: [string, string][] = [
  ["content-security-policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com",
    "navigate-to 'self' https://checkout.stripe.com",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "manifest-src 'self'",
  ].join("; ")],
  ["cross-origin-opener-policy", "same-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["strict-transport-security", "max-age=31536000; includeSubDomains; preload"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
];

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
  if (segments.some((segment) => DOTFILE_SEGMENTS.has(segment) || segment.startsWith(".env."))) {
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

export function logBlockedProbe(pathname: string, surface = "http") {
  const reason = probeReasonForPath(pathname);
  if (!reason) return;
  console.log(opsLogLine("probe_blocked", { reason, surface, status: 404 }));
}

export function withSecurityHeaders(response: Response): Response {
  const next = new Response(response.body, response);
  for (const [key, value] of SECURITY_HEADER_ENTRIES) {
    next.headers.set(key, value);
  }
  return next;
}
