# Pillowfort GTM execution

Updated: 2026-09-08
Status: agent release shipped; pilot materials and internal onboarding rehearsal completed. Cohort recruitment, outreach, and ad spend have not been executed.

The current strategy, thirty-day calendar, cohort definitions, decision thresholds,
spending limits, outreach drafts, and research sources are maintained in
[GTM_MARKETING_PLAN.md](GTM_MARKETING_PLAN.md). It supersedes the May plan's
logo/landing-page implementation work and assumed room-analytics funnel.

## Start here

1. Resolve the naming-review path and establish a reachable support contact.
2. Recruit ten warm friend-group hosts for a fifteen-minute shared drawing session.
3. Use the two reviewed human/agent product clips and the consent-based invitations.
4. Track consenting hosts manually; do not collect room links, secrets, transcripts,
   or protected activity through analytics.
5. Get twenty first sessions and measure confirmed seven-day repeats before buying
   traffic or organizing a broad platform launch.

## Agent distribution track

Treat agents as a second acquisition track, with a proposed 25% of first-month
effort and a separate ten-operator cohort. The operating plan distinguishes
assistant recommendations from operator-installed, authorized tool use.

1. Publish a real `/agents` page, clean Markdown recipes and a concise `llms.txt`
   index on the public product origins. Verify factual answers and crawlability;
   no special file guarantees AI-search placement.
2. Package the existing MCP transport separately, with explicit Node/Chromium
   prerequisites, a safe diagnostic and tested Codex/VS Code configurations.
3. Test cold installation and first host-authorized interactions with ten consenting
   operators. Include autonomous agent-host rooms; a human need not be present.
4. Publish the package and verified MCP Registry metadata through owner accounts.
5. Share consented human+agent drawing/game demos and measure unassisted task
   completion and repeat operators, not raw tool calls or package downloads.

The founder approved both hosted MCP and native WebMCP alongside local stdio.
Hosted participation has an explicit managed-custody disclosure, issued operator
keys/OAuth, tenant isolation, and bounded browser/session budgets.

## Agent release delivered on 2026-09-07

- Public guide: https://about.pillowfort.xyz/agents
- Discovery: `llms.txt` on app and marketing origins, generated `llms-full.txt`,
  Markdown setup/workflows/security, 61 room/session tool schemas, canonical and
  Markdown alternate metadata, accurate SoftwareApplication data, and sitemap.
- Standalone `@slee1996/pillowfort-agent` 1.0.0 tarball and SHA-256 sidecar:
  https://about.pillowfort.xyz/downloads/pillowfort-agent-1.0.0.tgz
- Public checksum-identical GitHub mirror:
  https://github.com/slee1996/pillowfort/releases/tag/agent-v1.0.0
  Plain Python download from GitHub succeeded and matched SHA-256
  `cc9d4b726a51f2a632448165367c0156c53277193af4272b89fd90e1a1e4271b`.
- Explicit `install-browser`, nonmutating `doctor`, SDK exports, stdio MCP,
  JSON-lines interface, three MCP resources, and three workflow prompts.
- `autonomous` creates a real room, privately invites its isolated agent peer,
  verifies the expected fingerprint, approves, exchanges messages, and ends it.
  No human or UI clicks are required. External invitation delivery uses the
  agent's separately authorized private communication channel.

Verification completed:

- App release gate: 456 tests passed, typechecks/build and pinned OpenMLS check.
- Marketing lint/typecheck/build and all six existing tests passed; final page
  additions rebuilt. Desktop/mobile visual inspection caught and fixed navigation
  wrapping; no page overflow at 390px.
- Clean package install with a fresh browser directory: doctor failed safely
  before explicit installation, then passed after installing matching Chromium.
- Actual MCP consumer: handshake, tools/resources/prompts, unknown-resource/prompt
  and secret-argument rejection, autonomous room creation/invitation, mismatched
  fingerprint rejection, verified admission, received drawing, full RPS
  commit/reveal with private opponent picks, and observed room teardown passed.
- Exact public `npm exec --package=<download URL>` autonomous command passed
  against production from an empty working directory and fresh npm cache.
- Codex and VS Code CLI registration checked in isolated profiles. Live
  model-driven chat sessions in those applications remain unverified.
- `server.json` passed the official MCP Registry JSON Schema.
- Standalone installed runtime dependency audit: zero reported vulnerabilities.
  GitHub still reports 57 open alerts; none matched the current local lockfile
  versions at their reported paths. Alerts were not dismissed.

## Account and distribution actions remaining

1. **npm publication completed:** `@ontologic/pillowfort-agent@1.1.0` is published
   on npmjs.org under `ontologic`; GitHub and MCP identity remain `slee1996`.
   Registry metadata and tarball SHA-256 were verified after browser approval.
   A fresh npm install completed the production autonomous create/invite/verify/
   approve/chat/end workflow. The initial package-index 404 resolved after
   registry propagation; the normal version-pinned package name now installs.
   This machine has GitHub Packages registry overrides. To explicitly select npm,
   pass both `--registry=https://registry.npmjs.org/` and
   `--@ontologic:registry=https://registry.npmjs.org/`; global settings were not
   changed. The original 1.0.0 download remains unchanged.
2. **MCP Registry publication completed:** `io.github.slee1996/pillowfort` 1.1.0
   is published with npm package `@ontologic/pillowfort-agent`. Used the official
   publisher v1.8.1, verified its download against GitHub's SHA-256, authenticated
   with the existing `slee1996` owner credential, and verified the public record.
3. **Cloudflare crawler compatibility:** plain Python urllib requests to public
   docs/downloads receive edge 403/error 1010, while browser-style reads and the
   exact npm install/run path succeed. Existing Wrangler OAuth cannot read zone
   security settings/rulesets (9109/10000); dashboard relay access timed out.
   An owner session or appropriately scoped zone token is needed to inspect and
   narrowly exempt public read-only documentation/download paths from the
   offending browser-signature check. Keep admin/API and room protections intact.
   Do not claim universal crawler access until those clients have been retested.
4. **Search visibility:** verify Search Console ownership, sitemap processing and
   actual citations with fixed branded/unbranded questions. Files do not guarantee
   indexing or recommendations. Training-bot restrictions remain unchanged.
5. **People:** recruit the ten consenting agent operators and twenty friend-group
   sessions; collect setup friction and seven-day returns, not private room data.
   Use consented demos and community-specific submission rules. Our test agents
   are verification, not acquired users or traction.

The downloadable version is a release: bump its version and registry metadata
for changed runtime/docs instead of replacing an already published artifact.

## Agent discovery maintenance — 2026-10-26

Research and the maintained implementation/provider recipe are in
[Search and agent discovery](../marketing/README.md#search-and-agent-discovery).
Google's current guidance treats crawlability, useful indexable content, and
Search Console as the foundation; it explicitly does not use `llms.txt` as
special ranking markup. The latter is an on-demand agent documentation index.

The web indexes now derive release information from `server.json`, link to the
Registry's `versions/latest` endpoint, expose `/agents/server.json`, and distinguish
the app, hosted MCP, and editor-only CMS. Standard discovery headers, consistent
site/application metadata, published-only article sitemaps, and private-document
noindex policies complement the files. Published agent 1.1.1 bytes are unchanged.

Actual local Worker/browser verification used an isolated D1 database with a
published article and a private draft: only the publication appeared in the
sitemap, its canonical/social metadata resolved to the article, and the draft
returned 404. Database-unavailable sitemap responses return 503, not an empty
success. Both application runtimes exclude room documents from indexing.

The live baseline still has a provider-level gap: default Python `urllib`
receives 403 / Cloudflare 1010 on public docs and public OAuth metadata, while
identified Node requests and an OAI-SearchBot-style user-agent return 200.
The latter does not prove access from real crawler IPs. The narrow BIC-only
public-read exception documented above needs zone security write access;
origin code and Wrangler's `zone:read` cannot apply it. Do not mark this resolved
until default Python requests work and private/auth/training restrictions remain
intact. Never disable those controls to improve a directory badge.

Search Console ownership, sitemap processing, actual search/answer-engine
citations, and the historical Glama health investigation remain unverified.
Files, schema, synthetic fixtures, and successful package installs are not
evidence of ranking, recommendations, or pilot adoption.

## Hosted MCP and WebMCP release

The browserless cutover was deployed and verified in production on 2026-09-10:

- App: `f4c7628a-99fe-4d21-80f9-36ad7f0db6ee`.
- Hosted MCP: `9bda0d7e-894b-457b-b824-14bcc60bb384`.
- Marketing/docs: `9f0b8aa7-8d1a-418b-a123-c51efb82108e`.

All MCP ingress was blocked while the legacy Worker and its alarms remained
running. The drain lasted 888 seconds; managed-browser inventory was empty
before and after the native verification. Existing Durable Object namespaces,
authorization secrets, and the global quota ledger were preserved. No browser
binding remains in hosted MCP.

Production enforces a native PBKDF2 limit absent from local workerd. The shared
engine now retains exactly 600,000 PBKDF2-HMAC-SHA256 iterations using pinned
portable code when native derivation is unsupported. Derived-key equivalence
is regression-tested. Hosted CPU is capped at 30 seconds; the existing
2-session/60-session-minute budgets are unchanged.

Live verification covered native/native/browser fingerprint admission, two-way
encrypted chat and drawing, native PNG export, Breakout, RPS commit/reveal,
Tic-Tac-Toe, relay-authorized host transfer, room teardown, MCP DELETE, and
rejection of closed sessions. Public authenticated initialization and tool
discovery passed after maintenance was removed; unauthenticated MCP returns
401 and health returns 200. The temporary gate was deleted and its dedicated
verification operator key was revoked. These synthetic checks are not pilot users.

The historical browser-backed release record follows.

- Hosted endpoint: `https://mcp.pillowfort.xyz/mcp`; Worker `pillowfort-mcp`.
- Local package: `@ontologic/pillowfort-agent@1.1.0`; existing releases remain intact.
- Native WebMCP: actual browser API registration, tested in Chrome152 with
  experimental features enabled. No polyfill or testing interface in shipped code.
- Authentication: revocable operator keys, OAuth consent, PKCE S256, exact
  scope/audience checks, client metadata discovery, and bound CSRF protection.
- Budget: two active browsers globally, one per operator, two named participant
  contexts per connection, ten-minute absolute lifetime, two-minute idle expiry,
  sixty-browser-minute daily reservation budget and bounded connection issuance.
- No hosted/native CMS or payment tools; no arbitrary hosted navigation, raw-key
  export, or persisted room transcripts. Hosted custody is disclosed in setup,
  consent, and privacy documentation.

Verification: local and published-package smoke; real native create/invite/
fingerprint/admit/chat/draw/end; real Cloudflare managed-browser collaboration;
global/per-operator/context limits; actual browser closure and quota reuse after
DELETE, key revocation, and idle expiry; direct/OAuth tenant isolation; real browser
OAuth consent and PKCE exchange; and absolute-session-expiry regression coverage.
The app release gate passed 456 tests, marketing passed 6, and hosted security
includes 4 real-Worker/browser regressions. These tests are not acquired users.

Operator administration:

- The private workstation file `~/.config/pillowfort/hosted-mcp.json` holds service
  bootstrap secrets and issued owner-key material. Its permissions are 0600.
  **Never share the whole file.** `adminToken` and `consentSecret` are deployment/
  administration secrets; MCP clients receive only an intended operator key.
- Issue a pilot key with authenticated `POST /admin/keys`, JSON
  `{\"label\":\"pilot-alex\",\"expiresInDays\":30}`, and the administration bearer token.
  The response returns the raw operator key once; save/share it privately.
- Revoke with authenticated `DELETE /admin/keys/:id`. Direct and derived OAuth
  access stop on subsequent requests; background browser cleanup follows lifecycle
  checks. Do not rotate the HMAC/consent secret as a substitute for revocation.
- Never publish operator keys in npm, registry metadata, examples, URLs, or logs.

Development: install locked root and `hosted-mcp` dependencies, install Playwright
Chromium for the browser-consent regression, then run
`npm --prefix hosted-mcp run check`. The tests create isolated local Worker state
and do not allocate production browsers. Real Browser Run smoke requires the
deployed keyed service. Deployment uses `hosted-mcp/wrangler.jsonc`; preserve
existing deployment secrets and inspect browser usage before raising budgets.

Founder owns relationships, consent, scheduling, support, naming decisions and
approved spending. Assistant work can prepare assets, copy and the scorecard;
posting, contacting people and spending require explicit authorization.

Paid promotion remains subject to the
[Fort Pass promotion gate](FORT_PASS_SUPPORT_RUNBOOK.md#paid-promotion-gate).
Technical deployment success is not evidence of audience demand or payment readiness.

## Pilot preparation and discovery check — 2026-09-08

- Invitations, onboarding, and separate agent/operator and friend-host scorecards
  are under `docs/pilot/`. The CSVs contain headers only. Contact mappings belong
  in a separate restricted store; no room links, content, keys, or identity
  fingerprints belong in the scorecards.
- A fresh individual hosted key and a freshly installed standard MCP client
  fetched the public guide, discovered schemas, created a real production room,
  invited a separate normal browser, checked the exact device fingerprint,
  exchanged drawing in both directions, and observed room closure. The MCP
  session was terminated and the temporary key revoked. The machine-readable
  record is `docs/pilot/rehearsal.json`. This was a fourteen-second **synthetic
  internal rehearsal**, not an unassisted external operator or cohort result.
- Both reviewed demo clips use real local application/MLS flows with synthetic
  content. Setup and admission are not shown; credential and room-code surfaces
  remain masked. Each is 22 seconds, H.264, 1280×800. See
  [capture details and public links](pilot-demos/README.md).
- Public sitemap includes `/agents`; live robots directives allow search and
  retain the managed training-bot restrictions. This does not establish Search
  Console ownership or prove that every crawler can fetch every public path.

Fixed search-enabled answer checks:

| Query | Observed result |
| --- | --- |
| `Pillowfort private rooms MCP agents pillowfort.xyz` | Found the repository/registry and Glama, but incorrectly claimed the README lacked MCP setup instructions. Directly fetching the current README showed local, hosted, and native instructions plus managed-custody disclosure. |
| `private browser drawing room friends no account` | Recommended Flockdraw, FizzPaint, Drawesome and other alternatives; no Pillowfort citation appeared in the returned answer. |

The [Glama connector listing](https://glama.ai/mcp/connectors/io.github.slee1996/pillowfort)
showed **Unhealthy**, **OAuth Works in Glama**, and no schema history at the time
of this check. The actual failure details require a claimed author account.
The authenticated rehearsal above passed; the badge's cause is **not yet known**.
Do not weaken authentication to change it.

Owner followups: claim the Glama listing and inspect its health-check failure;
verify Search Console and submit
`https://about.pillowfort.xyz/sitemap.xml`; inspect the previously observed
Cloudflare plain-client 403 with an appropriately scoped zone session. Current
[README](https://github.com/slee1996/pillowfort) and
[agent guide](https://about.pillowfort.xyz/agents) already document connection
requirements. Search summaries can lag or misread them; these checks are not
search ranking, indexing, adoption, or retention measurements.

## Operational telemetry release — 2026-09-08

- Deployed explicit manual OTel instrumentation to app, marketing and hosted MCP,
  with `OTEL_ENABLED=false` in every production Worker. Production export has
  **not** been enabled.
- Open-source Collector/Tempo/Prometheus/Grafana stack runs locally behind
  authenticated Caddy ingress. Grafana is localhost-only. Configuration and
  distinct credentials are in the private workstation files documented in the
  root README; no credentials are checked in.
- Real SDK export through a temporary Cloudflare Tunnel returned OTLP HTTP 200.
  The resulting span was retrieved from Tempo; request-query and response-body
  canaries were absent. A separately poisoned span verified collector-side
  removal of disallowed resource/attribute/context/event/link/error-message data.
  Operational counters and duration histograms were queried and visually
  inspected in authenticated Grafana. A stored synthetic trace survived a Tempo
  restart.
- App release gate passed 466 tests including ten telemetry regressions; pinned
  OpenMLS verification and production build passed. Marketing lint, typecheck,
  build and six existing tests passed. Hosted typecheck and deployment passed.
  Fresh-key production onboarding passed again after deployment.
- Marketing builds now mirror the integrity-verified **published npm artifact**
  instead of regenerating a previously published version from changed source.
  Public 1.1.0 download bytes match that artifact; both public MP4s match the
  reviewed local clips.
- Deployment versions: app `ad965541-7774-41ce-9972-e317bcabb5bb`,
  marketing `75effe25-a367-40a7-b581-851362941f5a`, hosted MCP
  `0ba96998-ca7b-4b18-a3a3-0a3e992aa666`.

At that release, named-tunnel authorization and production activation were still
pending, and the collector was workstation-hosted. Those prerequisites were
completed in the stable-ingress release below; collection subsequently moved to
the shared Linux host. Quick Tunnels remain unsuitable as permanent destinations.

## Room-volume observability — 2026-10-26

- Added opt-in, unsampled room-created/retired, new-member-admitted and accepted
  encrypted-application counts to the Worker DO and local Bun runtime. These
  contain no room/device/member identity or content and do not claim chat-only,
  all-time, active-room or unique-user totals.
- A separate collector pipeline aggregates the count events without storing
  activity traces in Tempo. Prometheus and the existing Grafana dashboard now
  include the volume counters; HTTP sampling does not reduce them.
- Real workerd execution reproduced a silent export failure: its fetch API
  rejects `redirect: "error"`. Manual redirect handling preserves the existing
  no-credential-forwarding policy while allowing export.
- Real Grafana 13.2.1 reproduced a bundled-plugin auto-update failure against the
  read-only filesystem. Disabling background plugin auto-updates keeps the
  reviewed image's Prometheus/Tempo plugins registered without making the image
  writable or weakening authentication.
- An isolated authenticated stack received a real encrypted host/guest workflow
  from the app Worker at HTTP trace sample rate zero: one room creation, one
  retirement, one new admission and three ordinary encrypted application events.
  These synthetic `test` counts were queried through Grafana and visually
  checked. They are not production adoption or historical usage measurements.
- Production activation still requires the existing stable authenticated-ingress
  prerequisite. Wrangler login is not named-tunnel authorization; the local
  `cloudflared` command found no origin certificate. Do not use a Quick Tunnel
  as a permanent production destination.


## Stable telemetry ingress — 2026-10-27

- Owner completed named-tunnel authorization. Created the dedicated
  `pillowfort-observability` tunnel and the `otel.pillowfort.xyz` DNS route.
- Added a separate Compose ingress overlay using the digest-pinned cloudflared
  2026.10.4 image. Its non-root process reads only the dedicated tunnel credential,
  uses a read-only filesystem and native readiness check, and restarts with Docker.
  The broader management certificate is not mounted. Grafana remains local-only.
- Verified the real stable HTTPS endpoint: authenticated health and empty OTLP
  requests return 200; unauthenticated health/export return 401; `/login` returns
  404. Existing Grafana and ingestion credentials were used in place and were
  neither printed nor rotated.
- Stored ingestion authorization as a secret on all three existing Workers.
  Source defaults remain off for development; the production activation uses
  explicit guarded deployment overrides, 10% HTTP sampling and unsampled room
  counts. Deployment/receipt evidence belongs in the activation PR release record.
- This ingress initially ran on the workstation. The subsequent Linux cutover
  below removed collection's dependency on this Mac and its Docker.

## Rootless Linux host preparation — 2026-10-27

- Owner selected rootless Docker for the shared Linux MacBook Pro. Used existing
  key-only maintenance access to install signed Docker Engine 29.9.2, Compose
  5.6.1 and the UID/network prerequisites. No existing packages were upgraded.
- The daemon runs as unprivileged `agent`; root-owned Docker/containerd services
  are masked. Existing subordinate UID/GID ranges, systemd delegation and linger
  were reused. Loaded/persisted only the required `nf_tables` kernel module;
  global AppArmor namespace restrictions were not disabled.
- An actual native container verified UID mapping, enforced memory/CPU/PID limits
  and automatic restart after a daemon restart. A nonsecret mode-0600 bind mount
  was readable by container UID 0 and denied to container UID 1001; real
  credentials were not read for this test.
- Initial preparation staged public release `8947f46` configuration without
  transferring credentials or switching production. The owner subsequently
  provisioned the two project-specific runtime files directly before the cutover.

## Linux production telemetry cutover — 2026-10-27

- Migrated Grafana, Prometheus and Tempo volumes with their storage writers
  stopped. Restored numeric owners from inside rootless containers. Compared a
  fixed historical counter snapshot and retrieved five historical trace samples;
  Grafana database health and its existing authenticated session were preserved.
- Initial handoffs rolled back before starting the Linux connector because
  container startup preceded actual HTTP readiness. Reproduced Tempo's starting
  503 and Grafana's temporary database-failing 503, then gated Collector, Tempo,
  Prometheus and Grafana on actual HTTP readiness before the successful handoff.
- Stopped the old connector before starting the Linux connector; the stable
  `https://otel.pillowfort.xyz` endpoint is unchanged. Authenticated health/export
  returned 200, unauthenticated requests 401, and the Grafana login path 404.
- Exercised a real ephemeral room with isolated host/guest browser participants:
  private invitation, fingerprint verification, explicit admission, encrypted
  message exchange and observed room teardown. Verified all room-volume counters
  with sample timestamps after that workflow, not just restored historical data.
  Verification activity is included in those operational counts.
- Generated genuine HTTP traffic and queried traces with a post-cutover time
  boundary; app, marketing and hosted MCP all delivered new spans. No room
  activity traces were stored. Visually verified the production Grafana dashboard
  through a private SSH forward at its unchanged `http://localhost:13000` URL.
- All six old Mac containers are stopped; their volumes remain as cold rollback
  copies and are not retention-pruned while stopped. Linux ingestion stayed
  healthy after stopping the Mac stack. Never run both connectors against
  independent collectors.
- Grafana credentials are unchanged. The owner-provisioned environment remains
  mode 0600 and the dedicated tunnel credential mode 0400. SSH keys, provider
  authentication and the broader Cloudflare certificate stayed in place.
- No Worker redeployment, npm publication, new tunnel login, public Grafana
  exposure or changes to the existing Resin8/OMP workloads were required.
- The Linux resource smoke exposed Grafana's unset Go memory limit, active
  cgroup-limit reclaim and swapping at its former 512 MiB ceiling. Set
  `GOMEMLIMIT=384MiB` and a bounded 1 GiB container ceiling to accommodate its
  separate datasource backend processes; no plugins or security controls were
  disabled. Re-exercised the actual dashboard and observed the configured Go
  limit, zero container swap, zero cgroup-limit hits and no restarts. See the
  [Go memory-limit guidance](https://go.dev/doc/gc-guide) for why a Go soft limit
  is not a total-process or multi-process container RSS limit.


## Agent activation and discovery repair — 2026-10-29

Historical snapshot: the manual-key gate described here is superseded by the self-service cutover below.

- The external hands-on report established native host creation/invitation/teardown,
  but not independent peer admission or collaboration. Shared-profile locking,
  missing hosted access, and a blocked Chromium download were distinct boundaries;
  none justified weakening identity locks, TLS, runtime requirements, or admission.
- Native action failures now resolve as structured `ok:false` results, including
  stable code/message/retryability. Browser validation and cancellation errors use
  the same boundary. The underlying single-writer identity lock remains intact.
- Connection failures explain that another tab or reasoning context is not an
  isolated browser participant. Local/hosted named sessions and separate browser
  contexts/profiles remain the supported isolation routes; takeover replaces an
  owner and must not be used to create a peer.
- Added ChatGPT custom MCP/OAuth instructions and a public GitHub beta-access
  request link. Issuance remains manual and capacity-limited, with private key
  delivery arranged separately. No anonymous allocator, key bypass, new account
  provider, or increased hosted budget was introduced.
- Updated both `llms.txt` indexes, combined `llms-full.txt`, canonical setup and
  workflows, readable/JSON tool catalogs, and hosted discovery headers. Live
  status/MIME checks passed for those documents and both sitemaps. Singular
  `llm.txt`/`robot.txt` paths remain 404. Training-crawler restrictions and private
  room noindex remain intact. Anonymous MCP GET correctly returns an empty 401
  with the OAuth resource metadata challenge, not a JSON document.
- Marketing builds no longer repackage the immutable agent download. An explicit
  pack refuses changed inputs under an existing version; exclusive publication
  also prevents concurrent overwrite. Production `1.1.1` archive SHA-256 remained
  `d3a47a03f6e7ad6ee482aca0c12deee0a13df412be2e7502cc98b47350c702b1`.
- App release gate passed (479 tests, typechecks, pinned OpenMLS verification,
  production client build); marketing passed lint/typecheck/build and eight
  existing tests; hosted MCP passed typecheck/build and six existing tests.
- Real local and production browser participants completed exact-fingerprint
  admission, six encrypted messages verified in the receiving participant, and
  room destruction observed on both sides. Real native browser invocations
  returned structured `stale-room` with no message/operation side effect, followed
  by observed teardown. Desktop and 390px marketing surfaces were inspected.
  These were synthetic, single-driver smoke runs with isolated browser identities,
  not independent external model operators, acquired users, or retention evidence.
- Fresh aggregate production activity remained visible after deployment.
  Verification activity contributes to those counters; do not label it organic.
- Deployed app version `903f7154-2bb2-42be-b8f0-2488281a0b35`, marketing version
  `0a1b1d03-0078-439a-b81d-feea42ee2a05`, and hosted version
  `e57a2741-21d9-4eda-b24c-fddcd9b3b03a`, preserving explicit production telemetry.
- Installed Court Jester verification passed the shared participant-agent file.
  Native-adapter authoritative tests passed, but the overall result was
  inconclusive because the unchanged detector export was not covered. Other
  checked test/script/worker/TSX files encountered no-export or incompatible-test-
  artifact harness limitations. These are not claimed as Court Jester passes.
  The static JSON-LD lint warning concerns escaped, application-owned structured
  data, not untrusted HTML insertion. No gate was disabled to obtain a pass.
- Search Console performance/indexing reports and the complete authenticated
  ChatGPT frontend flow remain unavailable to this session. Public fetches are
  not proof of access from a real search crawler's IPs or evidence of ranking.

## Self-service hosted access and retest repairs — 2026-10-30

- Removed the maintainer-issued key prerequisite. Public `GET /preflight` describes
  readiness without allocating a participant. `POST /access` with exactly
  `{"acceptManagedCustody":true}` returns a private one-hour `mcp:rooms` bearer.
  OAuth creates the same bounded access through consent, without account/key entry.
  `DELETE /mcp/access` revokes direct or OAuth access and derived refresh.
- Revocation stays inside the token's protected `/mcp` resource. The first real
  Worker regression run caught sibling-path audience rejection; the corrected
  protected subresource passes without relaxing audience, scope, PKCE or CSRF checks.
  Issuance is rate-limited per address and globally; existing compute quotas remain.
- Hosted discovery defaults to 23 collaboration tools; the public full local
  snapshot has 63, and production full hosted discovery exposes 59 supported tools.
  Full hosted discovery requires `Pillowfort-Toolset: full` at initialization;
  native full discovery uses `?agent_tools=full`. Toolset selection is immutable
  during a hosted connection. Local stdio keeps its full catalog.
- Added advisory `participant_preflight` and receiver-local `chat_verify_received`.
  Verification requires the intended receiver, exact sender/text and a receiver
  cursor captured before sending. Old duplicates and sender echoes cannot satisfy
  it; missing/truncated history is not proof of non-delivery or a human-read receipt.
- The first production rehearsal exposed ordinary actor hibernation: a separate
  diagnostic returned `MCP session lost or expired` after 12,289 ms without activity.
  A bounded deadline timer now preserves memory-only MCP state until idle/absolute
  expiry; durable alarms remain crash-safe cleanup. Deployment/runtime restarts
  still fail closed, and keys are never persisted. Added a twelve-second quiet-gap
  state-preservation regression while retaining the absolute-expiry regression.
  See [Cloudflare's lifecycle contract](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
- Verification: root `npm run check` passed 481 app/security tests plus typechecks,
  pinned OpenMLS artifact verification and the client build. `npm run check` in
  `hosted-mcp` passed eight real Worker/browser regressions and the dry-run build;
  the same command in `marketing` passed lint, typecheck, build and eight existing
  rendered tests. Used Node 22.23.4 and Bun 1.4.4, not the unsupported shell defaults.
- Production: two separately authenticated MCP connections created isolated native
  participants, privately invited, matched the exact joining fingerprint and observed
  admission on both peers. Six alternating encrypted messages were verified using
  the new tool on the intended receiver after its saved cursor. Guest leave and
  host room destruction were observed, then both named sessions/MCP connections
  were closed and both grants revoked; subsequent access returned401.
  One scripted driver, not independent LLM agents, acquisition or retention evidence.
- Real production browser consent contained zero password/key inputs and completed
  an S256/loopback callback without any existing key. Its OAuth bearer initialized
  full MCP discovery; self-revocation returned204, later access401 and refresh400.
  This is a generic OAuth-client proof, not the unavailable authenticated ChatGPT UI.
- Public discovery smoke passed twenty status/MIME checks: both identical `llms.txt`
  indexes, robots/sitemaps, canonical Markdown, full/focused catalogs, protected
  resource metadata and the expected anonymous MCP401 challenge. Singular
  `llm.txt`/`robot.txt` remain404. Production `1.1.1` archive SHA-256 remains
  `d3a47a03f6e7ad6ee482aca0c12deee0a13df412be2e7502cc98b47350c702b1`.
- Deployed app `7152052b-21a7-4a66-aaad-5f40e897f539`,
  hosted MCP `595e53e8-53cf-4bb3-b3cc-f451cb54ef42`, and marketing
  `d090370c-4943-4c83-a664-2d803a43b10b`, explicitly preserving production telemetry.
- Court Jester checked all thirteen changed executable source/test files.
  `src/participant/agent.ts` passed authoritative verification; native adapter tests
  passed but its unchanged detector export left overall coverage inconclusive.
  Worker imports (`cloudflare:workers`), `.mjs` authoritative-test incompatibility,
  missing TSX launcher and no-export scripts prevent a blanket pass. Browser-only
  bridge fuzzing without `location`, and extracted test callbacks without their
  lexical closures, produced harness-context failures; reported to tool QA, not
  hidden with production fallbacks. Static legacy/style advisories were inspected.
  Exact commands, individual results and retained proof JSON are under
  `/tmp/pillowfort-selfservice.3YCTfr/`; `court-commands.json` inventories the commands.
  Desktop/mobile marketing and native browser surfaces were exercised. Later
  screenshot operations stalled in the browser harness; live consent DOM and
  functional OAuth verification succeeded. No new ChatGPT/GSC access is claimed.

## Browser verification and release parity candidate — 2026-10-30

- The ordinary production UI passed in two separate Chromium processes: a
  1280×900 desktop host and a 390×844 mobile-sized guest. Used visible controls,
  not the application bridge, to create a room, exercise manual-copy fallback,
  verify the guest fingerprint, approve admission, exchange chat and drawing
  both ways, and finish rock-paper-scissors with matching results.
  Mobile document width matched its viewport. Both clients observed room
  destruction, returned home, and closed. This is not Safari/Firefox or
  physical-device verification.
- Prepared SDK/Registry candidate `1.1.2`, source tag `v1.1.2`. The new release
  gate compares the checked-in catalog with real browser and native MCP
  registries: names, input schemas, annotations, server version, and release
  digest. It executes observational exports and checks unchanged participant
  revision/operations. Missing tools, altered schemas, and lost read-only
  annotations are rejected by real-runtime regression checks.
- Shared participant capability metadata now carries read-only semantics into
  local MCP and native WebMCP. Catalog generation no longer patches those hints
  after discovery. Public app/marketing release JSON and hosted health/preflight
  identify the same source tag and full-catalog digest.
- Capacity errors carry `retryAfterSeconds` and distinguish infrastructure
  rejection from admission/encryption failures. Lost/expired MCP identities
  return structured reinitialization guidance and are never silently restored.
  Pending-call closure preserves the warning that a mutation outcome can be
  unknown. Quotas and cryptographic/admission authority are unchanged.
- Verification: `npm run check` passed 484 tests, client typechecks, pinned
  OpenMLS verification, production build, and the real 63-browser/59-native-tool
  parity gate. `npm --prefix hosted-mcp run check` passed 9 actual Worker
  regressions and a deploy dry run, including capacity rejection without losing
  existing participants and the absolute connection deadline.
  `npm --prefix marketing run check` passed lint/typechecks and 8 rendered checks.
- A separate Node/browser SDK process and Bun/native participant process each
  discovered its own action interface, created its own identity, coordinated
  invitation and exact-fingerprint admission through a private mode-0700
  rendezvous, receiver-verified the other message, and observed room end.
  Both runtimes closed and private rendezvous data was removed. An initial
  smoke-only missing-Origin failure was corrected in the throwaway transport,
  not hidden with a production fallback. These are deterministic client
  processes, **not independently reasoning LLMs**; no subagents were used.
- Full catalog SHA-256:
  `1fc675e0d8806e3ded1a652d26c6c56f5fe00ea1597eb7308291c0479f26ee5c`.
  Candidate tarball SHA-256:
  `aeb1011c58c10168dbf8f5497d73cc75f8d1b3589991432fc05ece0fbd53cddb`.
  The published `1.1.1` archive is unchanged. Packaging is not publication.
- Court Jester checked sixteen executable file scopes. The shared agent passed
  authoritative native tests; `scripts/check-agent-catalog.ts` passed runtime
  smoke. Ten scopes were inconclusive: unexported scripts, unsupported Worker
  imports/bootstrap, and unavailable TSX launcher. Four scopes raised generated
  fixture flags: an agent object missing required methods, intentional CLI
  argument rejection, and extracted callbacks missing lexical bindings.
  Findings were inspected/reported to tool QA; no blanket Court Jester pass.
  Exact commands and individual outputs:
  `/tmp/pillowfort-selfservice.3YCTfr/parity-court-commands.json`.
  Cross-process proof: `mixed-client-proof.json` in that directory.
- Publication remains a separate gate: use the immutable npm tarball, publish
  matching GitHub source/tag, wait for the tag-triggered checked MCP Registry
  publication, deploy matching app/hosted/marketing artifacts with production
  telemetry explicitly enabled, verify live release identity, then promote the
  npm dist-tag. Do not describe the candidate as shipped until those steps pass.

## Marketing release audit repair — 2026-10-30

- Owner-authorized source publication pushed `b1d4d59` to `main`. Its release
  check exposed the real remaining npm audit failure: Satori SVG escaping
  (GHSA-wx4j-mvgx-mqwp) through Vinext's OG dependency. Root, client and hosted
  lockfile audits reported zero vulnerabilities.
- Kept the reviewed framework/React versions. Scoped overrides select
  `@vercel/og` 1.0.3 / Satori 0.33.5, plus the compatible `fflate` 0.7.5 security
  backport for GHSA-px8p-9vwx-vf98. Marketing lint, typecheck, production build,
  eight rendered-page checks and its full npm audit passed with zero findings.
- The actual agent guide rendered under local workerd on desktop and a
  390-pixel viewport, with matching document width and current 1.1.2/self-service
  instructions. No production runtime shims were introduced.
- A temporary dynamic OG route was removed, not shipped. Direct Node and local
  workerd image probes exposed upstream HarfBuzz initialization incompatibilities.
  Pillowfort has no dynamic ImageResponse call sites or advertised OG-generation
  feature; those probes are not reported as passing functionality.
- GitHub's 72 open alerts referenced older versions or removed packages, rather
  than the current lock entries. Checked all reported package/manifests against
  current root/client/video lock entries, including Remotion 4.0.496 (the four
  critical alerts target versions below 4.0.410), fast-uri 3.1.9, source-map-js
  1.2.2 and ws 8.21.0. No alerts were manually dismissed.
- npm 1.1.2 remains published under `next`, verified byte-identical to the
  immutable candidate archive. SDK bytes and the full-catalog digest are unchanged
  by this marketing-only dependency repair. Final promotion still requires the
  matching source tag, Registry publication and deployed release identity.

