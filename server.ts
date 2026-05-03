import { isRpsPick, rpsWinner, tttWinner, type RpsPick } from "./src/game";
import { analyticsLogLine, opsLogLine, readAnalyticsEvent } from "./src/analytics";
import { customRoomCodeAvailability, fortPassAllowsRoomTheme, fortPassIdleMs, fortPassRedemptionMatches, isFortPassActive, normalizeCustomRoomCode, normalizeFortPassCheckoutRequest, normalizeRoomTheme, type FortPassEntitlement, type RoomTheme } from "./src/entitlements";
import { blockedProbeResponse, logBlockedProbe, probeReasonForPath, withSecurityHeaders } from "./src/security";
import { createFortPassStripeCheckoutSession, fortPassEntitlementFromStripeEvent, verifyStripeWebhookSignature } from "./src/stripe";
import { sanitizeStyle, uniqueName, MAX_NAME_LEN, MAX_MSG_LEN, GRACE_MS as DEFAULT_GRACE_MS } from "./src/shared";

const PORT = parseInt(process.env.PORT || "3000");

// --- types ---

interface WSData {
  roomId: string | null;
  isHost: boolean;
  hostRejected: boolean;
  name: string;
  status: "available" | "away";
  awayText: string | null;
  hash: string;
  ip: string;
  msgTimestamps: number[];
}

interface Room {
  id: string;
  authVerifier: string;
  host: { ws: any; name: string } | null;
  guests: Map<any, string>;
  idleTimer: ReturnType<typeof setTimeout>;
  pendingOldHost: string | null;
  tossPillowFrom: string | null;
  disconnected: Map<string, {
    name: string;
    wasHost: boolean;
    status: "available" | "away";
    awayText: string | null;
    timer: ReturnType<typeof setTimeout>;
    ip: string;
  }>;
  // game state
  activeVote: { target: string; starter: string; yes: Set<string>; no: Set<string>; timer: ReturnType<typeof setTimeout>; endsAt: number; auto?: boolean } | null;
  rpsGame: { p1: string; p2: string; phase: "pending" | "playing"; timer?: ReturnType<typeof setTimeout>; pick1?: RpsPick; pick2?: RpsPick; koth?: boolean } | null;
  tttGame: { p1: string; p2: string; phase: "pending" | "playing"; timer?: ReturnType<typeof setTimeout>; board: string[]; turn: number } | null;
  saboteur: string | null;
  saboteurActive: boolean;
  sabStrikes: number;
  sabVote: {
    accuser: string;
    suspect: string;
    yes: Set<string>;
    no: Set<string>;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  sabCanStrike: boolean;
  sabBombTimer: ReturnType<typeof setTimeout> | null;
  kothGame: { challenger: string; host: string } | null;
  activeGame: GameQueueItem | null;
  gameQueue: GameQueueItem[];
  leaderboards: RoomLeaderboards;
  fortPassEntitlement: FortPassEntitlement | null;
  theme: RoomTheme;
}

interface RoomLeaderboards {
  pillowFight: Record<string, number>;
  rps: Record<string, number>;
  ttt: Record<string, number>;
  saboteur: Record<string, number>;
  koth: Record<string, number>;
}

type QueueGameKind = "vote" | "rps" | "ttt" | "saboteur" | "koth";

interface GameQueueItem {
  kind: QueueGameKind;
  by: string;
  target?: string;
}

interface RoomGameQueue {
  current: GameQueueItem | null;
  queue: GameQueueItem[];
}

// --- state (memory only, never persisted) ---

const rooms = new Map<string, Room>();
const roomCreationByIP = new Map<string, number[]>();
const pendingFortPassEntitlements = new Map<string, FortPassEntitlement>();

function hasActivePendingFortPass(roomId: string): boolean {
  const entitlement = pendingFortPassEntitlements.get(roomId);
  if (!entitlement) return false;
  if (isFortPassActive(entitlement)) return true;
  pendingFortPassEntitlements.delete(roomId);
  return false;
}

// --- constants ---

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_ROOMS_PER_MIN = parseInt(process.env.PILLOWFORT_RATE_ROOMS || "5");
const RATE_MSGS_PER_5S = 10;
const GRACE_MS_RAW = parseInt(process.env.PILLOWFORT_GRACE_MS || String(DEFAULT_GRACE_MS));
const GRACE_MS = Number.isFinite(GRACE_MS_RAW) && GRACE_MS_RAW > 0 ? GRACE_MS_RAW : DEFAULT_GRACE_MS;
const VOTE_DURATION_MS = 30_000;
const CHALLENGE_TIMEOUT_MS_RAW = parseInt(process.env.CHALLENGE_TIMEOUT_MS || "30000");
const CHALLENGE_TIMEOUT_MS = Number.isFinite(CHALLENGE_TIMEOUT_MS_RAW) && CHALLENGE_TIMEOUT_MS_RAW > 0 ? CHALLENGE_TIMEOUT_MS_RAW : 30_000;
const MAX_GAME_QUEUE = 10;
const SABOTEUR_VOTE_MS = 30_000;
const SABOTEUR_MIN_PLAYERS = 4;
const SAB_BOMB_MS_RAW = parseInt(process.env.SAB_BOMB_MS || (process.env.NODE_ENV === "test" ? "1200" : "10000"));
const SAB_BOMB_MS = Number.isFinite(SAB_BOMB_MS_RAW) && SAB_BOMB_MS_RAW > 0 ? SAB_BOMB_MS_RAW : 10_000;
const SAB_BOMB_SECONDS = Math.max(1, Math.ceil(SAB_BOMB_MS / 1000));
const MAX_ENC_B64_LEN = 4096;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
const ALLOW_LEGACY_PLAINTEXT = process.env.PF_ALLOW_LEGACY_PLAINTEXT === "1";

interface EncryptedChatPayload {
  v: 1 | 2 | 3;
  kdf?: string;
  sid?: string;
  seq?: number;
  iv: string;
  ct: string;
}

// --- helpers ---

function rid(): string {
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const c = "bcdfghjklmnprstvwz0123456789";
  const v = "o0ua";
  const all = "abcdefghijklmnopqrstuvwxyz0123456789";
  const soft = "rln";
  const hard = "xksz";
  const [a, b] = Math.random() < 0.5 ? [soft, hard] : [hard, soft];
  const id = pick(c) + pick(v) + pick(a) + pick(c) + pick(v) + pick(b) + pick(all) + pick(all);
  return rooms.has(id) ? rid() : id;
}

function send(ws: any, type: string, payload: Record<string, any> = {}) {
  try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
}

function broadcast(room: Room, type: string, payload: Record<string, any> = {}, exclude?: any) {
  const msg = JSON.stringify({ type, ...payload });
  if (room.host && room.host.ws !== exclude) try { room.host.ws.send(msg); } catch {}
  for (const [ws] of room.guests) {
    if (ws !== exclude) try { ws.send(msg); } catch {}
  }
}

function members(room: Room): string[] {
  const m: string[] = room.host ? [room.host.name] : [];
  m.push(...room.guests.values());
  return m;
}

function memberPresence(d: WSData): { status: "available" | "away"; awayText?: string } {
  const p: { status: "available" | "away"; awayText?: string } = { status: d.status || "available" };
  if (d.status === "away" && d.awayText) p.awayText = d.awayText;
  return p;
}

function roomPresence(room: Room): Record<string, { status: "available" | "away"; awayText?: string }> {
  const out: Record<string, { status: "available" | "away"; awayText?: string }> = {};
  if (room.host) {
    const d = room.host.ws.data as WSData;
    if (room.host.name) out[room.host.name] = memberPresence(d);
  }
  for (const [ws, name] of room.guests) {
    const d = ws.data as WSData;
    if (name) out[name] = memberPresence(d);
  }
  return out;
}

function sanitizeEncryptedChat(enc: any): EncryptedChatPayload | null {
  if (!enc || (enc.v !== 1 && enc.v !== 2 && enc.v !== 3)) return null;
  if (enc.v === 3) {
    if (enc.kdf !== "pbkdf2-sha256-600k-v1") return null;
    if (typeof enc.sid !== "string" || enc.sid.length < 16 || enc.sid.length > 64) return null;
    if (!Number.isSafeInteger(enc.seq) || enc.seq < 1) return null;
  }
  if (typeof enc.iv !== "string" || typeof enc.ct !== "string") return null;
  if (!BASE64_RE.test(enc.iv) || !BASE64_RE.test(enc.ct)) return null;
  if (enc.iv.length < 16 || enc.iv.length > 32) return null;
  if (enc.ct.length < 16 || enc.ct.length > MAX_ENC_B64_LEN) return null;
  return { v: enc.v, ...(enc.kdf ? { kdf: enc.kdf } : {}), ...(enc.sid ? { sid: enc.sid } : {}), ...(enc.seq ? { seq: enc.seq } : {}), iv: enc.iv, ct: enc.ct };
}

function validAuth(auth: any): auth is { v: 1; kdf: string; verifier: string } {
  return !!auth &&
    auth.v === 1 &&
    auth.kdf === "pbkdf2-sha256-600k-v1" &&
    typeof auth.verifier === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(auth.verifier);
}

async function readSmallJson(req: Request): Promise<unknown | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > 1024) return null;
  const text = await req.text();
  if (!text || text.length > 1024) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readLimitedText(req: Request, maxBytes: number): Promise<string | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) return null;
  const text = await req.text();
  if (!text || text.length > maxBytes) return null;
  return text;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function staticFileResponse(path: string): Response {
  return new Response(Bun.file(`./client/dist${path}`), {
    headers: { "content-type": contentTypeForPath(path) },
  });
}

function randomIndex(length: number): number {
  if (length <= 1) return 0;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % length;
}

function createLeaderboards(): RoomLeaderboards {
  return {
    pillowFight: {},
    rps: {},
    ttt: {},
    saboteur: {},
    koth: {},
  };
}

function emitLeaderboards(room: Room, exclude?: any) {
  broadcast(room, "leaderboards", { leaderboards: room.leaderboards }, exclude);
}

function bumpLeaderboard(room: Room, game: keyof RoomLeaderboards, name: string, amount = 1) {
  if (!name) return;
  room.leaderboards[game][name] = (room.leaderboards[game][name] || 0) + amount;
}

function gameQueueSnapshot(room: Room): RoomGameQueue {
  return {
    current: room.activeGame ? { ...room.activeGame } : null,
    queue: room.gameQueue.map((q) => ({ ...q })),
  };
}

function fortPassSnapshot(room: Room): { themePack?: string } | undefined {
  if (!room.fortPassEntitlement || !isFortPassActive(room.fortPassEntitlement)) return undefined;
  return room.fortPassEntitlement.perks.themePack
    ? { themePack: room.fortPassEntitlement.perks.themePack }
    : undefined;
}

function emitGameQueue(room: Room, exclude?: any) {
  broadcast(room, "game-queue", { gameQueue: gameQueueSnapshot(room) }, exclude);
}

function sameGameRequest(a: GameQueueItem, b: GameQueueItem): boolean {
  return a.kind === b.kind && a.by === b.by && (a.target || "") === (b.target || "");
}

function queueGame(room: Room, req: GameQueueItem, ws?: any): boolean {
  if (room.activeGame && sameGameRequest(room.activeGame, req)) return false;
  if (room.gameQueue.some((q) => sameGameRequest(q, req))) return false;
  if (room.gameQueue.length >= MAX_GAME_QUEUE) {
    if (ws) send(ws, "error", { message: "game queue is full" });
    return false;
  }
  room.gameQueue.push(req);
  emitGameQueue(room);
  if (ws) send(ws, "game-queued", { ...req, position: room.gameQueue.length });
  return true;
}

function setActiveGame(room: Room, current: GameQueueItem | null) {
  room.activeGame = current;
  emitGameQueue(room);
}

function drainGameQueue(room: Room) {
  if (room.activeGame) return;
  while (room.gameQueue.length > 0) {
    const req = room.gameQueue.shift()!;
    const nowMembers = members(room);
    if (!nowMembers.includes(req.by)) continue;
    if (req.target && !nowMembers.includes(req.target)) continue;
    let started = false;
    switch (req.kind) {
      case "vote":
        started = !!(req.target && startVote(room, req.by, req.target));
        break;
      case "rps":
        started = !!(req.target && startRps(room, req.by, req.target));
        break;
      case "ttt":
        started = !!(req.target && startTtt(room, req.by, req.target));
        break;
      case "saboteur":
        started = startSaboteur(room, req.by);
        break;
      case "koth":
        started = startKoth(room, req.by);
        break;
    }
    if (started) return;
  }
  emitGameQueue(room);
}

function clearActiveGame(room: Room, drain = true) {
  if (!room.activeGame) return;
  room.activeGame = null;
  emitGameQueue(room);
  if (drain) drainGameQueue(room);
}

function pruneGameQueue(room: Room) {
  const nowMembers = new Set(members(room));
  const next = room.gameQueue.filter((q) => nowMembers.has(q.by) && (!q.target || nowMembers.has(q.target)));
  if (next.length !== room.gameQueue.length) {
    room.gameQueue = next;
    emitGameQueue(room);
  }
}

function cancelActiveGamesForMember(room: Room, name: string) {
  let cancelled = false;
  if (room.activeVote?.target === name || room.activeVote?.starter === name) {
    clearTimeout(room.activeVote.timer);
    broadcast(room, "vote-result", {
      target: room.activeVote.target,
      yes: room.activeVote.yes.size,
      no: room.activeVote.no.size,
      ejected: false,
    });
    room.activeVote = null;
    cancelled = true;
  }
  if (room.rpsGame && (room.rpsGame.p1 === name || room.rpsGame.p2 === name)) {
    if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
    broadcast(room, "rps-declined", { from: name });
    room.rpsGame = null;
    room.kothGame = null;
    cancelled = true;
  }
  if (room.tttGame && (room.tttGame.p1 === name || room.tttGame.p2 === name)) {
    if (room.tttGame.timer) clearTimeout(room.tttGame.timer);
    broadcast(room, "ttt-declined", { from: name });
    room.tttGame = null;
    cancelled = true;
  }
  if (room.saboteurActive && room.saboteur === name) {
    room.saboteurActive = false;
    room.sabCanStrike = false;
    room.saboteur = null;
    if (room.sabVote) {
      clearTimeout(room.sabVote.timer);
      room.sabVote = null;
    }
    broadcast(room, "sab-vote-result", {
      accuser: "the fort",
      accused: name,
      yes: 0,
      no: 0,
      passed: true,
      wasSaboteur: true,
      saboteur: name,
    });
    cancelled = true;
  } else if (room.sabVote && (room.sabVote.accuser === name || room.sabVote.suspect === name)) {
    clearTimeout(room.sabVote.timer);
    room.sabVote = null;
  } else if (room.sabVote) {
    room.sabVote.yes.delete(name);
    room.sabVote.no.delete(name);
  }
  if (cancelled) clearActiveGame(room);
}

function resetIdle(room: Room) {
  clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(
    () => destroy(room, "the fort went quiet for too long"),
    fortPassIdleMs(room.fortPassEntitlement, IDLE_MS)
  );
}

function destroy(room: Room, reason: string) {
  clearTimeout(room.idleTimer);
  if (room.sabVote) {
    clearTimeout(room.sabVote.timer);
    room.sabVote = null;
  }
  if (room.rpsGame?.timer) clearTimeout(room.rpsGame.timer);
  if (room.tttGame?.timer) clearTimeout(room.tttGame.timer);
  if (room.sabBombTimer) {
    clearTimeout(room.sabBombTimer);
    room.sabBombTimer = null;
  }
  // clear all grace timers
  for (const [, disc] of room.disconnected) clearTimeout(disc.timer);
  room.disconnected.clear();
  broadcast(room, "knocked-down", { reason });
  if (room.host) try { room.host.ws.close(); } catch {}
  for (const [ws] of room.guests) { try { ws.close(); } catch {} }
  rooms.delete(room.id);
}

function rateLimitedIP(ip: string): boolean {
  const now = Date.now();
  const ts = (roomCreationByIP.get(ip) || []).filter(t => now - t < 60_000);
  roomCreationByIP.set(ip, ts);
  return ts.length >= RATE_ROOMS_PER_MIN;
}

function tag(d: WSData): string {
  return d.name ? `${d.name}#${d.hash}` : `?#${d.hash}`;
}

function rateLimitedMsg(data: WSData): boolean {
  const now = Date.now();
  data.msgTimestamps = data.msgTimestamps.filter(t => now - t < 5_000);
  return data.msgTimestamps.length >= RATE_MSGS_PER_5S;
}

// --- handlers ---

function onSetUp(ws: any, d: WSData, msg: any) {
  if (!msg.name?.trim() || !validAuth(msg.auth)) {
    console.log(opsLogLine("room_setup_failed", { reason: "bad_auth", surface: "local" }));
    return send(ws, "error", { message: "name and password required" });
  }
  if (d.isHost) {
    console.log(opsLogLine("room_setup_failed", { reason: "already_inside", surface: "local" }));
    return send(ws, "error", { message: "already in a fort" });
  }
  if (rateLimitedIP(d.ip)) {
    console.log(opsLogLine("room_setup_failed", { reason: "rate_limited", surface: "local" }));
    return send(ws, "error", { message: "slow down — too many forts" });
  }

  const id = d.roomId || rid();
  if (rooms.has(id)) {
    console.log(opsLogLine("room_setup_failed", { reason: "exists", surface: "local" }));
    return send(ws, "error", { message: "fort already exists" });
  }
  const fortPassEntitlement = pendingFortPassEntitlements.get(id) || null;
  if (fortPassEntitlement && !fortPassRedemptionMatches(fortPassEntitlement, msg.fortPassSessionId)) {
    console.log(opsLogLine("room_setup_failed", { reason: "paid_redemption", surface: "local" }));
    return send(ws, "error", { message: "paid room redemption required" });
  }

  d.roomId = id;
  d.isHost = true;
  d.name = msg.name.trim().slice(0, MAX_NAME_LEN);
  d.status = "available";
  d.awayText = null;

  const ts = roomCreationByIP.get(d.ip) || [];
  ts.push(Date.now());
  roomCreationByIP.set(d.ip, ts);

  const room: Room = {
    id,
    authVerifier: msg.auth.verifier,
    host: { ws, name: d.name },
    guests: new Map(),
    idleTimer: setTimeout(() => destroy(room, "the fort went quiet for too long"), fortPassIdleMs(fortPassEntitlement, IDLE_MS)),
    pendingOldHost: null,
    tossPillowFrom: null,
    disconnected: new Map(),
    activeVote: null,
    rpsGame: null,
    tttGame: null,
    saboteur: null,
    saboteurActive: false,
    sabStrikes: 0,
    sabVote: null,
    sabCanStrike: false,
    sabBombTimer: null,
    kothGame: null,
    activeGame: null,
    gameQueue: [],
    leaderboards: createLeaderboards(),
    fortPassEntitlement,
    theme: "classic",
  };
  pendingFortPassEntitlements.delete(id);

  rooms.set(id, room);
  send(ws, "room-created", {
    room: id,
    leaderboards: room.leaderboards,
    gameQueue: gameQueueSnapshot(room),
    theme: room.theme,
    fortPass: fortPassSnapshot(room),
  });
}

function onJoin(ws: any, d: WSData, msg: any) {
  if (!msg.name?.trim() || !validAuth(msg.auth) || !msg.room?.trim()) {
    console.log(opsLogLine("room_join_failed", { reason: "bad_auth", surface: "local" }));
    return send(ws, "error", { message: "name, password, and fort flag required" });
  }
  if (d.isHost) {
    console.log(opsLogLine("room_join_failed", { reason: "already_inside", surface: "local" }));
    return send(ws, "error", { message: "already in a fort" });
  }

  const room = rooms.get(msg.room.trim());
  if (!room) {
    console.log(opsLogLine("room_join_failed", { reason: "not_found", surface: "local" }));
    return send(ws, "error", { message: "fort not found" });
  }
  if (room.authVerifier !== msg.auth.verifier) {
    console.log(opsLogLine("room_join_failed", { reason: "wrong_password", surface: "local" }));
    return send(ws, "error", { message: "wrong password" });
  }
  if (room.guests.size >= MAX_GUESTS) {
    console.log(opsLogLine("room_join_failed", { reason: "full", surface: "local" }));
    return send(ws, "error", { message: "fort is full (20 max)" });
  }

  d.roomId = room.id;
  d.isHost = false;
  d.name = uniqueName(msg.name.trim().slice(0, MAX_NAME_LEN), new Set(members(room)));
  d.status = "available";
  d.awayText = null;

  room.guests.set(ws, d.name);
  send(ws, "joined", {
    room: room.id,
    members: members(room),
    name: d.name,
    presence: roomPresence(room),
    leaderboards: room.leaderboards,
    gameQueue: gameQueueSnapshot(room),
    theme: room.theme,
    fortPass: fortPassSnapshot(room),
  });
  broadcast(room, "member-joined", { name: d.name, presence: memberPresence(d) }, ws);
  resetIdle(room);
}

function onChat(ws: any, d: WSData, msg: any) {
  if (!d.roomId) return;
  if (rateLimitedMsg(d))
    return send(ws, "error", { message: "slow down" });

  d.msgTimestamps.push(Date.now());
  const room = rooms.get(d.roomId);
  if (!room) return;

  const enc = sanitizeEncryptedChat(msg.enc);
  const style = sanitizeStyle(msg.style);
  if (enc) {
    broadcast(room, "message", { from: d.name, enc, ...(style ? { style } : {}) });
    resetIdle(room);
    return;
  }

  if (!ALLOW_LEGACY_PLAINTEXT) return send(ws, "error", { message: "encrypted chat required" });
  if (!msg.text?.trim()) return;
  broadcast(room, "message", { from: d.name, text: msg.text.trim().slice(0, MAX_MSG_LEN), ...(style ? { style } : {}) });
  resetIdle(room);
}

function onKnockDown(ws: any, d: WSData) {
  if (!d.roomId || !d.isHost) return;
  const room = rooms.get(d.roomId);
  if (room) destroy(room, "host knocked it down");
}

function onTyping(ws: any, d: WSData) {
  if (!d.roomId) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  broadcast(room, "typing", { name: d.name }, ws);
}

function onSetStatus(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (msg.status !== "available" && msg.status !== "away") return;

  d.status = msg.status;
  if (d.status === "away") {
    const text = typeof msg.awayText === "string" ? msg.awayText.trim().slice(0, 120) : "";
    d.awayText = text || null;
  } else {
    d.awayText = null;
  }

  broadcast(room, "member-status", {
    name: d.name,
    status: d.status,
    awayText: d.awayText,
  });
  resetIdle(room);
}

function onSetTheme(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !d.isHost) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  const theme = normalizeRoomTheme(msg.theme);
  if (!theme) return send(ws, "error", { message: "invalid theme" });
  if (!fortPassAllowsRoomTheme(room.fortPassEntitlement, theme)) {
    return send(ws, "error", { message: "Fort Pass required" });
  }
  room.theme = theme;
  broadcast(room, "room-theme", { theme });
  resetIdle(room);
}

function offerHost(room: Room, oldHostName: string) {
  const candidates = [...room.guests.entries()].filter(([ws]) => {
    const d = ws.data as WSData;
    return !d.hostRejected;
  });

  if (candidates.length === 0) {
    destroy(room, "nobody caught the pillow");
    return;
  }

  const [pickWs, pickName] = candidates[Math.floor(Math.random() * candidates.length)];
  room.pendingOldHost = oldHostName;
  send(pickWs, "host-offer", { oldHost: oldHostName });
  broadcast(room, "host-offered", { name: pickName }, pickWs);
}

function onTossPillow(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.isHost || !msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;

  // find target in guests
  let targetWs: any = null;
  for (const [gws, gname] of room.guests) {
    if (gname === msg.target) { targetWs = gws; break; }
  }
  if (!targetWs) return;

  // demote host to guest
  room.tossPillowFrom = d.name;
  room.host = null;
  room.guests.set(ws, d.name);
  d.isHost = false;

  // send offer to specific target
  room.pendingOldHost = d.name;
  send(targetWs, "host-offer", { oldHost: d.name });
  broadcast(room, "host-offered", { name: msg.target }, targetWs);
}

function onAcceptHost(ws: any, d: WSData) {
  if (!d.roomId || d.isHost) return;
  const room = rooms.get(d.roomId);
  if (!room || room.host) return;

  // promote
  room.guests.delete(ws);
  d.isHost = true;
  d.hostRejected = false;
  room.host = { ws, name: d.name };
  room.pendingOldHost = null;
  room.tossPillowFrom = null;

  // clear rejections
  for (const [gws] of room.guests) {
    (gws.data as WSData).hostRejected = false;
  }

  broadcast(room, "new-host", { name: d.name });
  resetIdle(room);
}

function onRejectHost(ws: any, d: WSData) {
  if (!d.roomId || d.isHost) return;
  const room = rooms.get(d.roomId);
  if (!room) return;

  d.hostRejected = true;
  broadcast(room, "host-ducked", { name: d.name });

  // if this was a toss-pillow and target rejected, restore original host
  if (room.tossPillowFrom) {
    const origName = room.tossPillowFrom;
    room.tossPillowFrom = null;
    // find original host in guests
    for (const [gws, gname] of room.guests) {
      if (gname === origName) {
        room.guests.delete(gws);
        const gd = gws.data as WSData;
        gd.isHost = true;
        gd.hostRejected = false;
        room.host = { ws: gws, name: origName };
        room.pendingOldHost = null;
        // clear rejections
        for (const [rws] of room.guests) {
          (rws.data as WSData).hostRejected = false;
        }
        broadcast(room, "new-host", { name: origName });
        return;
      }
    }
  }

  offerHost(room, room.pendingOldHost || d.name);
}

function onLeave(_ws: any, d: WSData) {
  if (!d.roomId) return;
  const room = rooms.get(d.roomId);
  if (!room) { d.roomId = null; return; }
  removeMember(_ws, d, room);
  d.roomId = null;
}

function removeMember(ws: any, d: WSData, room: Room) {
  const leavingName = d.name;
  if (d.isHost) {
    if (room.guests.size === 0) {
      destroy(room, "host left and the fort is empty");
    } else {
      room.host = null;
      broadcast(room, "member-left", { name: d.name });
      offerHost(room, d.name);
    }
  } else {
    room.guests.delete(ws);
    broadcast(room, "member-left", { name: d.name });
  }
  cancelActiveGamesForMember(room, leavingName);
  pruneGameQueue(room);
}

function onDisconnect(ws: any, d: WSData) {
  if (!d.roomId) return;
  const room = rooms.get(d.roomId);
  if (!room) { d.roomId = null; return; }

  const name = d.name;
  const wasHost = d.isHost;

  // start grace period
  if (wasHost) {
    room.host = null;
  } else {
    room.guests.delete(ws);
  }

  broadcast(room, "member-away", { name });

  const timer = setTimeout(() => {
    room.disconnected.delete(name);
    broadcast(room, "member-left", { name });
    cancelActiveGamesForMember(room, name);
    pruneGameQueue(room);
    if (wasHost) {
      if (room.guests.size === 0 && !room.host) {
        destroy(room, "host left and the fort is empty");
      } else if (!room.host) {
        offerHost(room, name);
      }
    }
  }, GRACE_MS);

  room.disconnected.set(name, { name, wasHost, status: d.status, awayText: d.awayText, timer, ip: d.ip });
  d.roomId = null;
}

function onRejoin(ws: any, d: WSData, msg: any) {
  if (!msg.name?.trim() || !validAuth(msg.auth) || !msg.room?.trim())
    return send(ws, "error", { message: "name, password, and fort flag required" });

  const room = rooms.get(msg.room.trim());
  if (!room) return send(ws, "error", { message: "fort not found" });
  if (room.authVerifier !== msg.auth.verifier)
    return send(ws, "error", { message: "wrong password" });

  const disc = room.disconnected.get(msg.name.trim());
  if (disc) {
    // cancel grace timer, restore member
    clearTimeout(disc.timer);
    room.disconnected.delete(msg.name.trim());

    d.roomId = room.id;
    d.name = disc.name;
    d.status = disc.status || "available";
    d.awayText = disc.awayText || null;

    if (disc.wasHost && !room.host) {
      d.isHost = true;
      room.host = { ws, name: d.name };
    } else {
      d.isHost = false;
      room.guests.set(ws, d.name);
    }

    send(ws, "rejoined", {
      room: room.id,
      members: members(room),
      name: d.name,
      isHost: d.isHost,
      presence: roomPresence(room),
      leaderboards: room.leaderboards,
      gameQueue: gameQueueSnapshot(room),
      theme: room.theme,
      fortPass: fortPassSnapshot(room),
    });
    broadcast(room, "member-back", { name: d.name }, ws);
    resetIdle(room);
  } else {
    // grace expired, fall back to normal join
    onJoin(ws, d, msg);
  }
}

// --- game helpers ---

function findWs(room: Room, name: string): any | null {
  if (room.host && room.host.name === name) return room.host.ws;
  for (const [ws, n] of room.guests) {
    if (n === name) return ws;
  }
  return null;
}

function getHostWs(room: Room): any | null {
  return room.host ? room.host.ws : null;
}

function startVote(
  room: Room,
  starter: string,
  target: string,
  opts?: { auto?: boolean; starterLabel?: string }
): boolean {
  if (room.activeVote) return false;
  if (!opts?.auto && starter === target) return false;
  const m = members(room);
  if (!m.includes(target)) return false;
  if (!opts?.auto && !m.includes(starter)) return false;
  if (m.length < 3) return false;

  const endsAt = Date.now() + VOTE_DURATION_MS;
  room.activeVote = {
    target,
    starter,
    yes: opts?.auto ? new Set() : new Set([starter]),
    no: new Set(),
    auto: !!opts?.auto,
    endsAt,
    timer: setTimeout(() => resolveVote(room), VOTE_DURATION_MS),
  };
  setActiveGame(room, { kind: "vote", by: starter, target });
  broadcast(room, "vote-started", {
    target,
    starter: opts?.starterLabel || starter,
    duration: VOTE_DURATION_MS,
    endsAt,
    ...(opts?.auto ? { auto: true } : {}),
  });
  return true;
}

function startRps(room: Room, p1: string, p2: string): boolean {
  if (room.rpsGame) return false;
  const m = members(room);
  if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
  const tw = findWs(room, p2);
  if (!tw) return false;
  room.rpsGame = {
    p1,
    p2,
    phase: "pending",
    timer: setTimeout(() => {
      if (!room.rpsGame || room.rpsGame.p1 !== p1 || room.rpsGame.p2 !== p2 || room.rpsGame.phase !== "pending") return;
      broadcast(room, "rps-declined", { from: p2 });
      room.rpsGame = null;
      room.kothGame = null;
      clearActiveGame(room);
    }, CHALLENGE_TIMEOUT_MS),
  };
  setActiveGame(room, { kind: "rps", by: p1, target: p2 });
  send(tw, "rps-challenged", { from: p1 });
  broadcast(room, "rps-pending", { p1, p2 });
  return true;
}

function startTtt(room: Room, p1: string, p2: string): boolean {
  if (room.tttGame) return false;
  const m = members(room);
  if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
  const tw = findWs(room, p2);
  if (!tw) return false;
  room.tttGame = {
    p1,
    p2,
    phase: "pending",
    timer: setTimeout(() => {
      if (!room.tttGame || room.tttGame.p1 !== p1 || room.tttGame.p2 !== p2 || room.tttGame.phase !== "pending") return;
      broadcast(room, "ttt-declined", { from: p2 });
      room.tttGame = null;
      clearActiveGame(room);
    }, CHALLENGE_TIMEOUT_MS),
    board: Array(9).fill(""),
    turn: 0,
  };
  setActiveGame(room, { kind: "ttt", by: p1, target: p2 });
  send(tw, "ttt-challenged", { from: p1 });
  broadcast(room, "ttt-pending", { p1, p2 });
  return true;
}

function startSaboteur(room: Room, starter: string): boolean {
  if (room.saboteurActive) return false;
  const m = members(room);
  if (!m.includes(starter)) return false;
  if (m.length < SABOTEUR_MIN_PLAYERS) return false;

  room.saboteurActive = true;
  room.sabStrikes = 0;
  room.sabCanStrike = true;
  room.saboteur = m[randomIndex(m.length)];
  setActiveGame(room, { kind: "saboteur", by: starter });

  broadcast(room, "sab-started", { starter });
  const sabWs = findWs(room, room.saboteur);
  if (sabWs) send(sabWs, "sab-role", { role: "saboteur", canStrike: true });
  for (const name of m) {
    if (name !== room.saboteur) {
      const w = findWs(room, name);
      if (w) send(w, "sab-role", { role: "defender" });
    }
  }
  return true;
}

function startKoth(room: Room, challenger: string): boolean {
  const cw = findWs(room, challenger);
  if (!cw) return false;
  const cd = cw.data as WSData;
  if (cd.isHost) return false;
  if (room.rpsGame) return false;
  const hostWs = getHostWs(room);
  if (!hostWs || !room.host) return false;
  const hostName = room.host.name;

  room.kothGame = { challenger, host: hostName };
  room.rpsGame = { p1: challenger, p2: hostName, phase: "playing", koth: true };
  setActiveGame(room, { kind: "koth", by: challenger, target: hostName });
  broadcast(room, "koth-started", { challenger, host: hostName });
  broadcast(room, "rps-started", { p1: challenger, p2: hostName, koth: true });
  return true;
}

// --- vote (pillow fight) ---

function onStartVote(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (msg.target === d.name) return send(ws, "error", { message: "you can't vote yourself out" });
  if (!members(room).includes(msg.target)) return;
  if (members(room).length < 3) return send(ws, "error", { message: "need at least 3 people to start a vote" });
  if (room.activeGame) {
    queueGame(room, { kind: "vote", by: d.name, target: msg.target }, ws);
    return;
  }
  if (room.activeVote) return send(ws, "error", { message: "a vote is already in progress" });

  if (!startVote(room, d.name, msg.target)) {
    send(ws, "error", { message: "could not start vote right now" });
  }
}

function onCastVote(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.activeVote) return;
  if (msg.vote !== "yes" && msg.vote !== "no") return;
  if (d.name === room.activeVote.target) return;
  if (room.activeVote.yes.has(d.name) || room.activeVote.no.has(d.name)) return;

  if (msg.vote === "yes") room.activeVote.yes.add(d.name);
  else room.activeVote.no.add(d.name);

  broadcast(room, "vote-cast", { voter: d.name, vote: msg.vote });

  const eligible = members(room).filter(n => n !== room.activeVote!.target).length;
  const total = room.activeVote.yes.size + room.activeVote.no.size;
  if (total >= eligible) resolveVote(room);
}

function resolveVote(room: Room) {
  if (!room.activeVote) return;
  clearTimeout(room.activeVote.timer);
  const { target, yes, no, starter, auto } = room.activeVote;
  const ejected = yes.size > no.size;
  broadcast(room, "vote-result", { target, yes: yes.size, no: no.size, ejected });
  if (!auto) {
    if (ejected) bumpLeaderboard(room, "pillowFight", starter);
    else bumpLeaderboard(room, "pillowFight", target);
    emitLeaderboards(room);
  }

  if (ejected) {
    const tw = findWs(room, target);
    if (tw) {
      send(tw, "ejected", { reason: "You were voted out of the fort!" });
      try { tw.close(1000, "ejected"); } catch {}
    }
    // remove from room
    if (room.host && room.host.name === target) {
      room.host = null;
    } else {
      for (const [ws, n] of room.guests) {
        if (n === target) { room.guests.delete(ws); break; }
      }
    }
    broadcast(room, "member-left", { name: target });
    pruneGameQueue(room);
  }
  room.activeVote = null;
  clearActiveGame(room);
}

// --- RPS ---

function onRpsChallenge(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.target || d.name === msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (room.activeGame) {
    queueGame(room, { kind: "rps", by: d.name, target: msg.target }, ws);
    return;
  }
  if (room.rpsGame) return send(ws, "error", { message: "a duel is already in progress" });
  if (!findWs(room, msg.target)) return;
  if (!startRps(room, d.name, msg.target)) {
    send(ws, "error", { message: "could not start RPS right now" });
  }
}

function onRpsAccept(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame || d.name !== room.rpsGame.p2) return;
  if (room.rpsGame.phase !== "pending") return;
  if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
  room.rpsGame.timer = undefined;
  room.rpsGame.phase = "playing";
  broadcast(room, "rps-started", { p1: room.rpsGame.p1, p2: room.rpsGame.p2 });
}

function onRpsDecline(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame || d.name !== room.rpsGame.p2) return;
  if (room.rpsGame.timer) clearTimeout(room.rpsGame.timer);
  broadcast(room, "rps-declined", { from: d.name });
  room.rpsGame = null;
  if (room.kothGame) room.kothGame = null;
  clearActiveGame(room);
}

function onRpsPick(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.pick) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame) return;
  if (room.rpsGame.phase !== "playing") return;
  if (!isRpsPick(msg.pick)) return;

  if (d.name === room.rpsGame.p1) room.rpsGame.pick1 = msg.pick;
  else if (d.name === room.rpsGame.p2) room.rpsGame.pick2 = msg.pick;
  else return;

  send(ws, "rps-picked", {});

  if (room.rpsGame.pick1 && room.rpsGame.pick2) {
    const { p1, p2, pick1, pick2 } = room.rpsGame;
    const winner = rpsWinner(p1, p2, pick1, pick2);
    const isKoth = !!room.kothGame;
    broadcast(room, "rps-result", { p1, p2, pick1, pick2, winner, koth: isKoth || undefined });
    if (winner) {
      if (!isKoth) {
        bumpLeaderboard(room, "rps", winner);
        emitLeaderboards(room);
      }
    }
    room.rpsGame = null;
    if (isKoth && winner) resolveKoth(room, winner);
    else if (isKoth) {
      room.kothGame = null;
      clearActiveGame(room);
    } else {
      clearActiveGame(room);
    }
  }
}

// --- TTT ---

function onTttChallenge(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.target || d.name === msg.target) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (room.activeGame) {
    queueGame(room, { kind: "ttt", by: d.name, target: msg.target }, ws);
    return;
  }
  if (room.tttGame) return send(ws, "error", { message: "a game is already in progress" });
  if (!findWs(room, msg.target)) return;
  if (!startTtt(room, d.name, msg.target)) {
    send(ws, "error", { message: "could not start Tic-Tac-Toe right now" });
  }
}

function onTttAccept(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame || d.name !== room.tttGame.p2) return;
  if (room.tttGame.phase !== "pending") return;
  if (room.tttGame.timer) clearTimeout(room.tttGame.timer);
  room.tttGame.timer = undefined;
  room.tttGame.phase = "playing";
  broadcast(room, "ttt-started", { p1: room.tttGame.p1, p2: room.tttGame.p2, board: room.tttGame.board, turn: room.tttGame.turn });
}

function onTttDecline(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame || d.name !== room.tttGame.p2) return;
  if (room.tttGame.timer) clearTimeout(room.tttGame.timer);
  broadcast(room, "ttt-declined", { from: d.name });
  room.tttGame = null;
  clearActiveGame(room);
}

function onTttMove(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || msg.cell == null) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame) return;
  const g = room.tttGame;
  if (g.phase !== "playing") return;
  const currentPlayer = g.turn % 2 === 0 ? g.p1 : g.p2;
  if (d.name !== currentPlayer) return;
  if (!Number.isInteger(msg.cell) || msg.cell < 0 || msg.cell > 8 || g.board[msg.cell]) return;

  g.board[msg.cell] = g.turn % 2 === 0 ? "X" : "O";
  g.turn++;

  const mark = g.board[msg.cell];
  let winner: string | null = null;
  if (tttWinner(g.board, mark)) winner = d.name;
  const draw = !winner && g.board.every(c => c);

  broadcast(room, "ttt-update", { board: g.board, turn: g.turn, lastMove: msg.cell, winner, draw });
  if (winner) {
    bumpLeaderboard(room, "ttt", winner);
    emitLeaderboards(room);
  }
  if (winner || draw) {
    room.tttGame = null;
    clearActiveGame(room);
  }
}

// --- Saboteur ---

function onSabStart(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (room.saboteurActive) return send(ws, "error", { message: "saboteur mode is already active" });
  const m = members(room);
  if (m.length < SABOTEUR_MIN_PLAYERS) return send(ws, "error", { message: `need at least ${SABOTEUR_MIN_PLAYERS} people` });
  if (room.activeGame) {
    queueGame(room, { kind: "saboteur", by: d.name }, ws);
    return;
  }
  if (!startSaboteur(room, d.name)) {
    send(ws, "error", { message: "could not start Saboteur right now" });
  }
}

function onSabAccuse(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.suspect) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.saboteurActive) return;
  if (room.sabVote) return send(ws, "error", { message: "an accusation vote is already in progress" });
  if (d.name === room.saboteur) return send(ws, "error", { message: "saboteur can't accuse" });
  if (!members(room).includes(msg.suspect)) return;
  if (msg.suspect === d.name) return send(ws, "error", { message: "you can't accuse yourself" });

  room.sabVote = {
    accuser: d.name,
    suspect: msg.suspect,
    yes: new Set([d.name]),
    no: new Set(),
    timer: setTimeout(() => resolveSabVote(room), SABOTEUR_VOTE_MS),
  };
  broadcast(room, "sab-vote-start", {
    accuser: d.name,
    suspect: msg.suspect,
    duration: SABOTEUR_VOTE_MS,
    endsAt: Date.now() + SABOTEUR_VOTE_MS,
  });
}

function onSabVote(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.sabVote || !room.saboteurActive) return;
  if (msg.vote !== "yes" && msg.vote !== "no") return;

  room.sabVote.yes.delete(d.name);
  room.sabVote.no.delete(d.name);
  if (msg.vote === "yes") room.sabVote.yes.add(d.name);
  else room.sabVote.no.add(d.name);

  const total = room.sabVote.yes.size + room.sabVote.no.size;
  if (total >= members(room).length) resolveSabVote(room);
}

function resolveSabVote(room: Room) {
  if (!room.sabVote || !room.saboteurActive) return;
  clearTimeout(room.sabVote.timer);
  const { accuser, suspect, yes, no } = room.sabVote;
  const passed = yes.size > no.size;
  const correct = passed && suspect === room.saboteur;
  broadcast(room, "sab-vote-result", {
    accuser,
    accused: suspect,
    yes: yes.size,
    no: no.size,
    passed,
    wasSaboteur: correct,
    saboteur: correct ? room.saboteur : null,
  });

  if (correct) {
    const sabName = room.saboteur!;
    for (const defender of members(room)) {
      if (defender !== sabName) bumpLeaderboard(room, "saboteur", defender);
    }
    emitLeaderboards(room);
    room.saboteurActive = false;
    room.sabCanStrike = false;
    room.saboteur = null;
    room.sabVote = null;

    // auto-start pillow fight vote against the caught saboteur
    clearActiveGame(room, false);
    if (!room.activeVote && members(room).length >= 3 && members(room).includes(sabName)) {
      startVote(room, sabName, sabName, { auto: true, starterLabel: "the fort" });
    } else {
      drainGameQueue(room);
    }
  } else {
    room.sabVote = null;
    if (!room.sabCanStrike && room.saboteur) {
      room.sabCanStrike = true;
      const sabWs = findWs(room, room.saboteur);
      if (sabWs) send(sabWs, "sab-strike-ready", { reason: "wrong-accusation" });
    }
  }
}

function onSabStrike(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.saboteurActive || d.name !== room.saboteur) return;
  if (!room.sabCanStrike) return send(ws, "error", { message: "you can strike after a wrong accusation vote" });

  room.sabCanStrike = false;
  room.sabStrikes++;
  broadcast(room, "sab-strike", { saboteur: d.name, strikes: room.sabStrikes });

  if (room.sabStrikes >= 3) {
    // The saboteur plants a bomb. Let chat continue during countdown.
    bumpLeaderboard(room, "saboteur", d.name);
    emitLeaderboards(room);
    room.saboteurActive = false;
    room.sabCanStrike = false;
    room.saboteur = null;
    if (room.sabVote) { clearTimeout(room.sabVote.timer); room.sabVote = null; }
    if (room.sabBombTimer) clearTimeout(room.sabBombTimer);
    broadcast(room, "sab-bomb-start", { saboteur: d.name, seconds: SAB_BOMB_SECONDS, durationMs: SAB_BOMB_MS });
    room.sabBombTimer = setTimeout(() => {
      room.sabBombTimer = null;
      // Room may already be gone (host manual knockdown, etc.)
      if (!rooms.has(room.id)) return;
      destroy(room, "the saboteur's bomb exploded!");
    }, SAB_BOMB_MS);
  }
}

// --- KOTH ---

function onKothChallenge(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  if (d.isHost) return send(ws, "error", { message: "only non-hosts can challenge" });
  if (!room.host) return;
  if (room.activeGame) {
    queueGame(room, { kind: "koth", by: d.name, target: room.host.name }, ws);
    return;
  }
  if (room.rpsGame) return send(ws, "error", { message: "a duel is already in progress" });
  if (!startKoth(room, d.name)) {
    send(ws, "error", { message: "could not start KOTH right now" });
  }
}

function resolveKoth(room: Room, winner: string) {
  if (!room.kothGame) return;
  const { challenger, host } = room.kothGame;
  room.kothGame = null;

  if (winner === challenger) {
    // swap host
    const hostWs = findWs(room, host);
    const challWs = findWs(room, challenger);
    if (hostWs && room.host && room.host.name === host) {
      room.guests.set(hostWs, host);
      (hostWs.data as WSData).isHost = false;
      room.host = null;
    }
    if (challWs) {
      room.guests.delete(challWs);
      (challWs.data as WSData).isHost = true;
      room.host = { ws: challWs, name: challenger };
    }
    bumpLeaderboard(room, "koth", challenger);
    emitLeaderboards(room);
    broadcast(room, "new-host", { name: challenger });
    broadcast(room, "koth-result", { winner: challenger, loser: host });
  } else {
    bumpLeaderboard(room, "koth", host);
    emitLeaderboards(room);
    broadcast(room, "koth-result", { winner: host, loser: challenger });
  }
  clearActiveGame(room);
}

// --- draw passthrough ---

function onDraw(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.pts?.length) return;
  const room = rooms.get(d.roomId);
  if (!room) return;
  const payload: Record<string, unknown> = { from: d.name, color: msg.color, pts: msg.pts };
  if (msg.s) payload.s = 1;
  broadcast(room, "draw", payload, ws);
}

async function handleHttp(req: Request, server: any): Promise<Response | undefined> {
  const url = new URL(req.url);

  const probeReason = probeReasonForPath(url.pathname);
  if (probeReason) {
    logBlockedProbe(url.pathname);
    return blockedProbeResponse();
  }

  if (url.pathname === "/analytics") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const event = await readAnalyticsEvent(req);
    if (!event) return new Response("bad analytics event", { status: 400 });
    console.log(analyticsLogLine(event));
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/stripe/webhook") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "not_configured", status: 501 }));
      return json({ error: "webhook_not_configured" }, 501);
    }
    const payload = await readLimitedText(req, 64 * 1024);
    if (!payload) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "bad_payload", status: 400 }));
      return json({ error: "bad_webhook_payload" }, 400);
    }
    const verification = await verifyStripeWebhookSignature(
      payload,
      req.headers.get("stripe-signature"),
      process.env.STRIPE_WEBHOOK_SECRET
    );
    if (!verification.ok) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "bad_signature", status: 400 }));
      return json({ error: "bad_webhook_signature" }, 400);
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "bad_payload", status: 400 }));
      return json({ error: "bad_webhook_payload" }, 400);
    }
    const entitlement = fortPassEntitlementFromStripeEvent(event);
    if (!entitlement) return json({ received: true, ignored: true });
    if (rooms.has(entitlement.roomId)) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "fulfillment_failed", status: 409 }));
      return json({ error: "entitlement_fulfillment_failed" }, 409);
    }
    pendingFortPassEntitlements.set(entitlement.roomId, entitlement);
    return json({ received: true, fulfilled: true, code: entitlement.roomId });
  }

  if (url.pathname === "/api/fort-pass/code") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const code = normalizeCustomRoomCode(url.searchParams.get("code"));
    const availability = code
      ? customRoomCodeAvailability(code, rooms.has(code) || hasActivePendingFortPass(code))
      : customRoomCodeAvailability(null, false);
    return json(availability);
  }

  if (url.pathname === "/api/fort-pass/checkout") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const checkout = normalizeFortPassCheckoutRequest(await readSmallJson(req));
    if (!checkout) return json({ error: "invalid_custom_room_code" }, 400);
    if (rooms.has(checkout.customRoomCode) || hasActivePendingFortPass(checkout.customRoomCode)) {
      return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
    }
    if (!process.env.STRIPE_SECRET_KEY || !process.env.FORT_PASS_PRICE_ID) {
      return json({ error: "checkout_not_configured", code: checkout.customRoomCode }, 501);
    }
    try {
      const session = await createFortPassStripeCheckoutSession({
        secretKey: process.env.STRIPE_SECRET_KEY,
        priceId: process.env.FORT_PASS_PRICE_ID,
        publicBaseUrl: process.env.PUBLIC_BASE_URL || url.origin,
        customRoomCode: checkout.customRoomCode,
      });
      return json({ code: checkout.customRoomCode, checkoutUrl: session.url, sessionId: session.id });
    } catch {
      return json({ error: "checkout_provider_error" }, 502);
    }
  }

  if (url.pathname === "/ws") {
    const ip = server.requestIP(req)?.address || "unknown";
    const roomParam = url.searchParams.get("room") || "";
    if (roomParam && !normalizeCustomRoomCode(roomParam)) {
      console.log(opsLogLine("ws_rejected", { reason: "invalid_room", surface: "local", status: 400 }));
      return new Response("invalid room", { status: 400 });
    }
    const ok = server.upgrade(req, {
      data: {
        roomId: roomParam || null,
        isHost: false,
        hostRejected: false,
        name: "",
        status: "available",
        awayText: null,
        hash: Math.random().toString(16).slice(2, 6),
        ip,
        msgTimestamps: [],
      } satisfies WSData,
    });
    return ok ? undefined : new Response("upgrade failed", { status: 400 });
  }

  // room links: /abc123 → serve index.html
  if (normalizeCustomRoomCode(url.pathname.slice(1))) {
    return staticFileResponse("/index.html");
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = Bun.file(`./client/dist${path}`);
  return (await file.exists()) ? staticFileResponse(path) : new Response("not found", { status: 404 });
}

// --- server ---

Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const response = await handleHttp(req, server);
    return response ? withSecurityHeaders(response) : undefined;
  },

  websocket: {
    open() {},
    message(ws, raw) {
      try {
        const msg = JSON.parse(raw as string);
        const d = ws.data as WSData;
        switch (msg.type) {
          case "set-up":       onSetUp(ws, d, msg); break;
          case "join":         onJoin(ws, d, msg); break;
          case "rejoin":       onRejoin(ws, d, msg); break;
          case "chat":         onChat(ws, d, msg); break;
          case "knock-down":   onKnockDown(ws, d); break;
          case "typing":       onTyping(ws, d); break;
          case "set-status":   onSetStatus(ws, d, msg); break;
          case "set-theme":    onSetTheme(ws, d, msg); break;
          case "leave":        onLeave(ws, d); break;
          case "accept-host":  onAcceptHost(ws, d); break;
          case "reject-host":  onRejectHost(ws, d); break;
          case "toss-pillow":  onTossPillow(ws, d, msg); break;
          case "draw":         onDraw(ws, d, msg); break;
          // pvp games
          case "start-vote":    onStartVote(ws, d, msg); break;
          case "cast-vote":     onCastVote(ws, d, msg); break;
          case "rps-challenge": onRpsChallenge(ws, d, msg); break;
          case "rps-accept":    onRpsAccept(ws, d); break;
          case "rps-decline":   onRpsDecline(ws, d); break;
          case "rps-pick":      onRpsPick(ws, d, msg); break;
          case "ttt-challenge": onTttChallenge(ws, d, msg); break;
          case "ttt-accept":    onTttAccept(ws, d); break;
          case "ttt-decline":   onTttDecline(ws, d); break;
          case "ttt-move":      onTttMove(ws, d, msg); break;
          case "sab-start":     onSabStart(ws, d); break;
          case "sab-accuse":    onSabAccuse(ws, d, msg); break;
          case "sab-strike":    onSabStrike(ws, d); break;
          case "sab-vote":      onSabVote(ws, d, msg); break;
          case "koth-challenge": onKothChallenge(ws, d); break;
        }
      } catch {}
    },
    close(ws) { onDisconnect(ws, ws.data as WSData); },
  },
});

console.log(`pillowfort :${PORT}`);
