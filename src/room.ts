import type { Env } from "./index";
import { sanitizeStyle, uniqueName, MAX_NAME_LEN, MAX_MSG_LEN, GRACE_MS } from "./shared";

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
const VOTE_DURATION_MS = 30_000;
const SABOTEUR_VOTE_MS = 30_000;
const SABOTEUR_MIN_PLAYERS = 4;
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

export class Room implements DurableObject {
  private state: DurableObjectState;
  private password: string | null = null;
  private roomId: string = "";
  private tossPillowFrom: string | null = null;
  private disconnected: Map<string, { name: string; wasHost: boolean; timer: ReturnType<typeof setTimeout> }> = new Map();

  // --- game state ---
  private activeVote: { target: string; starter: string; yes: Set<string>; no: Set<string>; timer: ReturnType<typeof setTimeout> } | null = null;
  private rpsGame: { p1: string; p2: string; pick1?: string; pick2?: string } | null = null;
  private tttGame: { p1: string; p2: string; board: string[]; turn: number } | null = null;
  private saboteur: string | null = null;
  private saboteurActive = false;
  private sabVote: { votes: Map<string, string>; timer: ReturnType<typeof setTimeout> } | null = null;
  private sabRoundTimer: ReturnType<typeof setTimeout> | null = null;

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

    const name = msg.name.trim().slice(0, MAX_NAME_LEN);
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

    const name = uniqueName(msg.name.trim().slice(0, MAX_NAME_LEN), new Set(this.getMembers()));
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

  // ============ PILLOW FIGHT (vote to eject) ============

  private onStartVote(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target) return;
    if (this.activeVote) return this.send(ws, "error", { message: "a vote is already in progress" });
    if (msg.target === a.name) return this.send(ws, "error", { message: "you can't vote yourself out" });
    if (!this.getMembers().includes(msg.target)) return;
    if (this.getMembers().length < 3) return this.send(ws, "error", { message: "need at least 3 people to start a vote" });

    this.activeVote = { target: msg.target, starter: a.name, yes: new Set([a.name]), no: new Set(), timer: setTimeout(() => this.resolveVote(), VOTE_DURATION_MS) };
    this.broadcast("vote-started", { target: msg.target, starter: a.name });
    this.log(`${a.name} started vote to eject ${msg.target}`);
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
    const { target, yes, no } = this.activeVote;
    const ejected = yes.size > no.size;
    this.broadcast("vote-result", { target, yes: yes.size, no: no.size, ejected });
    this.log(`vote result: ${target} ${ejected ? "ejected" : "stays"} (${yes.size}-${no.size})`);

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
    }
    this.activeVote = null;
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
    if (this.rpsGame) return this.send(ws, "error", { message: "a duel is already in progress" });
    const tw = this.findWs(msg.target);
    if (!tw) return;

    this.rpsGame = { p1: a.name, p2: msg.target };
    this.send(tw, "rps-challenged", { from: a.name });
    this.broadcast("rps-pending", { p1: a.name, p2: msg.target });
    this.log(`${a.name} challenged ${msg.target} to RPS`);
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
      this.rpsGame = null;
      if (isKoth && winner) this.resolveKoth(winner);
      else if (isKoth) this.kothGame = null; // draw = no change
    }
  }

  // ============ TIC-TAC-TOE ============

  private onTttChallenge(ws: WebSocket, msg: { target?: string }) {
    const a = this.att(ws);
    if (!a.name || !msg.target || a.name === msg.target) return;
    if (this.tttGame) return this.send(ws, "error", { message: "a game is already in progress" });
    const tw = this.findWs(msg.target);
    if (!tw) return;

    this.tttGame = { p1: a.name, p2: msg.target, board: Array(9).fill(""), turn: 0 };
    this.send(tw, "ttt-challenged", { from: a.name });
    this.broadcast("ttt-pending", { p1: a.name, p2: msg.target });
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
    if (winner || draw) {
      this.log(`TTT: ${g.p1} vs ${g.p2} → ${winner ? winner + " wins" : "draw"}`);
      this.tttGame = null;
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

    this.saboteurActive = true;
    // pick random saboteur
    this.saboteur = members[Math.floor(Math.random() * members.length)];
    this.log(`saboteur mode started — ${this.saboteur} is the saboteur`);

    // tell everyone the mode started
    this.broadcast("sab-started", { starter: a.name });

    // privately tell the saboteur
    const sabWs = this.findWs(this.saboteur);
    if (sabWs) this.send(sabWs, "sab-role", { role: "saboteur" });

    // tell everyone else they're a defender
    for (const w of this.state.getWebSockets()) {
      const d = this.att(w);
      if (d.name && d.name !== this.saboteur) this.send(w, "sab-role", { role: "defender" });
    }

    // schedule first vote round
    this.scheduleSabVote();
  }

  private scheduleSabVote() {
    if (this.sabRoundTimer) clearTimeout(this.sabRoundTimer);
    // vote every 60 seconds
    this.sabRoundTimer = setTimeout(() => this.startSabVote(), 60_000);
  }

  private startSabVote() {
    if (!this.saboteurActive) return;
    this.sabVote = { votes: new Map(), timer: setTimeout(() => this.resolveSabVote(), SABOTEUR_VOTE_MS) };
    this.broadcast("sab-vote-start", { duration: SABOTEUR_VOTE_MS });
    this.log("saboteur vote round started");
  }

  private onSabVote(ws: WebSocket, msg: { suspect?: string }) {
    const a = this.att(ws);
    if (!a.name || !this.sabVote || !msg.suspect) return;
    if (!this.getMembers().includes(msg.suspect)) return;
    this.sabVote.votes.set(a.name, msg.suspect);

    // check if everyone voted
    if (this.sabVote.votes.size >= this.getMembers().length) this.resolveSabVote();
  }

  private resolveSabVote() {
    if (!this.sabVote || !this.saboteurActive) return;
    clearTimeout(this.sabVote.timer);

    // tally votes
    const tally = new Map<string, number>();
    for (const suspect of this.sabVote.votes.values()) {
      tally.set(suspect, (tally.get(suspect) || 0) + 1);
    }

    // find top voted
    let topName = "";
    let topCount = 0;
    for (const [name, count] of tally) {
      if (count > topCount) { topName = name; topCount = count; }
    }

    const correct = topName === this.saboteur;
    this.broadcast("sab-vote-result", {
      votes: Object.fromEntries(tally),
      accused: topName,
      wasSaboteur: correct,
      saboteur: correct ? this.saboteur : null
    });
    this.log(`sab vote: ${topName} accused (${correct ? "correct!" : "wrong"})`);

    if (correct) {
      // saboteur caught!
      this.saboteurActive = false;
      this.saboteur = null;
      this.sabVote = null;
      if (this.sabRoundTimer) { clearTimeout(this.sabRoundTimer); this.sabRoundTimer = null; }
    } else {
      this.sabVote = null;
      this.scheduleSabVote();
    }
  }

  private onSabStrike(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || !this.saboteurActive || a.name !== this.saboteur) return;

    this.broadcast("sab-strike", { saboteur: a.name });
    this.log(`saboteur ${a.name} struck!`);

    // end saboteur mode
    this.saboteurActive = false;
    this.saboteur = null;
    if (this.sabVote) { clearTimeout(this.sabVote.timer); this.sabVote = null; }
    if (this.sabRoundTimer) { clearTimeout(this.sabRoundTimer); this.sabRoundTimer = null; }
  }

  // ============ KING OF THE HILL ============

  private kothGame: { challenger: string; host: string } | null = null;

  private onKothChallenge(ws: WebSocket) {
    const a = this.att(ws);
    if (!a.name || a.isHost) return this.send(ws, "error", { message: "only non-hosts can challenge" });
    if (this.rpsGame) return this.send(ws, "error", { message: "a duel is already in progress" });
    const hostWs = this.getHost();
    if (!hostWs) return;
    const hostName = this.att(hostWs).name;

    this.kothGame = { challenger: a.name, host: hostName };
    this.rpsGame = { p1: a.name, p2: hostName };
    this.broadcast("koth-started", { challenger: a.name, host: hostName });
    this.broadcast("rps-started", { p1: a.name, p2: hostName, koth: true });
    this.log(`${a.name} challenged ${hostName} for the crown`);
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
      this.broadcast("new-host", { name: challenger });
      this.broadcast("koth-result", { winner: challenger, loser: host });
      this.log(`KOTH: ${challenger} dethroned ${host}`);
    } else {
      this.broadcast("koth-result", { winner: host, loser: challenger });
      this.log(`KOTH: ${host} defended the crown`);
    }
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
