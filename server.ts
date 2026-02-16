import { sanitizeStyle, uniqueName, MAX_NAME_LEN, MAX_MSG_LEN, GRACE_MS } from "./src/shared";

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
  password: string;
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
  activeVote: { target: string; starter: string; yes: Set<string>; no: Set<string>; timer: ReturnType<typeof setTimeout>; auto?: boolean } | null;
  rpsGame: { p1: string; p2: string; pick1?: string; pick2?: string } | null;
  tttGame: { p1: string; p2: string; board: string[]; turn: number } | null;
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

// --- constants ---

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_ROOMS_PER_MIN = parseInt(process.env.PILLOWFORT_RATE_ROOMS || "5");
const RATE_MSGS_PER_5S = 10;
const VOTE_DURATION_MS = 30_000;
const SABOTEUR_VOTE_MS = 30_000;
const SABOTEUR_MIN_PLAYERS = 4;
const SAB_BOMB_MS_RAW = parseInt(process.env.SAB_BOMB_MS || (process.env.NODE_ENV === "test" ? "1200" : "10000"));
const SAB_BOMB_MS = Number.isFinite(SAB_BOMB_MS_RAW) && SAB_BOMB_MS_RAW > 0 ? SAB_BOMB_MS_RAW : 10_000;
const SAB_BOMB_SECONDS = Math.max(1, Math.ceil(SAB_BOMB_MS / 1000));
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const MAX_ENC_B64_LEN = 4096;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

interface EncryptedChatPayload {
  v: 1 | 2;
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
  if (!enc || (enc.v !== 1 && enc.v !== 2)) return null;
  if (typeof enc.iv !== "string" || typeof enc.ct !== "string") return null;
  if (!BASE64_RE.test(enc.iv) || !BASE64_RE.test(enc.ct)) return null;
  if (enc.iv.length < 16 || enc.iv.length > 32) return null;
  if (enc.ct.length < 16 || enc.ct.length > MAX_ENC_B64_LEN) return null;
  return { v: enc.v, iv: enc.iv, ct: enc.ct };
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

function emitGameQueue(room: Room, exclude?: any) {
  broadcast(room, "game-queue", { gameQueue: gameQueueSnapshot(room) }, exclude);
}

function sameGameRequest(a: GameQueueItem, b: GameQueueItem): boolean {
  return a.kind === b.kind && a.by === b.by && (a.target || "") === (b.target || "");
}

function queueGame(room: Room, req: GameQueueItem, ws?: any): boolean {
  if (room.activeGame && sameGameRequest(room.activeGame, req)) return false;
  if (room.gameQueue.some((q) => sameGameRequest(q, req))) return false;
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

function resetIdle(room: Room) {
  clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => destroy(room, "the fort went quiet for too long"), IDLE_MS);
}

function destroy(room: Room, reason: string) {
  clearTimeout(room.idleTimer);
  if (room.sabVote) {
    clearTimeout(room.sabVote.timer);
    room.sabVote = null;
  }
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
  if (!msg.name?.trim() || !msg.password?.trim())
    return send(ws, "error", { message: "name and password required" });
  if (d.isHost)
    return send(ws, "error", { message: "already in a fort" });
  if (rateLimitedIP(d.ip))
    return send(ws, "error", { message: "slow down — too many forts" });

  const id = d.roomId || rid();
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
    password: msg.password.trim(),
    host: { ws, name: d.name },
    guests: new Map(),
    idleTimer: setTimeout(() => destroy(room, "the fort went quiet for too long"), IDLE_MS),
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
  };

  rooms.set(id, room);
  send(ws, "room-created", { room: id, leaderboards: room.leaderboards, gameQueue: gameQueueSnapshot(room) });
}

function onJoin(ws: any, d: WSData, msg: any) {
  if (!msg.name?.trim() || !msg.password?.trim() || !msg.room?.trim())
    return send(ws, "error", { message: "name, password, and fort flag required" });
  if (d.isHost)
    return send(ws, "error", { message: "already in a fort" });

  const room = rooms.get(msg.room.trim());
  if (!room) return send(ws, "error", { message: "fort not found" });
  if (room.password !== msg.password.trim())
    return send(ws, "error", { message: "wrong password" });
  if (room.guests.size >= MAX_GUESTS)
    return send(ws, "error", { message: "fort is full (20 max)" });

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
  if (!msg.name?.trim() || !msg.password?.trim() || !msg.room?.trim())
    return send(ws, "error", { message: "name, password, and fort flag required" });

  const room = rooms.get(msg.room.trim());
  if (!room) return send(ws, "error", { message: "fort not found" });
  if (room.password !== msg.password.trim())
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

  room.activeVote = {
    target,
    starter,
    yes: opts?.auto ? new Set() : new Set([starter]),
    no: new Set(),
    auto: !!opts?.auto,
    timer: setTimeout(() => resolveVote(room), VOTE_DURATION_MS),
  };
  setActiveGame(room, { kind: "vote", by: starter, target });
  broadcast(room, "vote-started", {
    target,
    starter: opts?.starterLabel || starter,
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
  room.rpsGame = { p1, p2 };
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
  room.tttGame = { p1, p2, board: Array(9).fill(""), turn: 0 };
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
  room.saboteur = m[Math.floor(Math.random() * m.length)];
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
  room.rpsGame = { p1: challenger, p2: hostName };
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
  broadcast(room, "rps-started", { p1: room.rpsGame.p1, p2: room.rpsGame.p2 });
}

function onRpsDecline(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame || d.name !== room.rpsGame.p2) return;
  broadcast(room, "rps-declined", { from: d.name });
  room.rpsGame = null;
  if (room.kothGame) room.kothGame = null;
  clearActiveGame(room);
}

function onRpsPick(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || !msg.pick) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.rpsGame) return;
  if (!["rock", "paper", "scissors"].includes(msg.pick)) return;

  if (d.name === room.rpsGame.p1) room.rpsGame.pick1 = msg.pick;
  else if (d.name === room.rpsGame.p2) room.rpsGame.pick2 = msg.pick;
  else return;

  send(ws, "rps-picked", {});

  if (room.rpsGame.pick1 && room.rpsGame.pick2) {
    const { p1, p2, pick1, pick2 } = room.rpsGame;
    let winner: string | null = null;
    if (pick1 !== pick2) {
      const wins: Record<string, string> = { rock: "scissors", scissors: "paper", paper: "rock" };
      winner = wins[pick1!] === pick2 ? p1 : p2;
    }
    const isKoth = !!room.kothGame;
    broadcast(room, "rps-result", { p1, p2, pick1, pick2, winner, koth: isKoth || undefined });
    if (winner) {
      bumpLeaderboard(room, "rps", winner);
      emitLeaderboards(room);
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
  broadcast(room, "ttt-started", { p1: room.tttGame.p1, p2: room.tttGame.p2, board: room.tttGame.board, turn: room.tttGame.turn });
}

function onTttDecline(ws: any, d: WSData) {
  if (!d.roomId || !d.name) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame || d.name !== room.tttGame.p2) return;
  broadcast(room, "ttt-declined", { from: d.name });
  room.tttGame = null;
  clearActiveGame(room);
}

function onTttMove(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !d.name || msg.cell == null) return;
  const room = rooms.get(d.roomId);
  if (!room || !room.tttGame) return;
  const g = room.tttGame;
  const currentPlayer = g.turn % 2 === 0 ? g.p1 : g.p2;
  if (d.name !== currentPlayer) return;
  if (msg.cell < 0 || msg.cell > 8 || g.board[msg.cell]) return;

  g.board[msg.cell] = g.turn % 2 === 0 ? "X" : "O";
  g.turn++;

  const mark = g.board[msg.cell];
  let winner: string | null = null;
  for (const combo of TTT_WINS) {
    if (combo.every(i => g.board[i] === mark)) {
      winner = d.name;
      break;
    }
  }
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

// --- server ---

Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const ip = server.requestIP(req)?.address || "unknown";
      const roomParam = url.searchParams.get("room") || "";
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

    // static files
    if (url.pathname.includes("..")) return new Response("forbidden", { status: 403 });

    // room links: /abc123 → serve index.html
    if (/^\/[a-z0-9]{8}$/.test(url.pathname)) {
      return new Response(Bun.file("./client/dist/index.html"));
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`./client/dist${path}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
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
