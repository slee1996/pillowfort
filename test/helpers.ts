import { createRoomAuthPayload, encryptChatPayload } from "../client/src/services/chatCrypto";
import { generateRoomId } from "../client/src/services/roomSecret";

export type Client = {
  ws: WebSocket;
  messages: any[];
  authChallenge: string;
  send: (msg: any) => void;
  waitFor: (type: string, timeout?: number) => Promise<any>;
  close: () => Promise<void>;
};

export const TEST_GRACE_MS = 300;
export const allClients: Client[] = [];
const ROOT_DIR = import.meta.dir + "/..";

let _port = 0;
let _proc: ReturnType<typeof Bun.spawn> | null = null;
let _buildOnce: Promise<void> | null = null;

export function getPort() { return _port; }

async function ensureClientBuild(): Promise<void> {
  if (_buildOnce) return _buildOnce;

  _buildOnce = (async () => {
    const proc = Bun.spawn(["npm", "run", "build"], {
      cwd: ROOT_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      _buildOnce = null;
      throw new Error(
        `client build failed before tests\n` +
        `${stdout}${stderr ? `\n${stderr}` : ""}`.trim()
      );
    }
  })();

  return _buildOnce;
}

export async function startServer(): Promise<void> {
  await ensureClientBuild();
  _port = 10_000 + Math.floor(Math.random() * 50_000);
  _proc = Bun.spawn(["bun", "server.ts"], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(_port), PILLOWFORT_GRACE_MS: String(TEST_GRACE_MS), CHALLENGE_TIMEOUT_MS: "250", PILLOWFORT_RATE_ROOMS: "999", PILLOWFORT_ALLOW_LEGACY_WS: "1", STRIPE_WEBHOOK_SECRET: "whsec_test", NODE_ENV: "test" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://localhost:${_port}/`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

export async function stopServer(): Promise<void> {
  if (_proc) {
    _proc.kill();
    await _proc.exited;
    _proc = null;
  }
}

export async function cleanupClients(): Promise<void> {
  for (const c of allClients) {
    try { c.ws.close(); } catch {}
  }
  allClients.length = 0;
  await Bun.sleep(50);
}

export async function connectClient(): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${_port}/ws?protocol=legacy`, {
    headers: { Origin: `http://localhost:${_port}` },
  } as never);
  const messages: any[] = [];
  const queues = new Map<string, any[]>();
  const waiters = new Map<string, { resolve: (msg: any) => void; timer: ReturnType<typeof setTimeout> }[]>();
  let resolveChallenge!: (challenge: string) => void;
  const challengePromise = new Promise<string>((resolve) => { resolveChallenge = resolve; });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string);
    if (msg.type === "auth-challenge") resolveChallenge(msg.challenge);
    messages.push(msg);
    const list = waiters.get(msg.type);
    if (list?.length) {
      const { resolve, timer } = list.shift()!;
      clearTimeout(timer);
      resolve(msg);
    } else {
      const q = queues.get(msg.type) || [];
      q.push(msg);
      queues.set(msg.type, q);
    }
  });

  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws connect failed")));
  });
  const authChallenge = await challengePromise;

  const client: Client = {
    ws,
    messages,
    authChallenge,
    send(msg) { ws.send(JSON.stringify(msg)); },
    waitFor(type, timeout = 2000) {
      const q = queues.get(type);
      if (q?.length) return Promise.resolve(q.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = waiters.get(type);
          if (list) {
            const idx = list.findIndex(w => w.resolve === resolve);
            if (idx >= 0) list.splice(idx, 1);
          }
          reject(new Error(
            `timeout waiting for "${type}" (${timeout}ms)\n` +
            `Received: [${messages.map(m => m.type).join(", ")}]`
          ));
        }, timeout);
        const list = waiters.get(type) || [];
        list.push({ resolve, timer });
        waiters.set(type, list);
      });
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN) {
        await new Promise<void>((res) => {
          ws.addEventListener("close", () => res());
          ws.close();
        });
      }
    },
  };

  allClients.push(client);
  return client;
}

export async function roomAuth(
  client: Client,
  roomId: string,
  password: string,
  action: "set-up" | "join" | "rejoin",
  name: string
) {
  return createRoomAuthPayload(roomId, password, client.authChallenge, action, name);
}

export async function createRoom(name = "host", password = "secret"): Promise<{ host: Client; roomId: string }> {
  const host = await connectClient();
  const roomId = generateRoomId();
  host.ws.close();
  const realHost = await connectClientToRoom(roomId);
  realHost.send({ type: "set-up", name, auth: await roomAuth(realHost, roomId, password, "set-up", name) });
  const created = await realHost.waitFor("room-created");
  return { host: realHost, roomId: created.room };
}

export async function connectClientToRoom(roomId: string): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${_port}/ws?room=${roomId}&protocol=legacy`, {
    headers: { Origin: `http://localhost:${_port}` },
  } as never);
  const messages: any[] = [];
  const queues = new Map<string, any[]>();
  const waiters = new Map<string, { resolve: (msg: any) => void; timer: ReturnType<typeof setTimeout> }[]>();
  let resolveChallenge!: (challenge: string) => void;
  const challengePromise = new Promise<string>((resolve) => { resolveChallenge = resolve; });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string);
    if (msg.type === "auth-challenge") resolveChallenge(msg.challenge);
    messages.push(msg);
    const list = waiters.get(msg.type);
    if (list?.length) {
      const { resolve, timer } = list.shift()!;
      clearTimeout(timer);
      resolve(msg);
    } else {
      const q = queues.get(msg.type) || [];
      q.push(msg);
      queues.set(msg.type, q);
    }
  });

  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws connect failed")));
  });
  const authChallenge = await challengePromise;

  const client: Client = {
    ws,
    messages,
    authChallenge,
    send(msg) { ws.send(JSON.stringify(msg)); },
    waitFor(type, timeout = 2000) {
      const q = queues.get(type);
      if (q?.length) return Promise.resolve(q.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}" (${timeout}ms)`)), timeout);
        const list = waiters.get(type) || [];
        list.push({ resolve, timer });
        waiters.set(type, list);
      });
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN) {
        await new Promise<void>((res) => {
          ws.addEventListener("close", () => res());
          ws.close();
        });
      }
    },
  };
  allClients.push(client);
  return client;
}

export async function createRoomWithId(
  roomId: string,
  name = "host",
  password = "secret",
  fortPassSessionId?: string
): Promise<{ host: Client; roomId: string }> {
  const host = await connectClientToRoom(roomId);
  host.send({
    type: "set-up",
    name,
    auth: await roomAuth(host, roomId, password, "set-up", name),
    ...(fortPassSessionId ? { fortPassSessionId } : {}),
  });
  const created = await host.waitFor("room-created");
  return { host, roomId: created.room };
}

export async function joinRoom(roomId: string, name = "guest", password = "secret"): Promise<Client> {
  const client = await connectClientToRoom(roomId);
  client.send({ type: "join", name, auth: await roomAuth(client, roomId, password, "join", name), room: roomId });
  await client.waitFor("joined");
  return client;
}

export async function sendEncryptedChat(
  client: Client,
  roomId: string,
  password: string,
  sender: string,
  text: string,
  style?: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
) {
  const enc = await encryptChatPayload(roomId, password, sender, text, style);
  if (!enc) throw new Error("failed to encrypt test chat");
  client.send({ type: "chat", enc });
}
