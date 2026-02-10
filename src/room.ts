import type { Env } from "./index";

interface WSData {
  name: string;
  hash: string;
  isHost: boolean;
  hostRejected: boolean;
  msgTimestamps: number[];
}

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_MSGS_PER_5S = 10;
const MAX_NAME = 24;
const MAX_MSG = 2000;
const STYLE_COLORS = new Set(['#FF0000','#0000FF','#008000','#FF8C00','#800080','#000000','#FF69B4','#8B4513']);
const GRACE_MS = 15_000;

function sanitizeStyle(s: any): Record<string, any> | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: Record<string, any> = {};
  if (s.bold === true) out.bold = true;
  if (s.italic === true) out.italic = true;
  if (s.underline === true) out.underline = true;
  if (typeof s.color === 'string' && STYLE_COLORS.has(s.color)) out.color = s.color;
  return Object.keys(out).length ? out : undefined;
}

export class Room implements DurableObject {
  private state: DurableObjectState;
  private password: string | null = null;
  private roomId: string = "";
  private tossPillowFrom: string | null = null;
  private disconnected: Map<string, { name: string; wasHost: boolean; timer: ReturnType<typeof setTimeout> }> = new Map();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      this.password = (await state.storage.get("password")) as string || null;
      this.roomId = (await state.storage.get("roomId")) as string || "";
    });
  }

  private log(msg: string) {
    console.log(`[room:${this.roomId || "?"}] ${msg}`);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    const url = new URL(request.url);
    const roomId = url.searchParams.get("room") || "";
    if (roomId && !this.roomId) {
      this.roomId = roomId;
      await this.state.storage.put("roomId", roomId);
    }

    this.log(`ws connect (${this.state.getWebSockets().length} existing)`);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const hash = Math.random().toString(16).slice(2, 6);
    server.serializeAttachment({ name: "", hash, isHost: false, hostRejected: false, msgTimestamps: [] } as WSData);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(message as string);
      switch (msg.type) {
        case "set-up":       await this.onSetUp(ws, msg); break;
        case "join":         this.onJoin(ws, msg); break;
        case "rejoin":       this.onRejoin(ws, msg); break;
        case "chat":         this.onChat(ws, msg); break;
        case "knock-down":   await this.onKnockDown(ws); break;
        case "leave":        await this.onLeave(ws); break;
        case "typing":       this.onTyping(ws); break;
        case "accept-host":  this.onAcceptHost(ws); break;
        case "reject-host":  await this.onRejectHost(ws); break;
        case "toss-pillow": this.onTossPillow(ws, msg); break;
      }
    } catch {}
  }

  async webSocketClose(ws: WebSocket) { await this.onGracefulDisconnect(ws); }
  async webSocketError(ws: WebSocket) { await this.onGracefulDisconnect(ws); }

  async alarm() {
    this.log("idle timeout — destroying");
    await this.destroyRoom("the fort went quiet for too long");
  }

  // --- helpers ---

  private att(ws: WebSocket): WSData {
    return (ws.deserializeAttachment() || { name: "", hash: "0000", isHost: false, hostRejected: false, msgTimestamps: [] }) as WSData;
  }

  private tag(a: WSData): string {
    return a.name ? `${a.name}#${a.hash}` : `?#${a.hash}`;
  }

  private send(ws: WebSocket, type: string, payload: Record<string, unknown> = {}) {
    try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
  }

  private broadcast(type: string, payload: Record<string, unknown> = {}, exclude?: WebSocket) {
    const msg = JSON.stringify({ type, ...payload });
    for (const w of this.state.getWebSockets()) {
      if (w !== exclude) try { w.send(msg); } catch {}
    }
  }

  private getHost(): WebSocket | null {
    for (const w of this.state.getWebSockets()) {
      if (this.att(w).isHost) return w;
    }
    return null;
  }

  private getMembers(): string[] {
    const names: string[] = [];
    for (const w of this.state.getWebSockets()) {
      const a = this.att(w);
      if (a.name) {
        if (a.isHost) names.unshift(a.name);
        else names.push(a.name);
      }
    }
    return names;
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.getMembers());
    if (!taken.has(base)) return base;
    let i = 2;
    while (true) {
      const suffix = String(i);
      const candidate = base.slice(0, MAX_NAME - suffix.length) + suffix;
      if (!taken.has(candidate)) return candidate;
      i++;
    }
  }

  private resetIdle() {
    this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  private async destroyRoom(reason: string) {
    const count = this.state.getWebSockets().length;
    this.log(`destroying (${count} connected) — ${reason}`);
    // clear all grace timers
    for (const [, disc] of this.disconnected) clearTimeout(disc.timer);
    this.disconnected.clear();
    this.broadcast("knocked-down", { reason });
    for (const w of this.state.getWebSockets()) {
      try { w.close(1000, reason); } catch {}
    }
    this.password = null;
    this.roomId = "";
    this.tossPillowFrom = null;
    await this.state.storage.deleteAll();
  }

  // --- handlers ---

  private async onSetUp(ws: WebSocket, msg: { name?: string; password?: string }) {
    if (!msg.name?.trim() || !msg.password?.trim())
      return this.send(ws, "error", { message: "name and password required" });
    if (this.getHost())
      return this.send(ws, "error", { message: "fort already exists" });

    const name = msg.name.trim().slice(0, MAX_NAME);
    this.password = msg.password.trim();
    await this.state.storage.put("password", this.password);

    const prev = this.att(ws);
    const data: WSData = { name, hash: prev.hash, isHost: true, hostRejected: false, msgTimestamps: [] };
    ws.serializeAttachment(data);

    this.log(`created by ${this.tag(data)}`);
    this.send(ws, "room-created", { room: this.roomId });
    this.resetIdle();
  }

  private onJoin(ws: WebSocket, msg: { name?: string; password?: string }) {
    if (!msg.name?.trim() || !msg.password?.trim())
      return this.send(ws, "error", { message: "name and password required" });
    if (!this.getHost())
      return this.send(ws, "error", { message: "fort not found" });
    if (this.password !== msg.password.trim())
      return this.send(ws, "error", { message: "wrong password" });

    const registered = this.state.getWebSockets().filter(w => this.att(w).name);
    if (registered.length > MAX_GUESTS)
      return this.send(ws, "error", { message: "fort is full (20 max)" });

    const name = this.uniqueName(msg.name.trim().slice(0, MAX_NAME));
    const prev = this.att(ws);
    ws.serializeAttachment({ name, hash: prev.hash, isHost: false, hostRejected: false, msgTimestamps: [] } as WSData);

    this.log(`${name}#${prev.hash} joined (${this.getMembers().length} members)`);
    this.send(ws, "joined", { room: this.roomId, members: this.getMembers(), name });
    this.broadcast("member-joined", { name }, ws);
    this.resetIdle();
  }

  private onChat(ws: WebSocket, msg: { text?: string }) {
    if (!msg.text?.trim()) return;
    const a = this.att(ws);
    if (!a.name) return;

    const now = Date.now();
    a.msgTimestamps = a.msgTimestamps.filter(t => now - t < 5000);
    if (a.msgTimestamps.length >= RATE_MSGS_PER_5S)
      return this.send(ws, "error", { message: "slow down" });

    a.msgTimestamps.push(now);
    ws.serializeAttachment(a);

    const style = sanitizeStyle((msg as any).style);
    this.broadcast("message", { from: a.name, text: msg.text.trim().slice(0, MAX_MSG), ...(style ? { style } : {}) });
    this.resetIdle();
  }

  private async onKnockDown(ws: WebSocket) {
    if (!this.att(ws).isHost) return;
    const a = this.att(ws);
    this.log(`knocked down by ${this.tag(a)}`);
    await this.destroyRoom("host knocked it down");
  }

  private async onLeave(ws: WebSocket) {
    // intentional leave — immediate removal, no grace period
    await this.onDisconnect(ws);
  }

  private onTyping(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;
    this.broadcast("typing", { name: a.name }, ws);
  }

  private async offerHost(oldHostName: string) {
    const candidates = this.state.getWebSockets().filter(w => {
      const d = this.att(w);
      return d.name && !d.isHost && !d.hostRejected;
    });

    if (candidates.length === 0) {
      await this.destroyRoom("nobody caught the pillow");
      return;
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const pickData = this.att(pick);
    this.log(`offering host to ${this.tag(pickData)}`);
    this.send(pick, "host-offer", { oldHost: oldHostName });
    this.broadcast("host-offered", { name: pickData.name }, pick);
  }

  private onTossPillow(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !a.isHost || !msg.target) return;

    // find target
    let targetWs: WebSocket | null = null;
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.name === msg.target && !d.isHost) { targetWs = w; break; }
    }
    if (!targetWs) return;

    // demote host to guest
    this.tossPillowFrom = a.name;
    a.isHost = false;
    ws.serializeAttachment(a);

    // send offer to specific target
    this.send(targetWs, "host-offer", { oldHost: a.name });
    this.broadcast("host-offered", { name: msg.target }, targetWs);
  }

  private onAcceptHost(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost || this.getHost()) return;

    a.isHost = true;
    a.hostRejected = false;
    ws.serializeAttachment(a);
    this.tossPillowFrom = null;

    // clear hostRejected for everyone
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.hostRejected) {
        d.hostRejected = false;
        w.serializeAttachment(d);
      }
    }

    this.broadcast("new-host", { name: a.name });
    this.log(`${this.tag(a)} caught the pillow — new host`);
    this.resetIdle();
  }

  private async onRejectHost(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost) return;

    a.hostRejected = true;
    ws.serializeAttachment(a);

    this.broadcast("host-ducked", { name: a.name });
    this.log(`${this.tag(a)} ducked`);

    // if this was a toss-pillow and target rejected, restore original host
    if (this.tossPillowFrom) {
      const origName = this.tossPillowFrom;
      this.tossPillowFrom = null;
      for (const w of this.state.getWebSockets()) {
        const d = this.att(w);
        if (d.name === origName && !d.isHost) {
          d.isHost = true;
          d.hostRejected = false;
          w.serializeAttachment(d);
          // clear rejections
          for (const rw of this.state.getWebSockets()) {
            const rd = this.att(rw);
            if (rd.hostRejected) { rd.hostRejected = false; rw.serializeAttachment(rd); }
          }
          this.broadcast("new-host", { name: origName });
          return;
        }
      }
    }

    // offer to next candidate
    await this.offerHost(a.name);
  }

  private async onDisconnect(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;

    if (a.isHost) {
      this.log(`host ${this.tag(a)} disconnected`);
      try { ws.close(1000, "left"); } catch {}

      // find guests still connected
      const guests = this.state.getWebSockets().filter(w => {
        const d = this.att(w);
        return d.name && !d.isHost;
      });

      if (guests.length === 0) {
        await this.destroyRoom("host left and the fort is empty");
        return;
      }

      this.broadcast("member-left", { name: a.name });
      await this.offerHost(a.name);
    } else {
      this.log(`${this.tag(a)} left (${this.getMembers().length - 1} remaining)`);
      this.broadcast("member-left", { name: a.name }, ws);
      try { ws.close(1000, "left"); } catch {}
    }
  }

  private async onGracefulDisconnect(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;

    const name = a.name;
    const wasHost = a.isHost;
    this.log(`${this.tag(a)} lost connection (grace period starting)`);

    // broadcast away status
    this.broadcast("member-away", { name }, ws);

    // start grace timer
    const timer = setTimeout(async () => {
      this.disconnected.delete(name);
      this.broadcast("member-left", { name });
      if (wasHost) {
        const guests = this.state.getWebSockets().filter(w => {
          const d = this.att(w);
          return d.name && !d.isHost;
        });
        if (guests.length === 0 && !this.getHost()) {
          await this.destroyRoom("host left and the fort is empty");
        } else if (!this.getHost()) {
          await this.offerHost(name);
        }
      }
    }, GRACE_MS);

    this.disconnected.set(name, { name, wasHost, timer });

    // clear from websocket attachment so they don't count as active
    a.name = "";
    a.isHost = false;
    ws.serializeAttachment(a);
    try { ws.close(1000, "grace"); } catch {}
  }

  private onRejoin(ws: WebSocket, msg: { name?: string; password?: string; room?: string }) {
    if (!msg.name?.trim() || !msg.password?.trim())
      return this.send(ws, "error", { message: "name and password required" });
    if (!this.getHost() && this.disconnected.size === 0 && this.state.getWebSockets().filter(w => this.att(w).name).length === 0)
      return this.send(ws, "error", { message: "fort not found" });
    if (this.password !== msg.password?.trim())
      return this.send(ws, "error", { message: "wrong password" });

    const disc = this.disconnected.get(msg.name.trim());
    if (disc) {
      clearTimeout(disc.timer);
      this.disconnected.delete(msg.name.trim());

      const name = disc.name;
      const prev = this.att(ws);
      const isHost = disc.wasHost && !this.getHost();
      ws.serializeAttachment({ name, hash: prev.hash, isHost, hostRejected: false, msgTimestamps: [] } as WSData);

      this.log(`${name} rejoined (wasHost=${disc.wasHost}, isHost=${isHost})`);
      this.send(ws, "rejoined", { room: this.roomId, members: this.getMembers(), name, isHost });
      this.broadcast("member-back", { name }, ws);
      this.resetIdle();
    } else {
      // grace expired, fall back to normal join
      this.onJoin(ws, msg as any);
    }
  }
}
