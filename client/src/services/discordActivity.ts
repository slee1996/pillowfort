export type DiscordActivityContext = {
  active: true;
  source: "activity_route" | "discord_proxy";
  platform: string;
};

const PLATFORM_RE = /^[A-Za-z0-9_-]{1,32}$/u;

function singleParameter(params: URLSearchParams, name: string): string | null | false {
  const values = params.getAll(name);
  if (values.length > 1) return false;
  return values.length === 1 ? values[0] : null;
}

export async function getDiscordActivityContext(
  url: URL = new URL(window.location.href),
): Promise<DiscordActivityContext | null> {
  const params = url.searchParams;
  const activityRoute = url.pathname === "/activity";
  const discordProxy = url.hostname.endsWith(".discordsays.com");
  const activityFlag = singleParameter(params, "discord_activity");
  const frameId = singleParameter(params, "frame_id");
  const platformValue = singleParameter(params, "platform");
  if ([activityFlag, frameId, platformValue].includes(false)) return null;
  // Query parameters are not launch authentication. They may decorate the
  // dedicated Activity surface, but an ordinary Pillowfort page never enters
  // Activity mode merely because a caller supplied launch-looking values.
  if (!activityRoute && !discordProxy) return null;

  if (activityFlag !== null && activityFlag !== "1") return null;
  if (platformValue !== null && (typeof platformValue !== "string" || !PLATFORM_RE.test(platformValue))) return null;

  const platform = platformValue || (discordProxy ? "discord_proxy" : "web");
  const source = activityRoute ? "activity_route" : "discord_proxy";

  return {
    active: true,
    source,
    platform,
  };
}
