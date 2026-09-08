# Pilot scorecard and founder handling rules

## Scope and hypotheses — not traction

Two separate cohorts: **ten consenting agent operators** and **ten consenting friend-group hosts**. One person occupies one slot in one cohort; friends, sessions, agents, retries, downloads, and founder/test bots are not additional participants. This is a ten-host pilot slice of the broader marketing plan, not a claim of twenty completed friend-group sessions.

For each cohort, the proposed decision targets are **8/10 completing the first task unassisted** and **3/10 confirmed seven-day returns**, with **no unresolved privacy/authorization concern**. These are hypotheses, not observed results. No rows have been populated. Reaching a target in a small warm-network sample does not establish market demand.

## Select and invite the first five people

Founder selects five existing connections who welcome a personal product-feedback request: two operators already using MCP-capable clients, two people who already organize small friend hangouts, and a fifth whose genuine fit adds a different client/runtime or friend-group context. If those people aren't available, choose fewer; do not manufacture a list or cold-message strangers to fill it. Avoid coercive relationships and asking someone to introduce an agent into a sensitive room. Select for fit, not a promised positive review.

Keep names, contact information, consent evidence, contact preferences, and the code mapping in a separate founder-only private contact list—not this repo, a shared spreadsheet, analytics, or OTel. Record only what is needed to invite, schedule, follow up, and honor withdrawal. Send the [appropriate invitation and consent block](invitations.md) individually; personalize the reason for asking. No bulk DMs, scraping, address-book import, automated agent outreach, or reminder to nonresponders. Do not enroll a person until they explicitly consent. A decline/no reply is not a failed participant or a scorecard row. Continue personally toward ten consented slots per cohort only after reviewing the first attempts and resolving safety concerns. No messages have been sent by preparing these materials.

## Files and record handling

- `agent-operators.csv`: header-only template for ten operator slots.
- `friend-group-hosts.csv`: header-only template for ten host slots.
- Copy templates to an access-restricted founder workspace before use. **Never commit populated scorecards.** Assign random opaque codes (for example, a random six-character alphanumeric value), not initials, handles, client IDs, or contact-derived hashes. No fabricated example rows.
- Use UTF-8 CSV, the headers as provided, ISO dates `YYYY-MM-DD`, and the enums below. Blank dates mean not yet known/not applicable; unknown categorical values must be explicit. No free-text column and no additional private fields. A reported friction category is sufficient; do not ask for raw debug output.
- Absolutely no names/contacts, room IDs/links/secrets, operator keys, OAuth tokens, session IDs, fingerprints, participant messages/artwork, tool arguments/results, or screenshots in these records or telemetry. Do not correlate pilot codes with operational traces or private room activity. Hosted safety/capacity telemetry is not evidence of activation or return.

## Denominators and completion

Freeze each cohort at its first ten consenting enrolled people; do not replace a blocked, assisted, absent, nonresponding, or withdrawn participant to improve results. Before full enrollment report `confirmed / enrolled so far (N of 10 planned)`; never silently use ten as an observed sample size. After full enrollment the primary denominator is the original **N = 10**, including not-started, incomplete, unknown, assisted, and withdrawn slots. Keep only an anonymous enrollment and withdrawal count outside the rows when withdrawal requires row deletion; never retain a code tombstone. Withdrawn outcomes are removed, not classified as failures.

**First task:** initial cold-onboarding attempt through room creation, private invitation, exact fingerprint verification/admission, two-way drawing receipt, and verified cleanup. The human variant is the same host workflow using the UI with existing friends. All five step outcomes must be `confirmed` for `completed`. Creating a room, enabling tools, or queuing an action alone is not completion. A later successful retry does not rewrite the initial attempt; capture later use only under the return rules. Count no second row.

**Unassisted numerator U:** initial status `completed`, assistance `unassisted`, clean start `yes`, all five step outcomes `confirmed`, and no unresolved safety concern. Public instructions, standard key issuance, usual client permission prompts, a friend joining, and an operator's authorized fingerprint reply are normal participation, not assistance. Founder/custom troubleshooting, private patches, hand-built configuration, or changing routes after a block makes the attempt `assisted`; unknown assistance cannot count as unassisted. A preconfigured run cannot count as cold-onboarding success. Report assisted completions separately as `A/N`, not hidden inside U.

Publish `U/N confirmed unassisted` and `R/N confirmed seven-day returns`, with counts for incomplete/blocked/abandoned, not-started, unknown, withdrawn, and pending windows. These are conservative confirmed-outcome fractions, not proof that every other person failed or did not return. Never shrink the primary denominator to completers, respondents, or matured windows. A supplementary matured-window fraction is allowed only with its explicitly named denominator. Do not combine the two cohorts into one retention claim.

## Seven-day return clock

Set **t0 to the start of the participant's first onboarding attempt**, before install/configuration. Store exact t0 and `t0 + 168 hours` only in the separate restricted scheduling record; CSV dates are coarse scheduling labels, not the timing calculation. The return window is `(t0, t0 + 168 hours]`, includes the exact endpoint, and closes before the follow-up is sent. Do not substitute calendar-day midnight or follow-up reply time. If the exact boundary cannot be established, use `unknown`; do not infer a return from telemetry.

A return requires a **separate later session after completing the initial collaboration**, with the same operator/host choosing to use Pillowfort again for a shared drawing, conversation, or game with an intended collaborator. Reopening setup, a retry to achieve the first collaboration, a founder-operated demonstration, or continuing the first session is not a return. A participant whose initial attempt did not complete may later return after a later first collaboration, but the first successful collaboration itself never counts as a return. The original t0 does not reset.

`R` counts participant-confirmed qualifying returns within that 168-hour window. Self-report is sufficient; no room evidence is requested. Record timing and whether founder prompting contributed separately. Report spontaneous and prompted return counts alongside total R; unknown prompting is not spontaneous. A referral ask or the follow-up cannot retroactively make a late use an in-window return. Follow up once just after the window closes; do not send an in-window usage reminder by default. If a reminder is requested, mark any attributable return prompted. No response is `unknown`, never `no`.

Not-started people have `return_window_status=not_started`; elapsed windows are `closed`, ongoing windows `pending`. Pending/no-return-yet is not `no`: use `not_yet_known`. Even with a confirmed early return, the window remains `pending` until 168 hours have passed. For attempts that never yield an initial collaboration, use `no` only after an explicit answer at window close; otherwise `unknown`. Late replies can establish an in-window return only when the reported timing is known.

## CSV dictionary

All fields are categorical unless identified as a date/code. Use one enum exactly; no lists or prose.

| Field | Allowed values / rule |
| --- | --- |
| `participant_code` | Random opaque unique code; private mapping stored separately. |
| `consent_date`, `enrollment_date` | Dates; enrollment requires explicit consent. |
| `baseline_route` (operators only) | `hosted_direct`, `hosted_oauth`, `local_mcp`, `unknown`; retain the originally chosen route. Native experimentation is outside this cohort. |
| `client_family` (operators only) | `codex`, `vscode`, `other`, `unknown`; no account/model identifiers. |
| `runtime_family` (operators only) | `hosted`, `macos`, `windows`, `linux`, `other`, `unknown`; runtime executing the participant, not necessarily the operator's laptop. |
| `clean_start` | `yes`, `no`, `unknown`; no existing room/session, prepared setup, or private instructions. |
| `first_attempt_date` | Date of t0; blank until started. |
| `first_attempt_status` | `not_started`, `in_progress`, `completed`, `incomplete`, `blocked`, `abandoned`, `unknown`. `incomplete` means reported attempt ended before all steps; `blocked` means a known obstacle stopped it; `abandoned` means participant chose to stop; silence is `unknown`, not abandoned. |
| `first_attempt_assistance` | `unassisted`, `assisted`, `unknown`, `not_started`. |
| `completion_time_bucket` | `le_10m`, `over_10m_to_15m`, `over_15m_to_30m`, `gt_30m`, `not_completed`, `unknown`; t0 to verified cleanup, excluding browser download time only. Time for friends to join remains included. |
| `browser_download_time_bucket` (operators only) | `not_required`, `le_5m`, `over_5m_to_15m`, `gt_15m`, `incomplete`, `unknown`; report separately, never pretend a cold download was instantaneous. |
| `create_outcome`, `invite_outcome`, `admission_outcome`, `drawing_outcome`, `cleanup_outcome` | Each: `confirmed`, `failed`, `not_reached`, `unknown`. A claimed queued action is unknown until observed; cleanup requires observed closure/leave and transport/session cleanup. |
| `primary_friction` | `none`, `discovery`, `install_runtime`, `client_setup`, `authentication`, `capacity_expiry`, `invitation_delivery`, `fingerprint_admission`, `drawing`, `cleanup`, `scheduling`, `other`, `unknown`. One first blocking or primary reported category; no raw errors. |
| `safety_status` | `no_concern_reported`, `concern_unresolved`, `concern_resolved`, `unknown`; no identifying incident detail here. Stop recruitment for an unresolved privacy/authorization concern. |
| `return_window_status` | `not_started`, `pending`, `closed`, `unknown`. |
| `return_outcome` | `yes_within_7d`, `only_after_7d`, `no`, `not_yet_known`, `unknown`. `no` requires explicit report after closure; nonresponse is unknown. |
| `return_timing` | `within_24h`, `over_24h_to_72h`, `over_72h_to_168h`, `after_168h`, `not_applicable`, `unknown`; time from t0 to the first qualifying return. |
| `return_prompt` | `spontaneous`, `founder_prompted`, `unknown`, `not_applicable`; spontaneous means no founder reminder prompted that use, not that friends never suggested it. |
| `followup_status` | `not_due`, `not_sent`, `sent`, `replied`, `declined`, `unknown`; no second reminder by default. |
| `followup_due_date` | Date containing `t0 + 168 hours`; exact send time comes from private scheduling record. Blank if not started. |
| `delete_due_date` | Thirty days after follow-up due date, or thirty days after enrollment if never started. Set at enrollment; update once t0 is established. Withdrawal accelerates deletion to within seven days. |

## Retention, withdrawal, and reporting

Only the founder accesses identifiable pilot records. Keep the contact/consent/scheduling list separate from code-only scorecards, both access-restricted. No room inspection, recording, screenshots, quotes, or publishing participant work is covered by pilot consent. Get separate, specific permission before any such activity; do not bundle it into this pilot. Friends are not consented research subjects just because their host joined.

On “withdraw,” stop all follow-up immediately; delete the row, code mapping, consent evidence, and pilot-only contact/scheduling notes within seven days, including controlled copies/exports. Recompute unpublished outcome totals without that row; retain only anonymous enrolled/withdrawn counts so missing slots are transparent. Revoke a withdrawn participant's pilot key through the separate authorized credential-management process; do not copy key material or key identifiers here. Published genuinely anonymous totals cannot identify or isolate a person and may remain; explain this limitation before consent.

For everyone else, delete individual pilot records thirty days after the follow-up was due regardless of response. Never-started enrollments expire thirty days after enrollment, with no follow-up required. The founder checks deletion dates weekly and removes any controlled exports/backups on the same schedule; use storage that supports this rule, not indefinite backups. Retain only aggregate cohort counts, coarse friction totals, route mix, and target comparison after deletion; suppress small cross-tabulations that could identify someone. No participant-code history remains. Broader provider/client retention and existing personal correspondence are outside this pilot; do not promise their erasure.

## Founder inputs needed before sending

Choose the first people, private contact/consent storage with enforceable deletion, approved invitation/key channel, available pilot-key capacity/expiry, and actual session times. The founder issues/revokes keys privately and sends invitations/follow-up personally. Complete no CSV rows until real consent and outcomes exist; report neither these templates nor internal synthetic demos as acquired users or returns.
