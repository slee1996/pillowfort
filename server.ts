const PORT = parseInt(process.env.PORT || "3000");

// --- types ---

interface WSData {
  roomId: string | null;
  isHost: boolean;
  hostRejected: boolean;
  name: string;
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
  disconnected: Map<string, { name: string; wasHost: boolean; timer: ReturnType<typeof setTimeout>; ip: string }>;
}

// --- state (memory only, never persisted) ---

const rooms = new Map<string, Room>();
const roomCreationByIP = new Map<string, number[]>();

// --- constants ---

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_ROOMS_PER_MIN = 5;
const RATE_MSGS_PER_5S = 10;
const MAX_NAME_LEN = 24;
const MAX_MSG_LEN = 2000;
const STYLE_COLORS = new Set(['#FF0000','#0000FF','#008000','#FF8C00','#800080','#000000','#FF69B4','#8B4513']);
const GRACE_MS = 15_000;

// --- helpers ---

function rid(): string {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += c[Math.floor(Math.random() * c.length)];
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

function resetIdle(room: Room) {
  clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => destroy(room, "the fort went quiet for too long"), IDLE_MS);
}

function destroy(room: Room, reason: string) {
  clearTimeout(room.idleTimer);
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

function uniqueName(base: string, room: Room): string {
  const taken = new Set(members(room));
  if (!taken.has(base)) return base;
  let i = 2;
  while (true) {
    const suffix = String(i);
    const candidate = base.slice(0, MAX_NAME_LEN - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
    i++;
  }
}

function rateLimitedMsg(data: WSData): boolean {
  const now = Date.now();
  data.msgTimestamps = data.msgTimestamps.filter(t => now - t < 5_000);
  return data.msgTimestamps.length >= RATE_MSGS_PER_5S;
}

function sanitizeStyle(s: any): Record<string, any> | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: Record<string, any> = {};
  if (s.bold === true) out.bold = true;
  if (s.italic === true) out.italic = true;
  if (s.underline === true) out.underline = true;
  if (typeof s.color === 'string' && STYLE_COLORS.has(s.color)) out.color = s.color;
  return Object.keys(out).length ? out : undefined;
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
  };

  rooms.set(id, room);
  send(ws, "room-created", { room: id });
}

function onJoin(ws: any, d: WSData, msg: any) {
  if (!msg.name?.trim() || !msg.password?.trim() || !msg.room?.trim())
    return send(ws, "error", { message: "name, password, and fort code required" });
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
  d.name = uniqueName(msg.name.trim().slice(0, MAX_NAME_LEN), room);

  room.guests.set(ws, d.name);
  send(ws, "joined", { room: room.id, members: members(room), name: d.name });
  broadcast(room, "member-joined", { name: d.name }, ws);
  resetIdle(room);
}

function onChat(ws: any, d: WSData, msg: any) {
  if (!d.roomId || !msg.text?.trim()) return;
  if (rateLimitedMsg(d))
    return send(ws, "error", { message: "slow down" });

  d.msgTimestamps.push(Date.now());
  const room = rooms.get(d.roomId);
  if (!room) return;

  const style = sanitizeStyle(msg.style);
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
    if (wasHost) {
      if (room.guests.size === 0 && !room.host) {
        destroy(room, "host left and the fort is empty");
      } else if (!room.host) {
        offerHost(room, name);
      }
    }
  }, GRACE_MS);

  room.disconnected.set(name, { name, wasHost, timer, ip: d.ip });
  d.roomId = null;
}

function onRejoin(ws: any, d: WSData, msg: any) {
  if (!msg.name?.trim() || !msg.password?.trim() || !msg.room?.trim())
    return send(ws, "error", { message: "name, password, and fort code required" });

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

    if (disc.wasHost && !room.host) {
      d.isHost = true;
      room.host = { ws, name: d.name };
    } else {
      d.isHost = false;
      room.guests.set(ws, d.name);
    }

    send(ws, "rejoined", { room: room.id, members: members(room), name: d.name, isHost: d.isHost });
    broadcast(room, "member-back", { name: d.name }, ws);
    resetIdle(room);
  } else {
    // grace expired, fall back to normal join
    onJoin(ws, d, msg);
  }
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
        data: { roomId: roomParam || null, isHost: false, hostRejected: false, name: "", hash: Math.random().toString(16).slice(2, 6), ip, msgTimestamps: [] } satisfies WSData,
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    // static files
    if (url.pathname.includes("..")) return new Response("forbidden", { status: 403 });
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`./public${path}`);
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
          case "leave":        onLeave(ws, d); break;
          case "accept-host":  onAcceptHost(ws, d); break;
          case "reject-host":  onRejectHost(ws, d); break;
          case "toss-pillow":  onTossPillow(ws, d, msg); break;
        }
      } catch {}
    },
    close(ws) { onDisconnect(ws, ws.data as WSData); },
  },
});

console.log(`pillowfort :${PORT}`);
