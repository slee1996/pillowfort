export type DiscordActivityContext = {
  active: true;
  roomId: string;
  source: "activity_route" | "discord_proxy" | "query";
  platform: string;
};

const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function hashBase36(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return Math.abs(hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

function fallbackSeed(input: string): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ROOM_ALPHABET[(input.charCodeAt(i % input.length) + i * 11) % ROOM_ALPHABET.length];
  }
  return out;
}

export function getDiscordActivityContext(url: URL = new URL(window.location.href)): DiscordActivityContext | null {
  const params = url.searchParams;
  const activityRoute = url.pathname === "/activity";
  const discordProxy = url.hostname.endsWith(".discordsays.com");
  const queryLaunch = params.get("discord_activity") === "1" || params.has("frame_id");

  if (!activityRoute && !discordProxy && !queryLaunch) return null;

  const platform = params.get("platform") || (discordProxy ? "discord_proxy" : "web");
  const source = activityRoute ? "activity_route" : discordProxy ? "discord_proxy" : "query";
  const instanceSeed =
    params.get("instance_id") ||
    params.get("channel_id") ||
    params.get("frame_id") ||
    `${url.hostname}:${url.pathname}`;
  const suffix = instanceSeed ? hashBase36(instanceSeed) : fallbackSeed(url.href);

  return {
    active: true,
    roomId: `dc-${suffix}`,
    source,
    platform,
  };
}
