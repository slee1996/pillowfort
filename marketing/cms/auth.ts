import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";

export type CmsAdmin = { displayName: string };
export const CMS_SESSION_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE = "__Host-pillowfort-cms";
const LOCAL_SESSION_COOKIE = "pillowfort-cms-local";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export async function getCmsAuthEnvironment(): Promise<Cloudflare.Env | null> {
  try {
    // Cloudflare's platform module is unavailable in the Node-rendered test harness.
    const { env } = await import("cloudflare:workers");
    return env;
  } catch {
    return null;
  }
}

export function cmsAuthSetupError(env: Cloudflare.Env | null): string | null {
  if (!env?.DB) return "Editor login is unavailable. Configure the DB binding and apply the CMS database migrations.";
  if (!env.CMS_ADMIN_PASSWORD || env.CMS_ADMIN_PASSWORD.length < 32 || env.CMS_ADMIN_PASSWORD.length > 1024) return "Editor login is unavailable. Set a high-entropy CMS_ADMIN_PASSWORD Worker secret of 32–1024 characters.";
  if (!env.CMS_LOGIN_RATE_LIMITER) return "Editor login is unavailable. Configure the CMS_LOGIN_RATE_LIMITER binding.";
  return null;
}

function isLocalHost(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function cmsSessionCookieName(url: URL): string | null {
  if (url.protocol === "https:") return SESSION_COOKIE;
  return url.protocol === "http:" && isLocalHost(url.host) ? LOCAL_SESSION_COOKIE : null;
}

export function cmsSessionToken(cookie: string | null, name: string): string | null {
  if (!cookie || cookie.length > 16384) return null;
  const matches = cookie.split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(token) ? token : null;
}

export function cmsSessionCookie(name: string, token: string, expiresAt: number): string {
  const maxAge = token ? CMS_SESSION_SECONDS : 0;
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}${name === SESSION_COOKIE ? "; Secure" : ""}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashCmsSession(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

export async function verifyCmsPassword(password: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(password)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

export async function createCmsSession(env: Cloudflare.Env, oldToken: string | null): Promise<{ token: string; expiresAt: number }> {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const expiresAt = now + CMS_SESSION_SECONDS * 1000;
  const statements = [env.DB.prepare("DELETE FROM cms_sessions WHERE expires_at <= ?").bind(now)];
  if (oldToken) statements.push(env.DB.prepare("DELETE FROM cms_sessions WHERE token_hash = ?").bind(await hashCmsSession(oldToken)));
  statements.push(env.DB.prepare("INSERT INTO cms_sessions (token_hash, expires_at) VALUES (?, ?)").bind(await hashCmsSession(token), expiresAt));
  await env.DB.batch(statements);
  return { token, expiresAt };
}

export async function getCmsAdmin(): Promise<CmsAdmin | null> {
  const requestHeaders = await headers();
  // Only loopback development hosts may use the non-Secure development cookie.
  const name = isLocalHost(requestHeaders.get("host") ?? "") && !requestHeaders.get("cookie")?.includes(`${SESSION_COOKIE}=`)
    ? LOCAL_SESSION_COOKIE : SESSION_COOKIE;
  const token = cmsSessionToken(requestHeaders.get("cookie"), name);
  if (!token) return null;
  const env = await getCmsAuthEnvironment();
  if (!env || cmsAuthSetupError(env)) return null;
  try {
    const session = await env.DB.prepare("SELECT expires_at FROM cms_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1")
      .bind(await hashCmsSession(token), Date.now()).first<{ expires_at: number }>();
    return session ? { displayName: env.CMS_ADMIN_NAME?.trim() || "Editor" } : null;
  } catch {
    return null;
  }
}
