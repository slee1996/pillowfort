import { cmsSessionCookie, cmsSessionCookieName, cmsSessionToken, getCmsAuthEnvironment, hashCmsSession } from "../../../../cms/auth";
import { isSameOriginCmsRequest } from "../../../../cms/request";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginCmsRequest(request, ["application/x-www-form-urlencoded"])) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  const cookieName = cmsSessionCookieName(new URL(request.url));
  if (!cookieName) return new Response("Editor logout requires HTTPS, except on localhost.", { status: 403, headers: { "cache-control": "no-store" } });
  const token = cmsSessionToken(request.headers.get("cookie"), cookieName);
  if (token) {
    try {
      const env = await getCmsAuthEnvironment();
      if (!env?.DB) throw new Error("CMS database unavailable");
      await env.DB.prepare("DELETE FROM cms_sessions WHERE token_hash = ?").bind(await hashCmsSession(token)).run();
    } catch {
      return new Response("Sign-out could not be completed. Restore the CMS database connection and try again.", { status: 503, headers: { "cache-control": "no-store" } });
    }
  }
  return new Response(null, { status: 303, headers: {
    location: "/",
    "cache-control": "no-store",
    "set-cookie": cmsSessionCookie(cookieName, "", 0),
  } });
}
