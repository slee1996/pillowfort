import { cmsAuthSetupError, cmsSessionCookie, cmsSessionCookieName, cmsSessionToken, createCmsSession, getCmsAuthEnvironment, verifyCmsPassword } from "../../../../cms/auth";
import { isSameOriginCmsRequest } from "../../../../cms/request";

export const dynamic = "force-dynamic";

function loginError(error: string, retryAfter?: string): Response {
  const headers = new Headers({ location: `/admin?error=${error}`, "cache-control": "no-store" });
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(null, { status: 303, headers });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginCmsRequest(request, ["application/x-www-form-urlencoded"])) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  const url = new URL(request.url);
  const cookieName = cmsSessionCookieName(url);
  if (!cookieName) return new Response("Editor login requires HTTPS, except on localhost.", { status: 403, headers: { "cache-control": "no-store" } });
  const env = await getCmsAuthEnvironment();
  if (!env || cmsAuthSetupError(env)) return loginError("setup");
  try {
    // Cloudflare supplies this header at the edge; never use client-forwarded identity or IP headers.
    const source = request.headers.get("cf-connecting-ip") || "unknown";
    const result = await env.CMS_LOGIN_RATE_LIMITER.limit({ key: `pillowfort-cms-login:${source}` });
    if (!result.success) return loginError("rate-limit", "60");
  } catch {
    return loginError("unavailable");
  }

  const reader = request.body?.getReader();
  if (!reader) return loginError("invalid-input");
  let password: string;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return loginError("invalid-input");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const passwords = form.getAll("password");
    if (passwords.length !== 1 || [...form.keys()].some(key => key !== "password") || !passwords[0] || passwords[0].length > 1024) return loginError("invalid-input");
    password = passwords[0];
  } catch {
    return loginError("invalid-input");
  } finally {
    reader.releaseLock();
  }

  try {
    if (!await verifyCmsPassword(password, env.CMS_ADMIN_PASSWORD)) return loginError("credentials");
    const oldToken = cmsSessionToken(request.headers.get("cookie"), cookieName);
    const session = await createCmsSession(env, oldToken);
    return new Response(null, { status: 303, headers: {
      location: "/admin",
      "cache-control": "no-store",
      "set-cookie": cmsSessionCookie(cookieName, session.token, session.expiresAt),
    } });
  } catch {
    return loginError("storage");
  }
}
