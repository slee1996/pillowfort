import type { Env } from "./index";
import { sanitizeStyle, uniqueName, MAX_NAME_LEN, MAX_MSG_LEN, GRACE_MS } from "./shared";

interface WSData {
  name: string;
  hash: string;
  isHost: boolean;
  hostRejected: boolean;
  status: "available" | "away";
  awayText: string | null;
  msgTimestamps: number[];
}

const MAX_GUESTS = 20;
const IDLE_MS = 10 * 60 * 1000;
const RATE_MSGS_PER_5S = 10;
const VOTE_DURATION_MS = 30_000;
const SABOTEUR_VOTE_MS = 30_000;
const SABOTEUR_MIN_PLAYERS = 4;
const SAB_BOMB_MS = (() => {
  try {
    const raw = parseInt(process.env.SAB_BOMB_MS || (process.env.NODE_ENV === "test" ? "1200" : "10000"));
    return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
  } catch {
    return 10_000;
  }
})();
const SAB_BOMB_SECONDS = Math.max(1, Math.ceil(SAB_BOMB_MS / 1000));
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const MAX_ENC_B64_LEN = 4096;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
const ALLOW_LEGACY_PLAINTEXT = false;

interface EncryptedChatPayload {
  v: 1 | 2 | 3;
  kdf?: string;
  sid?: string;
  seq?: number;
  iv: string;
  ct: string;
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

function createLeaderboards(): RoomLeaderboards {
  return {
    pillowFight: {},
    rps: {},
    ttt: {},
    saboteur: {},
    koth: {},
  };
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

export class Room implements DurableObject {
  private state: DurableObjectState;
  private authVerifier: string | null = null;
  private roomId: string = "";
  private tossPillowFrom: string | null = null;
  private disconnected: Map<string, {
    name: string;
    wasHost: boolean;
    status: "available" | "away";
    awayText: string | null;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  // --- game state ---
  private activeVote: { target: string; starter: string; yes: Set<string>; no: Set<string>; timer: ReturnType<typeof setTimeout>; auto?: boolean } | null = null;
  private rpsGame: { p1: string; p2: string; pick1?: string; pick2?: string } | null = null;
  private tttGame: { p1: string; p2: string; board: string[]; turn: number } | null = null;
  private saboteur: string | null = null;
  private saboteurActive = false;
  private sabStrikes = 0;
  private sabVote: {
    accuser: string;
    suspect: string;
    yes: Set<string>;
    no: Set<string>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private sabCanStrike = false;
  private sabBombTimer: ReturnType<typeof setTimeout> | null = null;
  private activeGame: GameQueueItem | null = null;
  private gameQueue: GameQueueItem[] = [];
  private leaderboards: RoomLeaderboards = createLeaderboards();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      this.authVerifier = (await state.storage.get("authVerifier")) as string || null;
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
    server.serializeAttachment({ name: "", hash, isHost: false, hostRejected: false, status: "available", awayText: null, msgTimestamps: [] } as WSData);

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
        case "set-status":   this.onSetStatus(ws, msg); break;
        case "accept-host":  this.onAcceptHost(ws); break;
        case "reject-host":  await this.onRejectHost(ws); break;
        case "toss-pillow": this.onTossPillow(ws, msg); break;
        case "draw":        this.onDraw(ws, msg); break;
        // --- pvp games ---
        case "start-vote":    this.onStartVote(ws, msg); break;
        case "cast-vote":     this.onCastVote(ws, msg); break;
        case "rps-challenge": this.onRpsChallenge(ws, msg); break;
        case "rps-accept":    this.onRpsAccept(ws); break;
        case "rps-decline":   this.onRpsDecline(ws); break;
        case "rps-pick":      this.onRpsPick(ws, msg); break;
        case "ttt-challenge": this.onTttChallenge(ws, msg); break;
        case "ttt-accept":    this.onTttAccept(ws); break;
        case "ttt-decline":   this.onTttDecline(ws); break;
        case "ttt-move":      this.onTttMove(ws, msg); break;
        case "sab-start":     this.onSabStart(ws); break;
        case "sab-accuse":    this.onSabAccuse(ws, msg); break;
        case "sab-strike":    this.onSabStrike(ws); break;
        case "sab-vote":      this.onSabVote(ws, msg); break;
        case "koth-challenge": this.onKothChallenge(ws); break;
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
    return (ws.deserializeAttachment() || {
      name: "",
      hash: "0000",
      isHost: false,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
    }) as WSData;
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

  private emitLeaderboards(exclude?: WebSocket) {
    this.broadcast("leaderboards", { leaderboards: this.leaderboards }, exclude);
  }

  private gameQueueSnapshot(): RoomGameQueue {
    return {
      current: this.activeGame ? { ...this.activeGame } : null,
      queue: this.gameQueue.map((q) => ({ ...q })),
    };
  }

  private emitGameQueue(exclude?: WebSocket) {
    this.broadcast("game-queue", { gameQueue: this.gameQueueSnapshot() }, exclude);
  }

  private sameGameRequest(a: GameQueueItem, b: GameQueueItem): boolean {
    return a.kind === b.kind && a.by === b.by && (a.target || "") === (b.target || "");
  }

  private queueGame(req: GameQueueItem, ws?: WebSocket): boolean {
    if (this.activeGame && this.sameGameRequest(this.activeGame, req)) return false;
    if (this.gameQueue.some((q) => this.sameGameRequest(q, req))) return false;
    this.gameQueue.push(req);
    this.emitGameQueue();
    if (ws) this.send(ws, "game-queued", { ...req, position: this.gameQueue.length });
    return true;
  }

  private setActiveGame(current: GameQueueItem | null) {
    this.activeGame = current;
    this.emitGameQueue();
  }

  private clearActiveGame(drain = true) {
    if (!this.activeGame) return;
    this.activeGame = null;
    this.emitGameQueue();
    if (drain) this.drainGameQueue();
  }

  private pruneGameQueue() {
    const nowMembers = new Set(this.getMembers());
    const next = this.gameQueue.filter((q) => nowMembers.has(q.by) && (!q.target || nowMembers.has(q.target)));
    if (next.length !== this.gameQueue.length) {
      this.gameQueue = next;
      this.emitGameQueue();
    }
  }

  private drainGameQueue() {
    if (this.activeGame) return;
    while (this.gameQueue.length > 0) {
      const req = this.gameQueue.shift()!;
      const nowMembers = this.getMembers();
      if (!nowMembers.includes(req.by)) continue;
      if (req.target && !nowMembers.includes(req.target)) continue;
      let started = false;
      switch (req.kind) {
        case "vote":
          started = !!(req.target && this.startVote(req.by, req.target));
          break;
        case "rps":
          started = !!(req.target && this.startRps(req.by, req.target));
          break;
        case "ttt":
          started = !!(req.target && this.startTtt(req.by, req.target));
          break;
        case "saboteur":
          started = this.startSaboteur(req.by);
          break;
        case "koth":
          started = this.startKoth(req.by);
          break;
      }
      if (started) return;
    }
    this.emitGameQueue();
  }

  private bumpLeaderboard(game: keyof RoomLeaderboards, name: string, amount = 1) {
    if (!name) return;
    this.leaderboards[game][name] = (this.leaderboards[game][name] || 0) + amount;
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

  private presenceOf(a: WSData): { status: "available" | "away"; awayText?: string } {
    const p: { status: "available" | "away"; awayText?: string } = { status: a.status || "available" };
    if (a.status === "away" && a.awayText) p.awayText = a.awayText;
    return p;
  }

  private getPresenceMap(): Record<string, { status: "available" | "away"; awayText?: string }> {
    const out: Record<string, { status: "available" | "away"; awayText?: string }> = {};
    for (const w of this.state.getWebSockets()) {
      const a = this.att(w);
      if (a.name) out[a.name] = this.presenceOf(a);
    }
    return out;
  }

  private resetIdle() {
    this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  private async destroyRoom(reason: string) {
    const count = this.state.getWebSockets().length;
    this.log(`destroying (${count} connected) — ${reason}`);
    if (this.sabVote) {
      clearTimeout(this.sabVote.timer);
      this.sabVote = null;
    }
    if (this.sabBombTimer) {
      clearTimeout(this.sabBombTimer);
      this.sabBombTimer = null;
    }
    // clear all grace timers
    for (const [, disc] of this.disconnected) clearTimeout(disc.timer);
    this.disconnected.clear();
    this.broadcast("knocked-down", { reason });
    for (const w of this.state.getWebSockets()) {
      try { w.close(1000, reason); } catch {}
    }
    this.authVerifier = null;
    this.roomId = "";
    this.tossPillowFrom = null;
    await this.state.storage.deleteAll();
  }

  // --- handlers ---

  private async onSetUp(ws: WebSocket, msg: { name?: string; auth?: unknown }) {
    if (!msg.name?.trim() || !validAuth(msg.auth))
      return this.send(ws, "error", { message: "name and password required" });
    if (this.getHost())
      return this.send(ws, "error", { message: "fort already exists" });

    const name = msg.name.trim().slice(0, MAX_NAME_LEN);
    this.authVerifier = msg.auth.verifier;
    await this.state.storage.put("authVerifier", this.authVerifier);

    const prev = this.att(ws);
    const data: WSData = {
      name,
      hash: prev.hash,
      isHost: true,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
    };
    ws.serializeAttachment(data);

    this.log(`created by ${this.tag(data)}`);
    this.send(ws, "room-created", { room: this.roomId, leaderboards: this.leaderboards, gameQueue: this.gameQueueSnapshot() });
    this.resetIdle();
  }

  private onJoin(ws: WebSocket, msg: { name?: string; auth?: unknown }) {
    if (!msg.name?.trim() || !validAuth(msg.auth))
      return this.send(ws, "error", { message: "name and password required" });
    if (!this.getHost())
      return this.send(ws, "error", { message: "fort not found" });
    if (this.authVerifier !== msg.auth.verifier)
      return this.send(ws, "error", { message: "wrong password" });

    const registered = this.state.getWebSockets().filter(w => this.att(w).name);
    if (registered.length > MAX_GUESTS)
      return this.send(ws, "error", { message: "fort is full (20 max)" });

    const name = uniqueName(msg.name.trim().slice(0, MAX_NAME_LEN), new Set(this.getMembers()));
    const prev = this.att(ws);
    ws.serializeAttachment({
      name,
      hash: prev.hash,
      isHost: false,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
    } as WSData);

    this.log(`${name}#${prev.hash} joined (${this.getMembers().length} members)`);
    this.send(ws, "joined", {
      room: this.roomId,
      members: this.getMembers(),
      name,
      presence: this.getPresenceMap(),
      leaderboards: this.leaderboards,
      gameQueue: this.gameQueueSnapshot(),
    });
    this.broadcast("member-joined", { name, presence: this.presenceOf(this.att(ws)) }, ws);
    this.resetIdle();
  }

  private onChat(ws: WebSocket, msg: { text?: string; enc?: unknown }) {
    const a = this.att(ws);
    if (!a.name) return;

    const now = Date.now();
    a.msgTimestamps = a.msgTimestamps.filter(t => now - t < 5000);
    if (a.msgTimestamps.length >= RATE_MSGS_PER_5S)
      return this.send(ws, "error", { message: "slow down" });

    a.msgTimestamps.push(now);
    ws.serializeAttachment(a);

    const enc = sanitizeEncryptedChat(msg.enc);
    const style = sanitizeStyle((msg as any).style);
    if (enc) {
      this.broadcast("message", { from: a.name, enc, ...(style ? { style } : {}) });
      this.resetIdle();
      return;
    }

    if (!ALLOW_LEGACY_PLAINTEXT) return this.send(ws, "error", { message: "encrypted chat required" });
    if (!msg.text?.trim()) return;
    this.broadcast("message", { from: a.name, text: msg.text.trim().slice(0, MAX_MSG_LEN), ...(style ? { style } : {}) });
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

  private onSetStatus(ws: WebSocket, msg: { status?: string; awayText?: string }) {
    const a = this.att(ws);
    if (!a.name) return;
    if (msg.status !== "available" && msg.status !== "away") return;

    a.status = msg.status;
    if (a.status === "away") {
      const text = typeof msg.awayText === "string" ? msg.awayText.trim().slice(0, 120) : "";
      a.awayText = text || null;
    } else {
      a.awayText = null;
    }
    ws.serializeAttachment(a);

    this.broadcast("member-status", { name: a.name, status: a.status, awayText: a.awayText });
    this.resetIdle();
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

  private onDraw(ws: WebSocket, msg: { color?: string; pts?: number[][]; s?: number }) {
    const a = this.att(ws);
    if (!a.name || !msg.pts?.length) return;
    const payload: Record<string, unknown> = { from: a.name, color: msg.color, pts: msg.pts };
    if (msg.s) payload.s = 1;
    this.broadcast("draw", payload, ws);
  }

  private startVote(
    starter: string,
    target: string,
    opts?: { auto?: boolean; starterLabel?: string }
  ): boolean {
    if (this.activeVote) return false;
    if (!opts?.auto && starter === target) return false;
    const m = this.getMembers();
    if (!m.includes(target)) return false;
    if (!opts?.auto && !m.includes(starter)) return false;
    if (m.length < 3) return false;

    this.activeVote = {
      target,
      starter,
      yes: opts?.auto ? new Set() : new Set([starter]),
      no: new Set(),
      auto: !!opts?.auto,
      timer: setTimeout(() => this.resolveVote(), VOTE_DURATION_MS),
    };
    this.setActiveGame({ kind: "vote", by: starter, target });
    this.broadcast("vote-started", {
      target,
      starter: opts?.starterLabel || starter,
      ...(opts?.auto ? { auto: true } : {}),
    });
    return true;
  }

  private startRps(p1: string, p2: string): boolean {
    if (this.rpsGame) return false;
    const m = this.getMembers();
    if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
    const tw = this.findWs(p2);
    if (!tw) return false;
    this.rpsGame = { p1, p2 };
    this.setActiveGame({ kind: "rps", by: p1, target: p2 });
    this.send(tw, "rps-challenged", { from: p1 });
    this.broadcast("rps-pending", { p1, p2 });
    return true;
  }

  private startTtt(p1: string, p2: string): boolean {
    if (this.tttGame) return false;
    const m = this.getMembers();
    if (!m.includes(p1) || !m.includes(p2) || p1 === p2) return false;
    const tw = this.findWs(p2);
    if (!tw) return false;
    this.tttGame = { p1, p2, board: Array(9).fill(""), turn: 0 };
    this.setActiveGame({ kind: "ttt", by: p1, target: p2 });
    this.send(tw, "ttt-challenged", { from: p1 });
    this.broadcast("ttt-pending", { p1, p2 });
    return true;
  }

  private startSaboteur(starter: string): boolean {
    if (this.saboteurActive) return false;
    const members = this.getMembers();
    if (!members.includes(starter)) return false;
    if (members.length < SABOTEUR_MIN_PLAYERS) return false;

    this.saboteurActive = true;
    this.sabStrikes = 0;
    this.sabCanStrike = true;
    this.saboteur = members[Math.floor(Math.random() * members.length)];
    this.setActiveGame({ kind: "saboteur", by: starter });
    this.log(`saboteur mode started — ${this.saboteur} is the saboteur`);

    this.broadcast("sab-started", { starter });
    const sabWs = this.findWs(this.saboteur);
    if (sabWs) this.send(sabWs, "sab-role", { role: "saboteur", canStrike: true });
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.name && d.name !== this.saboteur) this.send(w, "sab-role", { role: "defender" });
    }
    return true;
  }

  private startKoth(challenger: string): boolean {
    const cw = this.findWs(challenger);
    if (!cw) return false;
    const cd = this.att(cw);
    if (cd.isHost) return false;
    if (this.rpsGame) return false;
    const hostWs = this.getHost();
    if (!hostWs) return false;
    const hostName = this.att(hostWs).name;
    if (!hostName) return false;

    this.kothGame = { challenger, host: hostName };
    this.rpsGame = { p1: challenger, p2: hostName };
    this.setActiveGame({ kind: "koth", by: challenger, target: hostName });
    this.broadcast("koth-started", { challenger, host: hostName });
    this.broadcast("rps-started", { p1: challenger, p2: hostName, koth: true });
    this.log(`${challenger} challenged ${hostName} for the crown`);
    return true;
  }

  // ============ PILLOW FIGHT (vote to eject) ============

  private onStartVote(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target) return;
    if (msg.target === a.name) return this.send(ws, "error", { message: "you can't vote yourself out" });
    if (!this.getMembers().includes(msg.target)) return;
    if (this.getMembers().length < 3) return this.send(ws, "error", { message: "need at least 3 people to start a vote" });
    if (this.activeGame) {
      this.queueGame({ kind: "vote", by: a.name, target: msg.target }, ws);
      return;
    }
    if (this.activeVote) return this.send(ws, "error", { message: "a vote is already in progress" });

    if (this.startVote(a.name, msg.target)) {
      this.log(`${a.name} started vote to eject ${msg.target}`);
    } else {
      this.send(ws, "error", { message: "could not start vote right now" });
    }
  }

  private onCastVote(ws: WebSocket, msg: { vote?: string }) {
    const a = this.att(ws);
    if (!a.name || !this.activeVote) return;
    if (a.name === this.activeVote.target) return; // target can't vote
    if (this.activeVote.yes.has(a.name) || this.activeVote.no.has(a.name)) return; // already voted

    if (msg.vote === "yes") this.activeVote.yes.add(a.name);
    else this.activeVote.no.add(a.name);

    this.broadcast("vote-cast", { voter: a.name, vote: msg.vote });

    // check if everyone (except target) has voted
    const eligible = this.getMembers().filter(n => n !== this.activeVote!.target).length;
    const total = this.activeVote.yes.size + this.activeVote.no.size;
    if (total >= eligible) this.resolveVote();
  }

  private resolveVote() {
    if (!this.activeVote) return;
    clearTimeout(this.activeVote.timer);
    const { target, yes, no, starter, auto } = this.activeVote;
    const ejected = yes.size > no.size;
    this.broadcast("vote-result", { target, yes: yes.size, no: no.size, ejected });
    this.log(`vote result: ${target} ${ejected ? "ejected" : "stays"} (${yes.size}-${no.size})`);
    if (!auto) {
      if (ejected) this.bumpLeaderboard("pillowFight", starter);
      else this.bumpLeaderboard("pillowFight", target);
      this.emitLeaderboards();
    }

    if (ejected) {
      // kick the target
      for (const w of this.state.getWebSockets()) {
        if (this.att(w).name === target) {
          this.send(w, "ejected", { reason: "You were voted out of the fort!" });
          try { w.close(1000, "ejected"); } catch {}
          const d = this.att(w); d.name = ""; w.serializeAttachment(d);
          break;
        }
      }
      this.broadcast("member-left", { name: target });
      this.pruneGameQueue();
    }
    this.activeVote = null;
    this.clearActiveGame();
  }

  // ============ ROCK PAPER SCISSORS ============

  private findWs(name: string): WebSocket | null {
    for (const w of this.state.getWebSockets()) {
      if (this.att(w).name === name) return w;
    }
    return null;
  }

  private onRpsChallenge(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target || a.name === msg.target) return;
    if (this.activeGame) {
      this.queueGame({ kind: "rps", by: a.name, target: msg.target }, ws);
      return;
    }
    if (this.rpsGame) return this.send(ws, "error", { message: "a duel is already in progress" });
    if (!this.findWs(msg.target)) return;
    if (this.startRps(a.name, msg.target)) {
      this.log(`${a.name} challenged ${msg.target} to RPS`);
    } else {
      this.send(ws, "error", { message: "could not start RPS right now" });
    }
  }

  private onRpsAccept(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.rpsGame || a.name !== this.rpsGame.p2) return;
    this.broadcast("rps-started", { p1: this.rpsGame.p1, p2: this.rpsGame.p2 });
  }

  private onRpsDecline(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.rpsGame || a.name !== this.rpsGame.p2) return;
    this.broadcast("rps-declined", { from: a.name });
    this.rpsGame = null;
    if (this.kothGame) this.kothGame = null;
    this.clearActiveGame();
  }

  private onRpsPick(ws: WebSocket, msg: { pick?: string }) {
    const a = this.att(ws);
    if (!this.rpsGame || !msg.pick) return;
    if (!["rock", "paper", "scissors"].includes(msg.pick)) return;

    if (a.name === this.rpsGame.p1) this.rpsGame.pick1 = msg.pick;
    else if (a.name === this.rpsGame.p2) this.rpsGame.pick2 = msg.pick;
    else return;

    this.send(ws, "rps-picked", {}); // confirm to sender

    if (this.rpsGame.pick1 && this.rpsGame.pick2) {
      const { p1, p2, pick1, pick2 } = this.rpsGame;
      let winner: string | null = null;
      if (pick1 !== pick2) {
        const wins: Record<string, string> = { rock: "scissors", scissors: "paper", paper: "rock" };
        winner = wins[pick1!] === pick2 ? p1 : p2;
      }
      const isKoth = !!this.kothGame;
      this.broadcast("rps-result", { p1, p2, pick1, pick2, winner, koth: isKoth || undefined });
      this.log(`RPS: ${p1}(${pick1}) vs ${p2}(${pick2}) → ${winner || "draw"}`);
      if (winner) {
        this.bumpLeaderboard("rps", winner);
        this.emitLeaderboards();
      }
      this.rpsGame = null;
      if (isKoth && winner) this.resolveKoth(winner);
      else if (isKoth) {
        this.kothGame = null; // draw = no change
        this.clearActiveGame();
      } else {
        this.clearActiveGame();
      }
    }
  }

  // ============ TIC-TAC-TOE ============

  private onTttChallenge(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target || a.name === msg.target) return;
    if (this.activeGame) {
      this.queueGame({ kind: "ttt", by: a.name, target: msg.target }, ws);
      return;
    }
    if (this.tttGame) return this.send(ws, "error", { message: "a game is already in progress" });
    if (!this.findWs(msg.target)) return;
    if (!this.startTtt(a.name, msg.target)) {
      this.send(ws, "error", { message: "could not start Tic-Tac-Toe right now" });
    }
  }

  private onTttAccept(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.tttGame || a.name !== this.tttGame.p2) return;
    this.broadcast("ttt-started", { p1: this.tttGame.p1, p2: this.tttGame.p2, board: this.tttGame.board, turn: this.tttGame.turn });
  }

  private onTttDecline(ws: WebSocket) {
    const a = this.att(ws);
    if (!this.tttGame || a.name !== this.tttGame.p2) return;
    this.broadcast("ttt-declined", { from: a.name });
    this.tttGame = null;
    this.clearActiveGame();
  }

  private onTttMove(ws: WebSocket, msg: { cell?: number }) {
    const a = this.att(ws);
    if (!this.tttGame || msg.cell == null) return;
    const g = this.tttGame;
    const currentPlayer = g.turn % 2 === 0 ? g.p1 : g.p2;
    if (a.name !== currentPlayer) return;
    if (msg.cell < 0 || msg.cell > 8 || g.board[msg.cell]) return;

    g.board[msg.cell] = g.turn % 2 === 0 ? "X" : "O";
    g.turn++;

    // check win
    const mark = g.board[msg.cell];
    let winner: string | null = null;
    for (const combo of TTT_WINS) {
      if (combo.every(i => g.board[i] === mark)) {
        winner = a.name;
        break;
      }
    }
    const draw = !winner && g.board.every(c => c);

    this.broadcast("ttt-update", { board: g.board, turn: g.turn, lastMove: msg.cell, winner, draw });
    if (winner) {
      this.bumpLeaderboard("ttt", winner);
      this.emitLeaderboards();
    }
    if (winner || draw) {
      this.log(`TTT: ${g.p1} vs ${g.p2} → ${winner ? winner + " wins" : "draw"}`);
      this.tttGame = null;
      this.clearActiveGame();
    }
  }

  // ============ SECRET SABOTEUR ============

  private onSabStart(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name) return;
    if (this.saboteurActive) return this.send(ws, "error", { message: "saboteur mode is already active" });
    const members = this.getMembers();
    if (members.length < SABOTEUR_MIN_PLAYERS)
      return this.send(ws, "error", { message: `need at least ${SABOTEUR_MIN_PLAYERS} people` });
    if (this.activeGame) {
      this.queueGame({ kind: "saboteur", by: a.name }, ws);
      return;
    }
    if (!this.startSaboteur(a.name)) {
      this.send(ws, "error", { message: "could not start Saboteur right now" });
    }
  }

  private onSabAccuse(ws: WebSocket, msg: { suspect?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.suspect || !this.saboteurActive) return;
    if (this.sabVote) return this.send(ws, "error", { message: "an accusation vote is already in progress" });
    if (a.name === this.saboteur) return this.send(ws, "error", { message: "saboteur can't accuse" });
    if (!this.getMembers().includes(msg.suspect)) return;
    if (msg.suspect === a.name) return this.send(ws, "error", { message: "you can't accuse yourself" });

    this.sabVote = {
      accuser: a.name,
      suspect: msg.suspect,
      yes: new Set([a.name]),
      no: new Set(),
      timer: setTimeout(() => this.resolveSabVote(), SABOTEUR_VOTE_MS),
    };
    this.broadcast("sab-vote-start", {
      accuser: a.name,
      suspect: msg.suspect,
      duration: SABOTEUR_VOTE_MS,
    });
    this.log(`sab accusation started: ${a.name} accused ${msg.suspect}`);
  }

  private onSabVote(ws: WebSocket, msg: { vote?: string }) {
    const a = this.att(ws);
    if (!a.name || !this.sabVote || !this.saboteurActive) return;
    if (msg.vote !== "yes" && msg.vote !== "no") return;

    this.sabVote.yes.delete(a.name);
    this.sabVote.no.delete(a.name);
    if (msg.vote === "yes") this.sabVote.yes.add(a.name);
    else this.sabVote.no.add(a.name);

    const total = this.sabVote.yes.size + this.sabVote.no.size;
    if (total >= this.getMembers().length) this.resolveSabVote();
  }

  private resolveSabVote() {
    if (!this.sabVote || !this.saboteurActive) return;
    clearTimeout(this.sabVote.timer);
    const { accuser, suspect, yes, no } = this.sabVote;
    const passed = yes.size > no.size;
    const correct = passed && suspect === this.saboteur;
    this.broadcast("sab-vote-result", {
      accuser,
      accused: suspect,
      yes: yes.size,
      no: no.size,
      passed,
      wasSaboteur: correct,
      saboteur: correct ? this.saboteur : null
    });
    this.log(`sab vote: ${suspect} accused (${correct ? "correct!" : "wrong"})`);

    if (correct) {
      // saboteur caught!
      const sabName = this.saboteur!;
      for (const defender of this.getMembers()) {
        if (defender !== sabName) this.bumpLeaderboard("saboteur", defender);
      }
      this.emitLeaderboards();
      this.saboteurActive = false;
      this.sabCanStrike = false;
      this.saboteur = null;
      this.sabVote = null;

      // auto-start pillow fight vote against the caught saboteur
      this.clearActiveGame(false);
      if (!this.activeVote && this.getMembers().length >= 3 && this.getMembers().includes(sabName)) {
        this.startVote(sabName, sabName, { auto: true, starterLabel: "the fort" });
        this.log(`auto pillow fight started against caught saboteur ${sabName}`);
      } else {
        this.drainGameQueue();
      }
    } else {
      this.sabVote = null;
      if (!this.sabCanStrike && this.saboteur) {
        this.sabCanStrike = true;
        const sabWs = this.findWs(this.saboteur);
        if (sabWs) this.send(sabWs, "sab-strike-ready", { reason: "wrong-accusation" });
      }
    }
  }

  private onSabStrike(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || !this.saboteurActive || a.name !== this.saboteur) return;
    if (!this.sabCanStrike) return this.send(ws, "error", { message: "you can strike after a wrong accusation vote" });

    this.sabCanStrike = false;
    this.sabStrikes++;
    this.broadcast("sab-strike", { saboteur: a.name, strikes: this.sabStrikes });
    this.log(`saboteur ${a.name} struck! (${this.sabStrikes}/3)`);

    if (this.sabStrikes >= 3) {
      // The saboteur plants a bomb. Let chat continue during countdown.
      this.bumpLeaderboard("saboteur", a.name);
      this.emitLeaderboards();
      this.saboteurActive = false;
      this.sabCanStrike = false;
      this.saboteur = null;
      if (this.sabVote) { clearTimeout(this.sabVote.timer); this.sabVote = null; }
      if (this.sabBombTimer) clearTimeout(this.sabBombTimer);
      this.broadcast("sab-bomb-start", { saboteur: a.name, seconds: SAB_BOMB_SECONDS, durationMs: SAB_BOMB_MS });
      this.sabBombTimer = setTimeout(() => {
        this.sabBombTimer = null;
        this.destroyRoom("the saboteur's bomb exploded!");
      }, SAB_BOMB_MS);
    }
  }

  // ============ KING OF THE HILL ============

  private kothGame: { challenger: string; host: string } | null = null;

  private onKothChallenge(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost) return this.send(ws, "error", { message: "only non-hosts can challenge" });
    const hostWs = this.getHost();
    if (!hostWs) return;
    if (this.activeGame) {
      this.queueGame({ kind: "koth", by: a.name, target: this.att(hostWs).name }, ws);
      return;
    }
    if (this.rpsGame) return this.send(ws, "error", { message: "a duel is already in progress" });
    if (!this.startKoth(a.name)) {
      this.send(ws, "error", { message: "could not start KOTH right now" });
    }
  }

  // Called from RPS result to swap host if challenger wins
  private resolveKoth(winner: string | null) {
    if (!this.kothGame) return;
    const { challenger, host } = this.kothGame;
    this.kothGame = null;

    if (winner === challenger) {
      // swap host
      const hostWs = this.findWs(host);
      const challWs = this.findWs(challenger);
      if (hostWs) { const d = this.att(hostWs); d.isHost = false; hostWs.serializeAttachment(d); }
      if (challWs) { const d = this.att(challWs); d.isHost = true; challWs.serializeAttachment(d); }
      this.bumpLeaderboard("koth", challenger);
      this.emitLeaderboards();
      this.broadcast("new-host", { name: challenger });
      this.broadcast("koth-result", { winner: challenger, loser: host });
      this.log(`KOTH: ${challenger} dethroned ${host}`);
    } else {
      this.bumpLeaderboard("koth", host);
      this.emitLeaderboards();
      this.broadcast("koth-result", { winner: host, loser: challenger });
      this.log(`KOTH: ${host} defended the crown`);
    }
    this.clearActiveGame();
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
      this.pruneGameQueue();
      await this.offerHost(a.name);
    } else {
      this.log(`${this.tag(a)} left (${this.getMembers().length - 1} remaining)`);
      this.broadcast("member-left", { name: a.name }, ws);
      this.pruneGameQueue();
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
      this.pruneGameQueue();
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

    this.disconnected.set(name, { name, wasHost, status: a.status, awayText: a.awayText, timer });

    // clear from websocket attachment so they don't count as active
    a.name = "";
    a.isHost = false;
    ws.serializeAttachment(a);
    try { ws.close(1000, "grace"); } catch {}
  }

  private onRejoin(ws: WebSocket, msg: { name?: string; auth?: unknown; room?: string }) {
    if (!msg.name?.trim() || !validAuth(msg.auth))
      return this.send(ws, "error", { message: "name and password required" });
    if (!this.getHost() && this.disconnected.size === 0 && this.state.getWebSockets().filter(w => this.att(w).name).length === 0)
      return this.send(ws, "error", { message: "fort not found" });
    if (this.authVerifier !== msg.auth.verifier)
      return this.send(ws, "error", { message: "wrong password" });

    const disc = this.disconnected.get(msg.name.trim());
    if (disc) {
      clearTimeout(disc.timer);
      this.disconnected.delete(msg.name.trim());

      const name = disc.name;
      const prev = this.att(ws);
      const isHost = disc.wasHost && !this.getHost();
      ws.serializeAttachment({
        name,
        hash: prev.hash,
        isHost,
        hostRejected: false,
        status: disc.status || "available",
        awayText: disc.awayText || null,
        msgTimestamps: [],
      } as WSData);

      this.log(`${name} rejoined (wasHost=${disc.wasHost}, isHost=${isHost})`);
      this.send(ws, "rejoined", {
        room: this.roomId,
        members: this.getMembers(),
        name,
        isHost,
        presence: this.getPresenceMap(),
        leaderboards: this.leaderboards,
        gameQueue: this.gameQueueSnapshot(),
      });
      this.broadcast("member-back", { name }, ws);
      this.resetIdle();
    } else {
      // grace expired, fall back to normal join
      this.onJoin(ws, msg as any);
    }
  }
}
