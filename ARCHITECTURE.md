# pillowfort architecture

ephemeral chat rooms. set up, hang out, knock down.

## core concept

```
┌─────────────────────────────────────────────────────┐
│                    pillowfort                        │
│                                                      │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐        │
│  │  fort A   │   │  fort B   │   │  fort C   │  ...  │
│  │  host: al │   │ host: sam │   │ host: jo  │        │
│  │  pass: ** │   │ pass: *** │   │ pass: *   │        │
│  │  3 guests │   │  1 guest  │   │  0 guests │        │
│  └──────────┘   └──────────┘   └──────────┘        │
│       ▲               ▲              ▲               │
│       │               │              │               │
│   durable object   durable object  durable object    │
│   (one per fort)                                     │
└─────────────────────────────────────────────────────┘
```

## what persists

nothing meaningful. ever.

durable objects hold the room password in storage while the room is alive, but when the fort is
knocked down, `storage.deleteAll()` wipes everything. the only thing a user carries between forts
is their **screen name**, stored client-side (localStorage).

## room lifecycle

```
  set up                    live                     knocked down
┌─────────┐           ┌─────────────┐             ┌──────────────┐
│ host     │           │ guests join │             │ host knocks  │
│ picks    │──────────▶│ via password│────────────▶│ it down, or  │
│ name +   │           │ chat flows  │             │ idle timeout │
│ password │           │             │             │ → all out    │
└─────────┘           └─────────────┘             └──────────────┘
                            │
                            │ host disconnects?
                            ▼
                     ┌─────────────┐
                     │ pillow throw │
                     │ pick random  │──▶ guest catches → new host
                     │ guest, offer │──▶ guest ducks → offer next
                     │ host role    │──▶ all duck → fort collapses
                     └─────────────┘
```

## host migration — the pillow throw

when the host disconnects without explicitly knocking down the fort:

1. server picks a random guest and sends them a `host-offer`
2. server broadcasts `host-offered` to everyone else (so they know who's being asked)
3. the chosen guest sees a dialog: "alice threw a pillow at you!" with **Catch it** / **Duck**
4. **catch it** → guest becomes new host, all `hostRejected` flags reset, `new-host` broadcast
5. **duck** → guest is marked `hostRejected`, `host-ducked` broadcast, offer passes to next eligible guest
6. if no eligible guests remain → `destroyRoom("nobody caught the pillow")`

this prevents the awkward "host left, room dies" scenario while keeping it fun and consensual — nobody is forced to be host.

## dual runtime

pillowfort runs on two runtimes with the same logic:

### local dev — bun (server.ts)

single-process bun server. rooms are a `Map<string, Room>` in memory. websockets are native bun
websockets. idle timeout uses `setTimeout`. good for development and testing.

### production — cloudflare workers + durable objects (src/)

```
┌─────────────────┐         ┌─────────────────────┐
│ cloudflare       │         │ durable object       │
│ worker           │  /ws →  │ (one per fort)       │
│ (src/index.ts)   │────────▶│ (src/room.ts)        │
│                  │         │                      │
│ routes:          │         │ - holds websockets   │
│  /ws → DO        │         │ - manages chat       │
│  /* → static     │         │ - host migration     │
│      assets      │         │ - idle alarm         │
└─────────────────┘         └─────────────────────┘
```

the worker entry point routes `/ws?room=XXXXX` to a durable object named by the room ID.
everything else is served from cloudflare assets (the single `index.html`).

each durable object uses the **hibernation API**:
- `state.acceptWebSocket(server)` instead of manual connection tracking
- `serializeAttachment()` / `deserializeAttachment()` for per-socket state (name, hash, isHost, etc.)
- `state.storage.setAlarm()` for idle timeout instead of `setTimeout`

## user identity

every websocket connection gets a random 4-character hex hash (e.g. `a3f1`). this is used
server-side for logging — `alice#a3f1` vs `alice#7c02` — to distinguish users with the same
screen name. hashes are never shown to end users.

if a user joins with a name that's already taken, the server auto-suffixes it:
`spencer` → `spencer2` → `spencer3`, etc. the suffix is appended within the 24-character name
limit (base name gets truncated if needed to fit the suffix).

## protocol (websocket messages)

### client → server

| message        | payload                        | description                   |
|----------------|--------------------------------|-------------------------------|
| `set-up`       | `{ name, password }`           | create a fort, become host    |
| `join`         | `{ name, password }`           | enter an existing fort        |
| `chat`         | `{ text }`                     | send a message                |
| `knock-down`   | `{}`                           | host explicitly destroys fort |
| `leave`        | `{}`                           | leave the fort                |
| `typing`       | `{}`                           | typing indicator              |
| `accept-host`  | `{}`                           | accept the pillow (become host)|
| `reject-host`  | `{}`                           | duck the pillow               |

### server → client

| message         | payload                       | description                         |
|-----------------|-------------------------------|-------------------------------------|
| `room-created`  | `{ room }`                    | confirms fort setup                 |
| `joined`        | `{ room, members[], name }`   | confirms entry (name may be suffixed)|
| `message`       | `{ from, text }`              | chat message broadcast              |
| `member-joined` | `{ name }`                    | someone entered the fort            |
| `member-left`   | `{ name }`                    | someone left the fort               |
| `knocked-down`  | `{ reason }`                  | fort is being destroyed             |
| `typing`        | `{ name }`                    | someone is whispering               |
| `host-offer`    | `{ oldHost }`                 | you've been offered the pillow      |
| `host-offered`  | `{ name }`                    | someone else is being offered       |
| `new-host`      | `{ name }`                    | someone caught the pillow           |
| `host-ducked`   | `{ name }`                    | someone ducked                      |
| `error`         | `{ message }`                 | bad password, fort not found, etc.  |

## per-socket state (WSData)

```typescript
interface WSData {
  name: string;           // screen name (empty until set-up/join)
  hash: string;           // 4-char hex for server-side logging
  isHost: boolean;        // true if this socket is the host
  hostRejected: boolean;  // true if this user ducked during current offer round
  msgTimestamps: number[];// timestamps for message rate limiting
}
```

## rate limiting

| what                  | limit        | scope  |
|-----------------------|-------------|--------|
| room creation         | 5 per minute | per IP |
| message sending       | 10 per 5s   | per socket |
| name length           | 24 chars     | —      |
| message length        | 2000 chars   | —      |
| guests per fort       | 20           | per fort |
| idle timeout          | 10 minutes   | per fort |

## tech

| layer   | local dev  | production              |
|---------|------------|-------------------------|
| server  | bun        | cloudflare workers      |
| rooms   | in-memory  | durable objects         |
| client  | vanilla js | vanilla js              |
| storage | none       | none (ephemeral DO)     |
| build   | none       | wrangler                |
| styling | XP/AIM     | XP/AIM                  |

## design decisions

- **one fort per tab.** no multi-room UI, no room switching. one websocket = one fort. want two
  forts? open two tabs.
- **invite only.** no room list, no lobby, no discovery. the host shares the fort code + password
  out of band (text, discord, whatever). the server exposes zero info about what forts exist.
- **20 guest cap.** keeps forts small and personal.
- **no history for late joiners.** you had to be there.
- **10 minute idle timeout.** no messages for 10 minutes → the fort self-destructs.
- **interactive host migration.** when the host leaves, the pillow gets thrown to a random guest.
  they can catch it (become host) or duck (pass it along). nobody is forced to be host.
- **auto-suffixed names.** duplicate names get a number appended. funnier than rejecting.
- **client-side room ID generation.** the room code is generated client-side (6 random alphanumeric chars)
  and passed to the server. on cloudflare, this becomes the durable object name.

## prior art

| project          | similarity | difference                                      |
|------------------|------------|-------------------------------------------------|
| IRC (1988)       | high       | channels die when empty, not when host leaves   |
| AIM (1997)       | aesthetic  | AIM had accounts, buddy lists, away messages    |
| hack.chat        | high       | no host concept, rooms are URL-based            |
| wsrelay-server   | high       | generic relay, no room/host semantics           |
