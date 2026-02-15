# pillowfort

ephemeral chat rooms with AIM vibes. set up a fort, hang out, knock it down.

no accounts. no history. no database. when the fort comes down, it's gone forever.

<p align="center">
  <img src="aim-home.png" width="360" alt="sign on screen">
  <img src="aim-chat-full.png" width="360" alt="chat screen">
</p>

## how it works

1. **set up a fort** — pick a screen name and a secret password
2. **share the code** — give the 8-character fort code + password to your friends
3. **hang out** — chat in real time, windows xp style
4. **knock it down** — the host can destroy the fort at any time. poof, it's gone

## host migration (the pillow throw)

when the host leaves without knocking down the fort, a pillow gets thrown to a random guest:

- **host leaves** — a random guest gets the "incoming pillow!" dialog
- **guest catches** — they become the new host with full controls (Copy Invite, Knock Down)
- **guest ducks** — the pillow passes to the next guest
- **everyone ducks** — the fort collapses ("nobody caught the pillow")

## features

- **ephemeral** — nothing persists. no messages stored, no user accounts, no database
- **invite only** — no room list, no lobby, no discovery. if you know the code + password, you're in
- **auto-suffixed names** — join as "spencer" when there's already a "spencer"? you become "spencer2"
- **user hashes** — every connection gets a 4-char hex hash for server-side disambiguation
- **rate limiting** — room creation (5/min per IP) and message sending (10/5s) are throttled
- **20 guest cap** — keeps forts small and personal
- **10 minute idle timeout** — no messages for 10 minutes and the fort self-destructs
- **typing indicators** — see who's whispering
- **room-scoped presence** — set yourself as Available/Away (optionally with an away note) visible only to people inside your current fort
- **room-key message encryption** — chat payload (text + style) is encrypted in-browser with AES-GCM (PBKDF2-derived key from fort password + room flag), bound to sender identity, with replay-drop in session; relay still sees metadata like sender/typing
- **mobile responsive** — full-screen chat on mobile with safe area support
- **AIM / Windows XP aesthetic** — title bars, buddy list, door sounds, the whole deal

## screenshots

### desktop

| sign on | set up | chat (host view) |
|---------|--------|------------------|
| ![sign on](aim-home.png) | ![chat](aim-chat.png) | ![host view](host-view.png) |

| chat (full) | knocked down |
|-------------|--------------|
| ![full chat](aim-chat-full.png) | ![knocked](knocked.png) |

### mobile

| sign on | set up | chat | message | knocked |
|---------|--------|------|---------|---------|
| ![sign on](mobile-signon.png) | ![setup](mobile-setup.png) | ![chat](mobile-chat.png) | ![message](mobile-chat-msg.png) | ![knocked](mobile-knocked.png) |

## running locally

```bash
# install dependencies
npm install

# start the local dev server (bun)
bun run server.ts

# or with watch mode
bun --watch server.ts
```

open http://localhost:3000

the local server uses Bun's native WebSocket support. no cloudflare, no durable objects — just a single process holding rooms in memory.

## design snapshot tests

```bash
# runs visual baselines for home/setup/join/chat (desktop + mobile)
bun run test:design-snapshots

# optional: run against an already-running app URL
PF_BASE_URL=http://localhost:3000 bun run test:design-snapshots
```

first run writes baselines to `test/__snapshots__/design/`. later runs compare pixel diffs and fail if UI drift exceeds threshold.

## deploying to cloudflare

```bash
# deploy to cloudflare workers + durable objects
npx wrangler deploy
```

production uses Cloudflare Workers for the entry point and a Durable Object per room for WebSocket management. see [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## project structure

```
pillowfort/
├── client/               # React + Vite client
│   ├── src/              # screens, stores, components, styles
│   └── dist/             # built static assets served by server.ts
├── src/
│   ├── index.ts           # cloudflare worker entry point (routes /ws to durable objects)
│   └── room.ts            # durable object — one instance per room
├── server.ts              # local bun dev server (mirrors room.ts logic)
├── wrangler.toml          # cloudflare config
└── ARCHITECTURE.md        # system design and protocol docs
```

## tech

| layer   | local dev | production                     |
|---------|-----------|--------------------------------|
| server  | bun       | cloudflare workers             |
| rooms   | in-memory | durable objects (one per room) |
| client  | react + vite | react + vite                |
| storage | none      | none (durable object memory only) |
| build   | vite      | vite + wrangler                |
