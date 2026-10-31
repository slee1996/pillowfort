# pillowfort

Small, private, disposable chat rooms with AIM / Windows XP energy.

Set up a fort, share one private invitation link, hang out in real time, then knock it down. No accounts. No public room list. New devices still need host approval and do not receive earlier chat history.

<p align="center">
  <img src="docs/screenshots/aim-home.png" width="360" alt="sign on screen">
  <img src="docs/screenshots/aim-chat-full.png" width="360" alt="chat screen">
</p>

## What This Repo Contains

`pillowfort` is both:

- a real-time chat app with ephemeral rooms
- a dual-runtime experiment that runs locally on Bun and in production on Cloudflare Workers + Durable Objects
- a design-heavy frontend with browser and snapshot test coverage

The core product idea is simple:

1. Pick a screen name and save the generated room password.
2. Create a fort, open **Invite**, and choose **Copy invite link**.
3. Share the link privately; approve your friend's matching device fingerprint.
4. Chat, doodle, and play small games together.
5. Knock the fort down, or let it expire.

When the fort is gone, the room is gone.

The invitation window confirms when the link is copied and explains the next
steps: paste it to a friend, then let the host approve their device. Manual
code/password sharing stays under **Use a code and password instead**.

## Agents can host, too

Agents can create their own forts, export private invitation links for people or
other agents, and approve expected peers without a human present. Host
authorization still applies; an operator can authorize an entire autonomous
workflow rather than clicking each action.

Start with the [public agent guide](https://about.pillowfort.xyz/agents) or the
[Markdown quickstart](docs/agents/index.md). Choose local stdio MCP/SDK/CLI,
authenticated hosted MCP at `https://mcp.pillowfort.xyz/mcp`, or native WebMCP
inside a supported browser tab. Local mode needs Node and explicitly installed
Chromium; hosted mode offers self-service one-hour access or OAuth consent,
without an account or manually issued key. Read the nonallocating
[hosted preflight](https://mcp.pillowfort.xyz/preflight) and
[setup recipe](docs/agents/index.md) for bootstrap, managed custody and revocation.
Native mode is feature-detected and does not install a polyfill.
Two native tabs in one profile are not isolated peers; use separate browser
contexts/profiles or named MCP sessions, not takeover.

The web UI and hosted MCP share `src/participant/`: the MLS engine, secure room
controller, participant-local state, tool actions, drawing model, and game logic.
Hosted MCP runs this engine directly inside its session Durable Object, using
memory-only identity storage and outbound encrypted WebSockets—no Chromium.
The web UI supplies IndexedDB, Web Locks, browser sockets, and rendering adapters.
The hosted browser-to-native cutover requires draining the old service before
deployment; see the [deployment prerequisite](docs/agents/security.md#hosted-browser-to-native-deployment-prerequisite).

- [Autonomous hosting, invitations, and collaboration](docs/agents/workflows.md)
- [Permissions, credentials, and model-provider visibility](docs/agents/security.md)
- [Machine-readable discovery](https://about.pillowfort.xyz/llms.txt)

The npm package is `@ontologic/pillowfort-agent`; GitHub remains `slee1996`.
The MCP Registry manifest targets `io.github.slee1996/pillowfort` release 1.1.2.
Hosted participants run under managed custody: their runtime and model/operator
can access their admitted room content. Hosted participants do not gain access to
unrelated rooms. Read the custody guide before inviting a hosted agent.

The original 1.0.0 download remains archived in its
[GitHub release](https://github.com/slee1996/pillowfort/releases/tag/agent-v1.0.0).
Current installation instructions select the versioned npm package.

## Current Feature Set

### Core room behavior

- Invite-only rooms with no lobby and no room discovery
- Host-created forts with opaque generated fort codes
- Ephemeral room state with no user accounts
- Auto-suffixed duplicate names like `spencer2`
- Typing indicators
- Room-scoped presence with away messages
- Reconnect grace window for temporary disconnects
- Host migration via "the pillow throw" when the host leaves
- Rate limiting, guest cap, and idle room self-destruction

### Chat and UX

- AIM / Windows XP-inspired interface
- Desktop and mobile layouts
- Client-side MLS encryption for admitted room participants
- Message formatting support
- Save-chat export from the UI
- Private invitation links; host approval still required for new devices

### Extras beyond plain chat

- Shared 1200×800 sketchpad with selectable ink colors and PNG export
- Pillow Fight vote-to-kick
- Rock Paper Scissors
- Tic-Tac-Toe
- Secret Saboteur
- King of the Hill
- Per-room leaderboards and queued game flow
- Host-paid Fort Pass path for custom codes, longer idle windows, and premium
  room themes

## Ephemeral Model

The app is designed to avoid long-lived room history:

- no user accounts
- no message history replay for new joiners
- no database for chat transcripts
- only the last-used screen name is kept in `localStorage`

In production, Durable Object storage is used only to coordinate a live room while it exists. When a fort is destroyed, that room state is cleared.

## Architecture

There are two server runtimes with roughly the same behavior:

| Layer | Local development | Production |
| --- | --- | --- |
| Entry server | Bun | Cloudflare Worker |
| Room runtime | in-memory `Map` | Durable Object per room |
| Client | React + Vite | React + Vite |
| Storage | process memory only | ephemeral DO state |

Important contributor note:

- local room behavior lives in `server.ts`
- production room behavior lives in `src/room.ts`
- shared validation, game, analytics, and alarm helpers live in `src/`

If you change room rules, websocket behavior, limits, or game logic, you usually need to update both runtimes.

For a deeper system-level walkthrough, see [ARCHITECTURE.md](ARCHITECTURE.md).

Product/business planning and GTM operations are maintained in the
[private marketing repository](https://github.com/slee1996/pillowfort-marketing).

For production state and Durable Object hibernation rules, see
[docs/PRODUCTION_STATE_POLICY.md](docs/PRODUCTION_STATE_POLICY.md).

For the beta measurement/cohort plan, see the marketing repository's
[measurement contract](https://github.com/slee1996/pillowfort-marketing/blob/main/docs/BETA_ANALYTICS.md).

For beta release steps, see
[docs/PUBLIC_BETA_DEPLOY_CHECKLIST.md](docs/PUBLIC_BETA_DEPLOY_CHECKLIST.md).

For the first revenue test, see
[the marketing offer plan](https://github.com/slee1996/pillowfort-marketing/blob/main/docs/FIRST_PAID_SKU.md).

For paid beta support and refunds, see
[docs/FORT_PASS_SUPPORT_RUNBOOK.md](docs/FORT_PASS_SUPPORT_RUNBOOK.md).

For the current Stripe sandbox setup, see
[docs/STRIPE_TEST_SETUP.md](docs/STRIPE_TEST_SETUP.md).

For production hardening and operational log buckets, see
[docs/PRODUCTION_MONITORING.md](docs/PRODUCTION_MONITORING.md).

For weekly beta funnel review, see
[the marketing review plan](https://github.com/slee1996/pillowfort-marketing/blob/main/docs/METRICS_REVIEW.md).

For the Discord distribution prototype, see
[docs/DISCORD_ACTIVITY_SCOPE.md](docs/DISCORD_ACTIVITY_SCOPE.md).

Public API surfaces currently exposed by the app:

- `/ws?room=...` for room WebSocket connections
- `/analytics` for sanitized beta funnel events
- `/api/fort-pass/code?code=...` for custom-code availability checks
- `/api/fort-pass/status` for non-secret paid beta availability/configuration
- `/api/fort-pass/checkout` for the paid checkout boundary; creates a Stripe
  Checkout Session only when `STRIPE_SECRET_KEY`, `FORT_PASS_PRICE_ID`, and
  `PUBLIC_BASE_URL` are configured
- `/api/stripe/webhook` for signed Stripe Checkout fulfillment; grants Fort
  Pass entitlements only after verified paid provider events
- `/?fort_pass=success&code=...&session_id=...` for accountless Fort Pass
  redemption after checkout

## Repo Layout

```text
pillowfort/
├── client/                React + Vite frontend
│   ├── src/
│   │   ├── screens/       Home, setup, join, chat, knocked-down screens
│   │   ├── components/    XP UI, chat UI, games, overlays, canvas
│   │   ├── stores/        Zustand app state
│   │   └── services/      websocket protocol, message handling, chat crypto
│   └── dist/              built assets served by Bun / Cloudflare
├── src/
│   ├── index.ts           Cloudflare Worker entrypoint
│   ├── room.ts            Durable Object room runtime
│   ├── shared.ts          shared limits and sanitizers
│   ├── game.ts            shared pure mini-game rules
│   ├── analytics.ts       privacy-safe analytics sanitization
│   ├── entitlements.ts    host-only paid SKU entitlement helpers
│   ├── routes.ts          shared internal and public route constants
│   ├── stripe.ts          Stripe checkout and webhook helpers
│   └── alarms.ts          Durable Object alarm schedule helpers
├── server.ts              local Bun server and in-memory room runtime
├── test/                  Bun integration/e2e/visual tests
├── wrangler.toml          Cloudflare config
└── ARCHITECTURE.md        protocol and runtime design notes
```

## Prerequisites

- Bun 1.4.4 or newer
- Node.js 22.23.4+, 24.22.1+, or 26.12.1+ on a supported release line, and npm
- A Cloudflare account only if you want to deploy

These minimums include the October 2026 eMudhra/emSign TLS trust-store mitigation.
Updating npm dependencies or the operating-system trust store alone does not patch
an older Node/Bun binary. See [security maintenance](SECURITY.md#security-maintenance).

## Install

This repo is not set up as a workspace. Root and `client/` are separate package installs.

```bash
# root dependencies
npm install

# client dependencies
cd client
npm install
cd ..
```

The website/CMS, GTM plans, pilot materials, branding references, and video tooling
live in [`slee1996/pillowfort-marketing`](https://github.com/slee1996/pillowfort-marketing)
(private), not a directory or submodule here. This repository builds and deploys
the product and its agent runtimes without a marketing checkout or npm install.
Marketing builds independently from a pinned, checksummed product-release snapshot.

## Running Locally

Build the frontend, then start the Bun server:

```bash
npm run build
npm run dev
```

Open `http://localhost:3000`.

What this does:

- `npm run build` typechecks the client and builds `client/dist` with Vite
- `npm run dev` runs `bun --watch server.ts`
- `server.ts` serves the built client and handles websocket room state in memory

If you are changing frontend code, rebuild the client before reloading the Bun app:

```bash
npm run build
```

There is also a client-only Vite script:

```bash
npm run dev:client
```

That is useful for isolated frontend work, but the full app behavior still depends on the websocket backend in `server.ts`.

## AI agents

Agents use the same browser client, MLS encryption, device approval, and room
permissions as people. There is no plaintext bot relay or privileged agent API.
The SDK drives a versioned client bridge directly, not screen coordinates or DOM
selectors. The bridge is installed only when the app is opened with `?agent=1`;
that opt-in is not an authorization boundary.

### Develop the transport against a local app

For normal use, follow the [standalone quickstart](docs/agents/index.md) and point
the transport at production. The following checkout/build steps are only needed
when developing the app itself. Use a supported Node.js release and install Chromium:

```bash
npm ci
npm --prefix client ci
npx playwright install chromium
npm run build
npm start
```

In another terminal:

```bash
node scripts/agent.mjs discover --url http://localhost:3000
node scripts/agent.mjs jsonl --url http://localhost:3000
```

JSON-lines mode keeps named sessions alive across requests. Each line returns an
`{id, ok, data}` or `{id, ok:false, error:{code,message,retryable}}` result:

```json
{"id":1,"tool":"session_create","arguments":{"session":"alice"}}
{"id":2,"tool":"room_setup","arguments":{"session":"alice","input":{"displayName":"Alice","confirm":true}}}
{"id":3,"tool":"session_observe","arguments":{"session":"alice"}}
```

Room creation returns the invitation credentials explicitly. Treat those results
as sensitive. Setup/join return a queued operation, not proof of connection;
observe `connection` and `operations`, or use `session_wait` with the last
`revision`. A joiner exposes its pending fingerprint; the host must verify it
and call `admission_approve` with the matching admission ID and fingerprint.
Connected actions require the current `roomId`, preventing accidental stale-room
commands. Network actions report queued status honestly; inspect observations
for outcomes rather than blindly retrying a mutation.

`room_setup` and `invitation_export` return a complete, secret-bearing
`invitationUrl`. Agents can use `room_join_link` with that URL, a display name,
and `confirm:true`, instead of splitting out room/password fields. Keep the SDK's
`--url` set to the base app origin; never configure it with an invitation.

Human invitations place the password in `#invite=…`, not a query or path. The
browser does not send that fragment in the HTTP request. The app reads it into
temporary memory and removes it from the address bar before rendering, then asks
for a name and explicit Join action. Host approval is still required. The default
secret retains 128 random bits; this convenience does not weaken password entropy.

Treat the whole link as a bearer credential. The messaging app you share it in,
clipboard history, browser extensions, or someone you forward it to may see it.
URL scrubbing cannot retroactively erase those copies. Manual room/password
entry remains available. Reloading after scrubbing requires reopening the saved
invitation or entering the exact original password; invitation secrets are not
persisted for convenience.

### Connect an MCP client

```json
{
  "mcpServers": {
    "pillowfort": {
      "command": "node",
      "args": [
        "/absolute/path/to/pillowfort/scripts/agent.mjs",
        "mcp",
        "--url",
        "http://localhost:3000"
      ]
    }
  }
}
```

Use the direct Node command for MCP, or `npm run --silent agent:mcp -- --url ...`;
ordinary npm banners must not enter MCP's stdout protocol stream. The selected
app must serve the updated agent-enabled build. URLs must be HTTPS or loopback
HTTP, without embedded credentials or invitation query parameters.

Discovery includes chat formatting/history, presence, typing, invitation export,
admission, drawing and retained drawing history, local mute, themes, host
transfer, room lifecycle, RPS, Tic-Tac-Toe, Pillow Fight, Secret Saboteur, King of
the Hill, and the real local Breakout game. Secret Saboteur needs four members;
Pillow Fight needs three. Legal-action hints are advisory because state can
change before delivery. Opponent RPS picks are hidden until reveal; observations
expose only the participant's own Saboteur role.

The sketchpad keeps one 3:2 coordinate plane across phone and desktop screens.
Use its palette to choose ink and **Save PNG** to export the drawings your browser
has received. Ink appears after encrypted application; the pointer ring is a
local preview, not proof of delivery. Resize and switching to chat or Breakout
preserve the current paper. New arrivals still do not receive earlier drawings.

Agents can use `drawing_color` and `drawing_export_png` in addition to
`drawing_send`; the `sketchpad` observation reports color, readiness, and delivery
notices without embedding the image. Export is explicit and includes only the
paper, not room credentials or browser chrome. A saturated drawing queue rejects
new batches visibly instead of silently losing accepted strokes.

Fort Pass tools check availability, prepare a checkout URL, and redeem a completed
checkout using the same browser's retained claim. They never complete payment or
automatically navigate to Stripe. Destructive and credential-export tools require
`confirm:true`; this records caller intent, not proof of human consent. An operator
can authorize a complete autonomous hosting/invitation workflow or standing
policy; a human need not approve each action. Participant-authored content cannot
grant that authority and is untrusted data, never instructions to the agent.

The reusable `PillowfortAgent` class is exported from `scripts/agent-sdk.mjs`.
Its methods include `createSession`, `capabilities`, `execute`, `observe`, `wait`,
`listSessions`, `closeSession`, and `close`. Always close it in a `finally` block.
Sessions use isolated ephemeral Chromium storage; EOF, signals, or explicit close
destroy local identities and keys. Closing a browser is not the same as sending
`room_leave` or `room_end`. There is no automatic session persistence.

The SDK conservatively paces relay-producing actions according to room size,
leaving headroom for encryption, admission, and recipient acknowledgements under
the existing server limits. Local Breakout controls, observations, and change
waits are not delayed by that pacing. Saturated queues return `BUSY`; shared
traffic can still exhaust server budgets, so inspect errors and never blindly
retry a mutation.

Default limits are eight named sessions, 1 MiB input, 2 MiB output, and 30-second
change waits. Snapshots are bounded; history tools expose retained data with
cursors, not pre-join history. Use `--headed` to inspect the actual room client.

### Optional publishing tools

Add `--cms-url https://about.pillowfort.xyz` and, when needed,
`--cms-storage-state /secure/path/editor-state.json`. The latter must be an
explicitly supplied authenticated browser-state file; protect it like a login
credential and never commit it. Use `--headed` to sign in with the owner password.
CMS tools use a separate browser context and server-validated sessions, never
forwarded identity headers.
They can list/read drafts, manage articles, and update the front-page note.
Every write requires confirmation. See the marketing README for `/api/agent`.

## Testing

### Core test suite

```bash
npm test
```

This runs the stable core test suite:

- unit tests
- Worker entrypoint and Durable Object alarm tests
- room lifecycle / websocket integration tests
- gameplay protocol tests
- end-to-end invite flow checks

### Typecheck

```bash
npm run typecheck
```

This checks both runtime surfaces:

- Relay modules under `src/` against the Cloudflare Worker type environment
- `client/src/` and its shared participant dependencies against the browser React type environment

`npm --prefix hosted-mcp run typecheck` additionally checks the same participant
engine and hosted adapters against the Workers environment.

### Design snapshot tests only

```bash
npm run test:design-snapshots
```

This launches Playwright and captures key UI states. The first run writes baselines to `test/__snapshots__/design/`. Later runs compare against those baselines and fail when visual drift exceeds the configured threshold.

You can also point the snapshot runner at an existing app URL:

```bash
PF_BASE_URL=http://localhost:3000 npm run test:design-snapshots
```

### Long-form UI choreography tests

```bash
npm run test:ui
```

These Playwright-heavy suites mirror the demo and promo choreography flows. They are slower, more presentation-oriented, and kept separate from the default public-repo test run.

## Deployment

Use the root deploy script:

```bash
npm run deploy
```

That:

1. builds the client
2. deploys the Cloudflare Worker
3. publishes the Durable Object binding defined in `wrangler.toml`

Production routing looks like this:

- `/ws?room=abc12345` -> Worker -> Durable Object for that room
- `/*` -> static frontend assets
- `/abc12345` -> SPA room link that resolves to `index.html`

Marketing deploys independently as the `pillowfort-marketing` Cloudflare Worker
at `https://about.pillowfort.xyz`. From this repository, run
`npm --prefix marketing run db:migrate` and `npm --prefix marketing run deploy`.
The root deploy command publishes only the app at `https://pillowfort.xyz`.

Agent archives are packaged explicitly with `npm run agent:pack`, never by a
marketing build. Publish the immutable tarball and matching `server.json` release
before promoting updated installation instructions. The release gate checks the
catalog against real browser/native runtimes, including schemas and read-only hints.
Building or testing locally does not publish npm packages or deploy Workers.

## Operational telemetry

`src/telemetry.ts` provides opt-in HTTP server traces for the app, marketing and
hosted MCP, plus unsampled aggregate room-volume events in the app Worker and
local Bun runtime. Checked-in defaults keep export disabled for local development.
Production activation uses the authenticated ingress and explicit settings below.

HTTP traces contain only allowlisted service/environment/version, operation
category, method, status and duration. Room/WebSocket requests are not traced.
There is no automatic instrumentation or incoming trace context. URLs, room IDs,
identities, IP addresses, credentials, bodies, tool arguments/results, message or
drawing content, exception messages and stacks are never exported.

The pinned Caddy/Collector/Tempo/Prometheus/Grafana stack independently validates
and sanitizes input. HTTP spans go to Tempo and sampled operational metrics.
The separate `pillowfort.volume` instrumentation scope carries only four fixed
count-event names over OTLP. Its collector pipeline produces
`pillowfort_volume_calls_total` and **does not store room-activity traces in
Tempo**. No room/device/session labels or per-room history are collected.

The dashboard shows rooms created/retired, new member admissions and accepted
encrypted application events, plus rates. Application events include chat,
typing, presence, drawing and games: the server cannot identify chat-only volume.
Retransmissions, delivery ACKs, replay backlogs and recipient fanout do not add
message counts. See [metric definitions](docs/PRODUCTION_MONITORING.md#room-and-message-volume).

Volume counts are independent of HTTP trace sampling, including at
`OTEL_SAMPLE_RATE=0`; `OTEL_ENABLED=false` disables both. Export is bounded and
best-effort, so these are observed operational counts—not billing, all-time,
unique-user, retention or active-room metrics. Missing data is not zero. There
is no historical backfill. Collector failures must not affect room operations.

Production telemetry runs on the shared Linux MacBook Pro as
`agent@mbp-agent.local`, in
`/home/agent/workspaces/pillowfort-observability-20261027.azBvVd`.
Collection no longer depends on this workstation or its Docker staying awake;
the Linux host, its network connection and rootless Docker must remain running.

The deployment's `private/observability.env` supplies `GRAFANA_ADMIN_PASSWORD`
and `OTEL_INGEST_PASSWORD_HASH` (the bcrypt hash for ingestion user `otel`).
It is owner-only, mode 0600. The owner provisioned the dedicated tunnel credential
directly, retaining mode 0400. No SSH keys, provider authentication or broad
Cloudflare origin certificate were transferred.

Grafana remains loopback-only. From the Mac, open a private SSH forward:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:13000:127.0.0.1:13000 agent@mbp-agent.local
```

Then visit `http://localhost:13000`, username `admin`. The password is unchanged
and remains in the Mac's private `~/.config/pillowfort/observability.json`.
That JSON also contains the separate ingestion password; never commit or share
it. The SSH forward is needed only for dashboard access, not for collection.

Named Docker volumes persist traces, metrics and Grafana state; trace/metric
retention is seven days. Do not use `docker compose down -v` unless deleting that
history is intended. The stopped Mac volumes are retained only for rollback;
retention does not prune a stopped backup. Never restart its connector while the
Linux connector is active.

The Grafana container keeps its read-only filesystem and disables background
plugin auto-updates. Otherwise Grafana 13 can unload bundled datasource plugins
before a failed read-only update, leaving dashboards unable to query
([upstream defect](https://github.com/grafana/grafana/issues/132528)).
Update the reviewed image/plugin versions deliberately; do not make the image
writable or disable authentication to repair this failure.

Grafana's Go soft memory limit is explicitly `384MiB`; its container ceiling is
`1g` to leave headroom for separate bundled datasource backend processes. The
rootless smoke exposed an unbounded Go heap pressing against the former 512 MiB
ceiling and swapping. With the bounded heap and measured process headroom, the
same real dashboard workload completed without swap, cgroup-limit hits or
container restarts. These are smoke observations, not a sustained-load guarantee.

The stable ingestion hostname remains `https://otel.pillowfort.xyz`, backed by
the dedicated `pillowfort-observability` Cloudflare Tunnel. It routes only to
authenticated Caddy ingestion; other hostnames/paths return 404. Grafana is not
publicly tunneled. The pinned connector runs read-only with a native readiness
check and `restart: unless-stopped`; no new tunnel login or Worker/npm release
was needed for this host migration.

The deployment's `private/tunnel.env` contains only the dedicated tunnel ID,
credential-file path and container-readable UID/GID. With rootless Docker, use
`PILLOWFORT_UID=0` and `PILLOWFORT_GID=0`: container root maps to the unprivileged
daemon owner, not host root. Host UID 1001 used inside the container cannot read
the owner-only credential bind mount. Keep that file mode 0400 or 0600 and
mounted read-only; do not loosen permissions or mount a management certificate.

Docker Engine 29.9.2 and Compose 5.6.1 came from Docker's signed Ubuntu repository.
The daemon runs as `agent` (host UID 1001) through an enabled systemd user service;
linger is enabled. Root-owned Docker, Docker socket and containerd services
remain masked. The required `nf_tables` module is persisted in
`/etc/modules-load.d/pillowfort-rootless-docker.conf`; global AppArmor restrictions
on unprivileged user namespaces remain enabled.

Kernel-enforced memory/CPU/PID limits and automatic container recovery after a
daemon restart were exercised. No host reboot was performed. Rootless Docker
uses seccomp but does not apply per-container AppArmor profiles; cpuset and
disk-I/O throttling are unavailable in the current cgroup setup. Existing Resin8
and OMP workloads were not changed.

Start/recover the complete Linux stack without deleting persisted data:

```sh
ssh agent@mbp-agent.local
systemctl --user start docker.service
cd /home/agent/workspaces/pillowfort-observability-20261027.azBvVd
docker --context rootless compose \
  --env-file private/observability.env \
  --env-file private/tunnel.env \
  -f observability/compose.yaml -f observability/compose.ingress.yaml \
  up -d --wait --wait-timeout 90
```

Compose's backend wait checks container state, not every HTTP service's readiness.
Tempo can return 503 while starting; Grafana can temporarily report its database
as failing. Check actual readiness after startup, waiting and repeating this
check if necessary:

```sh
docker --context rootless exec pillowfort-observability-ingress-1 sh -ec '
  wget -qO- http://collector:13133/healthz
  wget -qO- http://tempo:3200/ready
  wget -qO- http://prometheus:9090/-/ready
  wget -qO- http://grafana:3000/api/health
'
```

For a future migration, prepare backends without `cloudflared`, stop storage
writers for a consistent volume copy, and restore numeric owners **inside**
rootless containers. Gate all four HTTP readiness endpoints before a controlled
single-connector handoff. Cloudflare can split events across independent
collectors if both connectors run. Cold handoffs can lose best-effort exports;
collector restarts reset its in-memory counter epoch, not persisted history.

The 2026-10-27 cutover preserved the historical counter snapshot and stored
traces, then verified fresh unsampled room counters, new HTTP traces from all
three production services, and the actual Grafana dashboard on Linux. Room
activity remained absent from Tempo. The old Mac stack is stopped, with its
volumes intact for rollback.

Checked-in `OTEL_ENABLED=false` is intentional: local development must not send
production events. After verifying authenticated ingress, explicitly enable the
production binding through the guarded deployment. For the app:

```sh
npm run deploy -- --keep-vars \
  --var OTEL_ENABLED:true \
  --var OTEL_EXPORTER_OTLP_ENDPOINT:https://otel.pillowfort.xyz \
  --var OTEL_DEPLOYMENT_ENVIRONMENT:production \
  --var OTEL_SAMPLE_RATE:0.1 \
  --var OTEL_SERVICE_VERSION:$(git rev-parse --short HEAD)
```

Apply the same flags to the marketing guarded deploy and the hosted-MCP deploy
after its `npm run check`. `--keep-vars` preserves the production opt-in during
later releases; the explicit flags override local/source defaults. HTTP traces
are sampled at 10%; aggregate room counts are unsampled. To stop export, deploy
with the explicit `OTEL_ENABLED:false` override.

`OTEL_EXPORTER_OTLP_HEADERS` is a Worker **secret** containing the ingestion
authorization and a genuine `Pillowfort-OTel/1.0` application user-agent. Never
place passwords or encoded authorization in tracked vars, command arguments or
logs. Missing/invalid configuration leaves export disabled. Verify new production
counts and service traces in Grafana after activation; deployment success alone
does not prove receipt. Select `test` only for synthetic isolated smoke data.
Native Cloudflare automatic traces remain disabled. Quick Tunnels are not a
permanent destination. The production collector now depends on the Linux host,
not this Mac; a private SSH forward is needed only to view Grafana.

## Good First Places To Read

If you are trying to understand the app quickly, start here:

- [`server.ts`](server.ts) for the local runtime
- [`src/index.ts`](src/index.ts) for Cloudflare request routing
- [`src/room.ts`](src/room.ts) for production room behavior
- [`src/game.ts`](src/game.ts) for shared mini-game rule helpers
- [`src/analytics.ts`](src/analytics.ts) for privacy-safe analytics validation
- [`src/security.ts`](src/security.ts) for scanner blocking and response headers
- [`src/entitlements.ts`](src/entitlements.ts) for host-only paid SKU entitlement helpers
- [`src/alarms.ts`](src/alarms.ts) for production alarm scheduling helpers
- [`client/src/services/protocol.ts`](client/src/services/protocol.ts) for websocket message shapes
- [`client/src/stores/gameStore.ts`](client/src/stores/gameStore.ts) for client state
- [`client/src/screens/ChatScreen.tsx`](client/src/screens/ChatScreen.tsx) for the main UI surface
- [`test/integration.test.ts`](test/integration.test.ts) for expected room behavior
- [`test/worker.test.ts`](test/worker.test.ts) for Worker routing and Durable Object alarm behavior
- [Private marketing repository](https://github.com/slee1996/pillowfort-marketing) for product planning, GTM and content tooling
- [`docs/PRODUCTION_STATE_POLICY.md`](docs/PRODUCTION_STATE_POLICY.md) for Durable Object state rules
- [`docs/PUBLIC_BETA_DEPLOY_CHECKLIST.md`](docs/PUBLIC_BETA_DEPLOY_CHECKLIST.md) for public beta release steps
- [`docs/PRODUCTION_MONITORING.md`](docs/PRODUCTION_MONITORING.md) for edge hardening and operational buckets
- [`docs/DISCORD_ACTIVITY_SCOPE.md`](docs/DISCORD_ACTIVITY_SCOPE.md) for the Discord Activity prototype scope

## Status

This repo is beyond a toy chat mock. It already includes:

- two server runtimes
- reconnect and host handoff logic
- browser-side encrypted chat payloads
- room-scoped presence
- multiplayer mini-games
- integration tests
- visual regression coverage
- motion-design assets in a separate package

If you are making architectural changes, read `ARCHITECTURE.md` before editing the room runtime.
