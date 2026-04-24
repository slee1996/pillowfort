/**
 * WebSocket client helpers shared by end-to-end tests.
 * These mirror the local capture tooling without depending on ignored files.
 */

export type Client = {
  ws: WebSocket;
  name: string;
  messages: any[];
  send: (msg: any) => void;
  waitFor: (type: string, timeout?: number) => Promise<any>;
  close: () => Promise<void>;
};

const KDF_ID = "pbkdf2-sha256-600k-v1";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function roomAuth(roomId: string, password: string) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const authKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(`pillowfort:auth:${roomId}`),
      iterations: 600_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const raw = await crypto.subtle.exportKey("raw", authKey);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return { v: 1, kdf: KDF_ID, verifier: toBase64Url(new Uint8Array(hash)) };
}

export async function connectUrl(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  return setupClient(ws);
}

export async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  return setupClient(ws);
}

async function setupClient(ws: WebSocket): Promise<Client> {
  const messages: any[] = [];
  const queues = new Map<string, any[]>();
  const waiters = new Map<string, { resolve: (msg: any) => void; timer: ReturnType<typeof setTimeout> }[]>();

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string);
    messages.push(msg);
    const list = waiters.get(msg.type);
    if (list?.length) {
      const { resolve, timer } = list.shift()!;
      clearTimeout(timer);
      resolve(msg);
      return;
    }
    const queue = queues.get(msg.type) || [];
    queue.push(msg);
    queues.set(msg.type, queue);
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws connect failed")));
  });

  return {
    ws,
    name: "",
    messages,
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    waitFor(type, timeout = 5000) {
      const queue = queues.get(type);
      if (queue?.length) return Promise.resolve(queue.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = waiters.get(type);
          if (list) {
            const idx = list.findIndex((waiter) => waiter.resolve === resolve);
            if (idx >= 0) list.splice(idx, 1);
          }
          reject(new Error(
            `timeout waiting for "${type}" (${timeout}ms)\n` +
            `Received: [${messages.map((m) => `${m.type}${m.message ? `: ${m.message}` : ""}`).join(", ")}]`
          ));
        }, timeout);
        const list = waiters.get(type) || [];
        list.push({ resolve, timer });
        waiters.set(type, list);
      });
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          ws.addEventListener("close", () => resolve());
          ws.close();
        });
      }
    },
  };
}

export async function createRoom(
  port: number,
  name: string,
  password = "demo"
): Promise<{ client: Client; roomId: string }> {
  const client = await connect(port);
  client.name = name;
  const roomId = generateRoomId();
  client.ws.close();
  const roomClient = await connectUrl(`ws://localhost:${port}/ws?room=${roomId}`);
  roomClient.name = name;
  roomClient.send({ type: "set-up", name, auth: await roomAuth(roomId, password) });
  const created = await roomClient.waitFor("room-created");
  return { client: roomClient, roomId: created.room };
}

export async function joinRoom(
  port: number,
  roomId: string,
  name: string,
  password = "demo"
): Promise<Client> {
  const client = await connectUrl(`ws://localhost:${port}/ws?room=${roomId}`);
  client.name = name;
  client.send({ type: "join", name, auth: await roomAuth(roomId, password), room: roomId });
  await client.waitFor("joined");
  return client;
}

function generateRoomId(): string {
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const consonants = "bcdfghjklmnprstvwz0123456789";
  const vowels = "o0ua";
  const all = "abcdefghijklmnopqrstuvwxyz0123456789";
  const soft = "rln";
  const hard = "xksz";
  const [a, b] = Math.random() < 0.5 ? [soft, hard] : [hard, soft];
  return pick(consonants) + pick(vowels) + pick(a) + pick(consonants) + pick(vowels) + pick(b) + pick(all) + pick(all);
}

export async function createRoomUrl(
  wsBase: string,
  name: string,
  password = "demo"
): Promise<{ client: Client; roomId: string }> {
  const roomId = generateRoomId();
  const client = await connectUrl(`${wsBase}?room=${roomId}`);
  client.name = name;
  client.send({ type: "set-up", name, auth: await roomAuth(roomId, password) });
  const created = await client.waitFor("room-created");
  return { client, roomId: created.room };
}

export async function joinRoomUrl(
  wsBase: string,
  roomId: string,
  name: string,
  password = "demo"
): Promise<Client> {
  const client = await connectUrl(`${wsBase}?room=${roomId}`);
  client.name = name;
  client.send({ type: "join", name, auth: await roomAuth(roomId, password), room: roomId });
  await client.waitFor("joined");
  return client;
}

export function chat(client: Client, text: string, style?: { color?: string; bold?: boolean; italic?: boolean }) {
  client.send({ type: "chat", text, ...(style ? { style } : {}) });
}

export function draw(client: Client, color: string, pts: number[][]) {
  client.send({ type: "draw", color, pts });
}

export function startVote(client: Client, target: string) {
  client.send({ type: "start-vote", target });
}

export function castVote(client: Client, vote: "yes" | "no") {
  client.send({ type: "cast-vote", vote });
}

export function tossPillow(client: Client, target: string) {
  client.send({ type: "toss-pillow", target });
}

export function knockDown(client: Client) {
  client.send({ type: "knock-down" });
}

export function tttChallenge(client: Client, target: string) {
  client.send({ type: "ttt-challenge", target });
}

export function tttAccept(client: Client) {
  client.send({ type: "ttt-accept" });
}

export function tttMove(client: Client, cell: number) {
  client.send({ type: "ttt-move", cell });
}

export function sabStart(client: Client) {
  client.send({ type: "sab-start" });
}

export function sabAccuse(client: Client, suspect: string) {
  client.send({ type: "sab-accuse", suspect });
}

export function sabVote(client: Client, voteOrSuspect: "yes" | "no" | string) {
  if (voteOrSuspect === "yes" || voteOrSuspect === "no") {
    client.send({ type: "sab-vote", vote: voteOrSuspect });
    return;
  }
  client.send({ type: "sab-accuse", suspect: voteOrSuspect });
}

export function sabStrike(client: Client) {
  client.send({ type: "sab-strike" });
}

export function rpsChallenge(client: Client, target: string) {
  client.send({ type: "rps-challenge", target });
}

export function rpsAccept(client: Client) {
  client.send({ type: "rps-accept" });
}

export function rpsPick(client: Client, pick: "rock" | "paper" | "scissors") {
  client.send({ type: "rps-pick", pick });
}

export function kothChallenge(client: Client) {
  client.send({ type: "koth-challenge" });
}

export function setStatus(client: Client, status: "available" | "away", awayText?: string) {
  client.send({ type: "set-status", status, ...(awayText ? { awayText } : {}) });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
