const MAX_PUBLIC_ORIGIN_LENGTH = 2 * 1024;

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return !!match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127;
}

/**
 * Return a canonical checkout return origin only when it is the exact origin
 * that received this request. Production requires HTTPS; plaintext HTTP is
 * limited to loopback development servers.
 */
export function normalizePublicCheckoutOrigin(input: unknown, requestUrl: URL): string | null {
  if (
    typeof input !== "string"
    || !input
    || input.length > MAX_PUBLIC_ORIGIN_LENGTH
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    return null;
  }

  try {
    const candidate = new URL(input);
    const localHttp = candidate.protocol === "http:" && isLoopbackHostname(candidate.hostname);
    if (
      input !== candidate.origin
      || candidate.origin !== requestUrl.origin
      || (candidate.protocol !== "https:" && !localHttp)
      || candidate.username !== ""
      || candidate.password !== ""
      || (candidate.port !== "" && candidate.protocol === "https:")
      || candidate.pathname !== "/"
      || candidate.search !== ""
      || candidate.hash !== ""
    ) {
      return null;
    }
    return candidate.origin;
  } catch {
    return null;
  }
}

export function checkoutPublicOrigin(configuredOrigin: string | undefined, url: URL): string | null {
  if (configuredOrigin !== undefined) return normalizePublicCheckoutOrigin(configuredOrigin, url);
  return url.protocol === "http:" && isLoopbackHostname(url.hostname) ? url.origin : null;
}

export function isStrictSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || origin.length > MAX_PUBLIC_ORIGIN_LENGTH || /[\u0000-\u001f\u007f]/u.test(origin)) {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return !!contentType && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}
