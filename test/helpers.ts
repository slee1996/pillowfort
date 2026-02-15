export type Client = {
  ws: WebSocket;
  messages: any[];
  send: (msg: any) => void;
  waitFor: (type: string, timeout?: number) => Promise<any>;
  close: () => Promise<void>;
};

export const TEST_GRACE_MS = 300;
export const allClients: Client[] = [];

let _port = 0;
let _proc: ReturnType<typeof Bun.spawn> | null = null;

export function getPort() { return _port; }

export async function startServer(): Promise<void> {
  _port = 10_000 + Math.floor(Math.random() * 50_000);
  _proc = Bun.spawn(["bun", "server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(_port), PILLOWFORT_GRACE_MS: String(TEST_GRACE_MS), PILLOWFORT_RATE_ROOMS: "999", NODE_ENV: "test" },
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
  const ws = new WebSocket(`ws://localhost:${_port}/ws`);
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

  const client: Client = {
    ws,
    messages,
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

export async function createRoom(name = "host", password = "secret"): Promise<{ host: Client; roomId: string }> {
  const host = await connectClient();
  host.send({ type: "set-up", name, password });
  const created = await host.waitFor("room-created");
  return { host, roomId: created.room };
}

export async function joinRoom(roomId: string, name = "guest", password = "secret"): Promise<Client> {
  const client = await connectClient();
  client.send({ type: "join", name, password, room: roomId });
  await client.waitFor("joined");
  return client;
}
