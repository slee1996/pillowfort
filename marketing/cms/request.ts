export function isSameOriginCmsRequest(request: Request, contentTypes: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!origin || origin === "null" || origin.length > 2048 ||
      (fetchSite !== null && fetchSite !== "same-origin") ||
      !contentType || !contentTypes.includes(contentType)) return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
