# Application acceptance — 23 November 2026

**Disposition: hold app-wide sign-off.** Ordinary room creation, chat, games and host handoff work in the tested environments. Two adjacent lifecycle paths do not. A passing protocol model or release gate is not evidence that either path works.

| Release finding | What the run actually observed | Required for sign-off |
|---|---|---|
| [#18: re-offer after decline](https://github.com/slee1996/pillowfort/issues/18) | The guest declined and both devices could still chat. An immediate second manual offer returned `invalid-lifecycle` to the **original host**; it lost its room. The guest could catch a subsequent disconnect-driven offer. This is not a successful voluntary handoff. All three engine pairs reproduced it. | A new offer can be accepted or declined without disconnecting the existing host or reusing an old consent. |
| [#19: new admission after succession](https://github.com/slee1996/pillowfort/issues/19) | The new host exported the invite and approved the exact request/fingerprint. The newcomer ended on the join screen with `connection-ended`, not as an active member. Meanwhile the members already in the room could exchange messages. | Demonstrate safe admission under current authority. Do **not** remove the invitation-authorized founder credential check merely to pass this case. |
| Mobile composer — **fixed on this branch** | On the release, the landscape transcript was 64.8 px high; the visual-keyboard layout also missed its 80-px minimum. On the fix, measured **83 px** at 812×375 and **90 px** with a 320-px visual viewport. The mention instructions remained in the Chromium accessibility tree. All 25 mobile tests passed. | Included the two regression cases in the release workflow. Not a physical-phone or assistive-technology certification. |
| Visual review — **open** | 28 strict baseline comparisons exceeded the 0.5% pixel threshold (0.770–99.981%). Functional runs of the desktop tours passed with comparison explicitly disabled. The landing comparison includes a real change in copy, footer and card height, not merely antialiasing. | Review baseline/actual pairs on the reference platform before accepting any new images. No baselines were changed. |
| Deployment and publishing — **partial** | Both production sitemaps and their advertised URLs parsed; all seven marketing URLs served HTML with matching canonical URLs. Deployed hosted MCP lists four guides; npm 2.1.1 lists three. The website returns 404 for `/agents/reference.md`. App and MCP telemetry-health probes also returned 404; the marketing probe succeeded. | Align documentation across release channels without republishing different bytes under 2.1.1. Restore successful producer probes **and fresh metric receipts**; separately verify alert delivery. |

## Evidence by surface

| Surface | Evidence | Boundary |
|---|---|---|
| Core and protocol | 583 release-gate tests, typecheck, build and catalog check passed; four pinned OpenMLS artifacts checked against 51 source inputs. Five suite-1 provider tests passed. | [Prior, separately pinned finite models and restart experiments](https://github.com/slee1996/pillowfort/tree/protocol-v4-cs1-evidence-2026-11-22-r8/paper). Neither is a proof of the whole application. |
| Human rooms | Nine user-visible milestones per pair: Chromium→Firefox, Firefox→WebKit, WebKit→Chromium. Fresh profiles, invitation, withheld earlier chat, styled mention, presence, transcript/local clear, same-device resume, voluntary catch, and terminal screens. 28 functional desktop tour cases (5 quad-view, 8 demo reel, 10 full tour, 5 game night). | Browser engines on one operating system; normal voluntary catch is distinct from #18. |
| Games under actual host loss | Six independent rooms used a CLI founder and SDK participants. Someone explicitly caught the offer; the survivors exchanged new chat and the successor closed the room. RPS, tic-tac-toe, King of the Hill, vote and Saboteur cancelled and could be restarted. A surviving member could still move its own local Breakout paddle. | No claim that a cancelled game resumes at the old turn. Saboteur restarted with four **already admitted** survivors, not by assuming a new admission succeeded. |
| Agents | Browser-native WebMCP registration and invocation, published npm CLI/SDK and stdio, and production hosted MCP. On both transports: subscribed → URI-only update → authenticated private mention read → exactly one reference-handler reply observed by the sender. Received a remote drawing and exported a PNG in the browser. Hosted Task cancellation and independent Task/subscription fan-out passed. | Native API explicitly enabled in Chromium; no polyfill. A running receiver is not an idle model or offline inbox. No harness-specific adapter was used. |
| Lifetime and access | Hosted Worker gate: 14 tests including OAuth, restart, isolation and teardown. In production one unused grant with a live participant was left idle for 125 s. Observation and recreation both returned 404, `identityRestorable:false`, and shared active leases returned to zero; grant revoked. Public discovery listed 61 tools; anonymous execution returned 401. | The 10-minute absolute limit is configured in production and exercised with a shorter local Worker clock; not a ten-minute live soak or a capacity benchmark. |
| Billing and integrations | The canonical app advertised configured $5 checkout; signed fixture-based fulfillment, redemption and revocation tests run in the release gate. `/activity` served the Discord-specific framing policy, separate from the standalone app. | No live charge, refund, or authenticated Discord launch. The available Stripe test profile did not resolve the documented test price; that is **not** evidence of a live payment outage. |
| Website, CMS, distribution | The npm archive matched npm integrity and the marketing mirror byte-for-byte; Registry title, website, icon and transport matched. The private marketing checkout passed 10 telemetry and 8 rendered-route tests. In local workerd/D1, a real editor logged in, created a draft hidden from another browser and the sitemap, published, removed it, signed out, and lost editor access. | No production editorial or billing writes. The private marketing checkout is separately pinned; its gate does not certify every file in the deployed Worker. |
| Dependencies | Product root, client and hosted npm lockfiles reported zero advisories; RustSec reported zero for the shipped Cargo lock, without suppressions. The separately maintained website was audited and patched in its own repository, not deployed by this sweep. | Point-in-time dependency databases, not a source audit, cryptographic review, or evidence that the website patch is live. |

See [machine-readable observations](results.json) for revisions, Worker version IDs, asset hashes, individual outcomes and the checks that intentionally exit nonzero. The full report is not a pass percentage: tests, user journeys and model states are different units.

## Acceptance plan

Scope: the released Pillowfort product, not a proof of every interleaving. Test the built assets with distinct participant profiles. A sender echo, a queued command, a mock browser API, or an HTTP 200 alone does not establish delivery. Keep disposable grants and invitations in memory; publish only non-secret outcomes. Do not inject faults into production, use another person's room, change operator settings, or make a live purchase.

| Surface | Acceptance criterion | Execution environment |
|---|---|---|
| Entry and membership | Create, privately invite, explicitly admit, reject an unwanted request, preserve a returning identity, withhold pre-admission history, retire for all members. | Browser UI in Chromium, Firefox and WebKit; Chromium phone-sized viewport; existing mobile/recovery suites. |
| Conversation and personal controls | Two-way styled chat, targeted mention, presence, mute, transcript download and local clear; verify the receiver, not just the sender. | Independent browser profiles, including different engines. |
| Shared activities | Remote drawing and PNG export, Breakout, RPS, tic-tac-toe, Saboteur, King of the Hill, vote, host handoff. Exercise active-game recovery, not just launching overlays. | Browser tour, mobile and independent participant workflows. |
| Agent participation | Browser-native discovery and invocation where implemented; npm CLI, SDK and stdio; hosted discovery, public guides, authorized calls, pending admission and private mention resource. | Real browser/DevTools and MCP clients, bounded self-owned sessions. No polyfill counted as native. |
| Events and identity | Subscribe before mentioning; receive a URI-only update, read private content, send one reply and observe it in the sender's room. Check cancellation, Task behavior, owner lifetime and teardown. | Supported MCP revision pinned at both ends. Distinguish a running reference client from a third-party product scheduling a model. |
| Paid access | Check advertised checkout availability, locally exercised fulfillment/claim/redemption/refund contracts, and provider test-mode readiness. | Production read-only status, signed test fixtures, provider sandbox only if verified and available. No live purchase or dispute. |
| Public and operational surfaces | Verify served app identity, discoverability, SEO XML, agent catalog, registry/package provenance, operator health and alerts. | Canonical production origins, exact npm release and read-only operator health endpoint. |
| Underlying guarantees | Run the released app and hosted gates, audits, and optional browser/visual suites. Retain the revision-pinned protocol model, restart and silent-loss results rather than relabeling them as new. | Clean locked build, local release gates and immutable prior evidence. |

Record each outcome as passed, failed, partial, or externally blocked and give the observation and its limits. No automatic baseline updates. A failed visual comparison and a failed interaction are different findings. A browser engine or mobile viewport does not establish physical handset, background suspension, screen-reader, payment-provider or idle AI-host behavior.

## Reproduce

Use Bun 1.4.4, a supported patched Node (run: 24.22.2), Playwright 1.65.0, and the project lockfiles. The product was checked out at [`5a321c35`](https://github.com/slee1996/pillowfort/tree/5a321c35b9b3866e6a9c3d86969ee8e31933e2d3). The only app runtime change in this verification branch is the CSS fix. The production JS SHA-256 equals the release-mode JS on the branch. The CSS differs. No app or hosted Worker was deployed by this sweep.

```sh
OUT=$(mktemp -d)
npm ci && npm --prefix client ci && npm --prefix hosted-mcp ci
npx playwright install --with-deps chromium firefox webkit
npm run check && npm --prefix hosted-mcp run check
npm run agent:pack
npm install --prefix "$OUT/npm" --ignore-scripts --no-audit --no-fund \
  https://registry.npmjs.org/@ontologic/pillowfort-agent/-/pillowfort-agent-2.1.1.tgz
PKG="$OUT/npm/node_modules/@ontologic/pillowfort-agent"
node "$PKG/scripts/agent.mjs" install-browser
bun test --timeout 60000 --max-concurrency 1 test/mobile.test.ts
# The existing browser-test helper inherits the test environment when building.
# Restore release-mode assets before running the independent consumers.
NODE_ENV=production npm run build
bun verification/app/browsers.ts "$OUT/browsers.json"
bun verification/app/phone.ts "$OUT/phone.json"
for game in ttt rps koth vote saboteur breakout; do
  node verification/app/game-handoff.ts "$game" "$OUT/$game.json" "$PKG" || exit 1
done
bun verification/app/agents.ts stdio "$OUT/stdio.json" "$PKG/scripts/agent.mjs"
# Open regressions. These should fail until the underlying issues are fixed.
bun verification/app/browsers.ts "$OUT/retoss.json" all retoss
node verification/app/game-handoff.ts fresh-admission "$OUT/fresh-admission.json" "$PKG"
```

**Visual checks:** run each of `quad-view`, `demo-reel`, `full-tour`, `game-night`, `design-snapshots` as `bun test --timeout 60000 --max-concurrency 1 test/NAME.test.ts`. Do not use a screenshot-update flag. For a separate interaction-only diagnosis of a tour, set `PILLOWFORT_COMPARE_SNAPSHOTS=0`. Do not convert that result into a visual pass.

**Public and hosted:** `python3 verification/app/public.py "$OUT/public.json"` is read-only and reports each check even if another fails. `bun verification/app/agents.ts hosted "$OUT/hosted.json"` uses the real production Worker and one disposable room/grant; `node verification/app/idle.mjs --production "$OUT/idle.json"` uses one lease for 125 seconds. Run these **sequentially**, only with authorization and spare public capacity. Neither needs an operator credential. Neither stores invites, tokens, fingerprints or room text in the report.

**Private website:** use an authorized copy of the separately maintained website; the tested source revision is recorded in `results.json`. Run `npm ci && npm run check`. From this product checkout run `node verification/app/cms.mjs /path/to/built/private-checkout "$OUT/cms.json"`. It migrates new, local-only D1 storage, generates an ephemeral local password and removes that database after the test. It never calls a live editor endpoint.

**Provider and dependency checks:** run `npm audit --package-lock-only` in the root, `client/`, and `hosted-mcp/`, and `cargo audit --file crypto/openmls-wasm/Cargo.lock`. For the provider tests, pin both `RUSTC="$(rustup which --toolchain 1.94.1 rustc)"` and `RUSTDOC="$(rustup which --toolchain 1.94.1 rustdoc)"` when invoking `rustup run 1.94.1 cargo test --locked --manifest-path crypto/openmls-wasm/Cargo.toml --test hpke_suite1`.

## Remaining acceptance work

1. Resolve #18 and #19 independently and run the failing journeys with the normal passing transfer as the control. Bring the fixes back to the protocol verification matrix before changing admission or handoff claims.
2. Review the 28 image comparisons; correct the UI or approve specific new baselines, not a blanket replacement. Exercise real iOS/Android keyboards, backgrounding, VoiceOver/TalkBack, and notification permission prompts on actual devices.
3. Restore operational signal coverage and confirm an alert reaches an authorized recipient. Green HTTP scrapes alone did not establish this.
4. Run an owner-authorized Stripe sandbox purchase → return in the same tab → redemption → refund, then apply the separate promotion gate before live payments. A configured status endpoint and local fixtures are not external fulfillment evidence.
5. For idle agent wakeup claims, connect an independently supported client, leave it idle, and measure whether a mention actually starts a turn. Discord-verified identity and unattended offline reachability are not properties of the tested release.
