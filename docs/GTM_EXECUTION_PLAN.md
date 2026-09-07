# Pillowfort GTM execution

Updated: 2026-09-07
Status: agent code/docs/download release shipped; cohort recruitment, outreach, and ad spend have not been executed.

The current strategy, thirty-day calendar, cohort definitions, decision thresholds,
spending limits, outreach drafts, and research sources are maintained in
[GTM_MARKETING_PLAN.md](GTM_MARKETING_PLAN.md). It supersedes the May plan's
logo/landing-page implementation work and assumed room-analytics funnel.

## Start here

1. Resolve the naming-review path and establish a reachable support contact.
2. Recruit ten warm friend-group hosts for a fifteen-minute shared drawing session.
3. Prepare three short product clips and one clear host invitation.
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

First-party remote MCP hosting is a separate custody/security decision, not a
shortcut hidden behind the existing end-to-end-encryption claim. The current
transport is local stdio with an operator-run browser.

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

1. **npm publication completed:** `@ontologic/pillowfort-agent@1.0.1` is published
   on npmjs.org under `ontologic`; GitHub and MCP identity remain `slee1996`.
   Registry metadata and tarball SHA-256 were verified after browser approval.
   A fresh npm install completed the production autonomous create/invite/verify/
   approve/chat/end workflow. The initial package-index 404 resolved after
   registry propagation; the normal version-pinned package name now installs.
   This machine has GitHub Packages registry overrides. To explicitly select npm,
   pass both `--registry=https://registry.npmjs.org/` and
   `--@ontologic:registry=https://registry.npmjs.org/`; global settings were not
   changed. The original 1.0.0 download remains unchanged.
2. **MCP Registry publication completed:** `io.github.slee1996/pillowfort` 1.0.1
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

Founder owns relationships, consent, scheduling, support, naming decisions and
approved spending. Assistant work can prepare assets, copy and the scorecard;
posting, contacting people and spending require explicit authorization.

Paid promotion remains subject to the
[Fort Pass promotion gate](FORT_PASS_SUPPORT_RUNBOOK.md#paid-promotion-gate).
Technical deployment success is not evidence of audience demand or payment readiness.
