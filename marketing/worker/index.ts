/** Cloudflare Worker entry point for the Pillowfort marketing site. */
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
  isImageOptimizationPath,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.pillowfort.xyz") {
      if (request.method === "GET" || request.method === "HEAD") {
        url.protocol = "https:";
        url.hostname = "about.pillowfort.xyz";
        url.port = "";
        return Response.redirect(url, 308);
      }
      // Do not forward credentials or mutations across origins. Old sessions
      // may still explicitly log out so their server-side token is revoked.
      if (url.pathname !== "/api/admin/logout") {
        return Response.json({
          ok: false,
          error: { code: "SITE_MOVED", message: "Open https://about.pillowfort.xyz/admin and sign in again before submitting.", retryable: false },
        }, { status: 409, headers: { "cache-control": "no-store" } });
      }
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !local) {
      url.protocol = "https:";
      return Response.redirect(url, 308);
    }
    let response: Response;

    if (isImageOptimizationPath(url.pathname)) {
      response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    } else {
      const asset = request.method === "GET" || request.method === "HEAD"
        ? await env.ASSETS.fetch(request) : null;
      response = asset && asset.status !== 404 ? asset : await handler.fetch(request, env, ctx);
    }

    const headers = new Headers(response.headers);
    if (response.ok && /^\/agents\/(?:index|workflows|security|tools)\.md$/.test(url.pathname)) {
      headers.set("content-type", "text/markdown; charset=utf-8");
    }
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("content-security-policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    // Preserve same-origin form Origin headers while withholding cross-origin referrers.
    headers.set("referrer-policy", "same-origin");
    if (url.protocol === "https:") headers.set("strict-transport-security", "max-age=31536000");
    if (url.pathname === "/admin" || url.pathname.startsWith("/api/")) headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default worker;
