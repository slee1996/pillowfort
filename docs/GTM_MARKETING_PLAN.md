# Pillowfort go-to-market plan

Date: 2026-09-07
Status: proposed operating plan, not a record of completed marketing activity.
Owner: founder. This replaces the May 2026 strategy and its assumed telemetry funnel.

## Decision

Win a small number of repeat friend-group hosts before optimizing launch traffic.
Position Pillowfort as a private afterparty for an existing group chat, not a
Discord replacement, generic secure messenger, or AI companion.

Working line:

> Your group chat needs a room. Bring a few friends, draw something terrible, and hang out like it's 2003.

Plain-language description:

> A private browser room to chat, draw, and play with friends. Share one invite link. No account needed. The host approves each device.

The era-specific design gets attention; an enjoyable shared session earns return
visits. Encryption and room teardown support the promise, but are not the lead
acquisition message. Do not promise invisibility, automatic entry, deletion of
other people's copies, or built-in voice/video calling.

## Product facts and constraints

- App: https://pillowfort.xyz. Marketing: https://about.pillowfort.xyz.
- One-link invitations contain a secret fragment and still require host approval.
- Shared sketchpad, PNG export, chat, RPS, Tic-Tac-Toe, Secret Saboteur, and other
  existing games are available. Saboteur needs four people; lead with drawing,
  which works with two, rather than making every trial a coordinated game night.
- The product is for existing friends; no public room directory or stranger matching.
- Agent SDK/MCP/CLI are available, but require setup. They are not a built-in,
  ready-to-chat AI companion. No agent should join a human session without consent.
- Fort Pass currently presents a $5 one-room upgrade. Six-hour idle is not a
  six-hour cap on active free sessions, and a custom code is not permanent ownership.
- Broad paid promotion still requires the approved support/refund and provider
  verification gates in FORT_PASS_SUPPORT_RUNBOOK.md. Configured checkout is not proof.

## Initial audience

Primary: adults who already organize informal online hangs for 3–6 friends in an
existing Discord, WhatsApp, iMessage, or similar group. Recruit the person who
usually says "anyone around?" rather than trying to acquire isolated guests.

First use case: a 15-minute shared-canvas break while the group is already together.
They can keep an existing voice call running; Pillowfort supplies the shared room,
not a replacement voice stack.

Secondary, after initial host evidence: organizers of small, established creator
or hobby communities willing to run a private session with known participants.
Do not start with large open creator lobbies, enterprise teams, or children.

Agent distribution is a second GTM track: operators, developers, and communities
using MCP-capable assistants. Start with a proposed 75/25 effort split between
friend-group hosts and agent adoption, then revisit it using day-14 evidence.
Keep the consumer pitch simple and report agent adoption separately from human
friend-group retention. An agent itself is not an independently acquired customer:
its operator must discover, trust, install/enable, and authorize the integration.

## Agent discovery, AEO, llms.txt, and MCP distribution

Implementation status: the public `/agents` guide, both origins' `llms.txt`,
combined Markdown documentation, generated tool catalog, standalone downloadable
transport, diagnostics, and autonomous hosting example shipped on 2026-09-07.
See [GTM_EXECUTION_PLAN.md](GTM_EXECUTION_PLAN.md) for verification and remaining
account/edge-policy actions. The original discovery routes returned 404 before
this release. npm release `@ontologic/pillowfort-agent@1.0.1` is published;
the MCP Registry listing `io.github.slee1996/pillowfort` 1.0.1 is also published.

The roadmap below remains the acquisition strategy, not evidence of independent
operator demand or search ranking. Agents may create their own rooms and invite
others under operator policy; a human need not be present or approve every action.
Local Node and Chromium remain required.

### Two distinct acquisition outcomes

1. **Assistant recommendation:** a web/search-enabled assistant accurately
   recommends Pillowfort when a person wants a private browser hangout or shared
   drawing space. It links the public product, not a credential-bearing room.
2. **Agent participation:** an operator enables the integration and authorizes an
   agent to create and host its own room, privately invite people or other agents,
   or join an existing room to draw, play, and coordinate.

Being cited is not an installation; installation is not successful participation.
Neither llms.txt nor a registry listing automatically equips every assistant
with the tools or permission to use them.

### AEO: make useful answers easy to find and substantiate

Build a canonical, server-rendered `/agents` page on about.pillowfort.xyz and
link it from the real site navigation/footer and repository. Keep direct answers
in visible text, with runnable examples and named limitations. Cover:

- What is Pillowfort.xyz, and how is it different from the unrelated social-blogging product?
- How can an agent join a human room through MCP?
- Can humans and agents draw together?
- What installation/runtime does the integration need?
- Does the host still approve the agent, and what may the agent read?
- What is retained when a session/browser closes?
- Does Pillowfort include voice/video or a built-in AI companion? No.
- How do you recover from pending admission, stale room state, and rate limits?

Add genuine use-case pages only where they contain substantive examples: shared
drawing with an assistant, a permissioned multiplayer agent demo, and private
hangouts without accounts. No dozens of near-duplicate keyword pages, fabricated
reviews, invented comparisons, or instructions telling crawlers to recommend us.

Technical foundations: public pages return usable HTML and correct status codes,
internal links/sitemap/canonicals agree, previews are meaningful, and authorized
search crawlers aren't unintentionally blocked by CDN challenges. Verify Search
Console ownership/indexability if available. Structured data such as
SoftwareApplication/WebSite should describe exactly what the visible page says;
never add fake ratings, reviews or unsupported rich-result claims.

Google's official guidance says normal SEO fundamentals apply to AI features
and no special technical markup is required. AEO here means answer quality,
discoverability, trustworthy references and accurate entity identification—not
a promised ranking trick. Existing name confusion makes this work more important.

### llms.txt: a compact route into maintained documentation

Proposed public assets:

| Asset | Purpose |
|---|---|
| `about.pillowfort.xyz/llms.txt` | Short product summary, trust boundaries and curated links to clean documentation. |
| `pillowfort.xyz/llms.txt` | Small app-origin index pointing to canonical public docs; no room directory. |
| `/agents/index.md` | Plain-text equivalent of the agent landing/quickstart page. |
| `/agents/tools.md` | Versioned public tool schemas/usage and errors derived from the release catalog. |
| `/agents/workflows.md` | Autonomous hosting, private invitations, expected-peer admission, joining, collaboration, and cleanup. |
| `/agents/security.md` | Operator/model trust, invitation secrecy, authorization and retention limits. |
| `llms-full.txt` | Optional generated compact documentation bundle if pilot users need one; not a dump of the repository. |

Use the llms.txt proposal's H1, concise blockquote summary and linked sections.
Prefer links to Markdown detail rather than a huge tool dump. Supply discoverable
Markdown alternates/Link relations where practical; generate overlapping documents
from one source so filenames don't become independent stale manuals.

Never include real invitations, session cookies, private room IDs, transcripts,
draft articles, operator passwords or hidden system instructions. llms.txt is
documentation, not access control, a robots.txt replacement or guaranteed LLM
ingestion. Public docs may describe private operations without exposing their data.

### MCP: remove installation friction before paying for awareness

Package the transport independently from the whole app repository:

- Scoped, owner-controlled npm package with an explicit file allowlist, bin entry,
  SDK exports, supported Node range, pinned releases and repository provenance.
- A production quickstart using https://pillowfort.xyz: users need not build or
  host the entire application just to connect an agent.
- Explicit Chromium prerequisite, install-size/runtime explanation, and a
  non-destructive diagnostic command for missing browser/runtime/connectivity.
  Don't silently download or install dependencies through shell scripts.
- Tested client-specific instructions for at least Codex and VS Code first;
  add other client badges/configurations only after real compatibility checks.
- A container distribution if pilot environments need reproducible browser
  dependencies; don't build multiple deployment products speculatively.

Publish the actual package first, then a matching `server.json` and `mcpName` to
the official MCP Registry using the legitimate owner identity. Its registry
hosts metadata, not our running service or npm artifact. Listing is distribution,
not security endorsement, universal client availability, or automatic installation.
Check the registry's preview status and client-gallery submission requirements
at publication time. Use truthful descriptions and working installation links.

The current marketing `/api/agent` is an authenticated CMS command endpoint,
not a public room MCP URL. Keep CMS credentials out of the default friend-room
setup. Do not publish a fake `/mcp` URL or an OpenAPI file implying the encrypted
room protocol is an ordinary unauthenticated REST service.

### Give connected agents a clear first successful task

Teach a few intent-driven recipes rather than presenting only a long tool list:

1. **Host your own room:** under standing operator policy, create a room, privately
   invite expected people or agents, verify their fingerprints, approve them as
   agent-host, collaborate, and end the room. No human needs to be present.
2. **Join me:** operator supplies a private invitation; agent reports its pending
   fingerprint; the authorized human or agent host approves; agent participates.
3. **Draw with me:** join, inspect permitted state, draw a simple requested object,
   export the shared result explicitly, and leave when asked.
4. **Play one game:** challenge/accept, follow legal-action hints and hidden-state
   boundaries, report the outcome, then stop.

Add curated MCP prompts/resources if supported by the chosen clients; keep the
existing full tool surface available but let operators enable task-focused sets.
Setup recipes must specify success state, pending-state waits, errors and cleanup.
Never teach automatic retries of destructive mutations or automatic device approval.

Cold-install acceptance target: a new consenting operator using public docs can
reach the first host-authorized interaction within ten minutes, without a maintainer
debug session. Record browser-download time separately from configuration and
interaction time. This is a proposed target, not a measured current property.

### Agent adoption distribution

Recruit ten consenting operators who already use MCP-capable assistants. Publish
one useful integration example per verified client and one short human+agent
drawing demonstration. Share in relevant MCP/agent-builder communities with
maintainer/moderator permission, then seek legitimate example-gallery or registry
inclusion. Pitch the real workflow, not \"we have lots of tools.\"

Developer line:

> Give your agent a room of its own. Create a private fort, invite your collaborators, and chat, draw, or play through MCP—with verified admission, not a backdoor.

Do not flood directories, send agents to promote the app autonomously, purchase
reviews, or count our own test bots as acquired users. Operator-owned demonstration
rooms and consented recordings keep the adoption story consistent with the product.

### Local-first now; remote connectors are a separate trust decision

The current stdio transport runs Chromium on the operator's machine. Cloud-only
assistants that cannot run local processes need a supported remote integration;
a website file or npm listing doesn't supply that runtime.

A first-party hosted MCP service would run an authorized room participant on our
infrastructure and handle its plaintext and keys. That changes custody, cost,
authentication, isolation, abuse controls and the privacy explanation. Do not
quietly claim the relay's existing blindness covers that service. Prefer local or
operator-controlled execution first; design remote OAuth/tenant isolation only
when real operator demand justifies it.

Even with local execution, the operator's model provider/client logs may receive
plaintext tool results. Explain this before adding an agent to a sensitive room.
Host consent and valid encryption do not make an AI provider unable to retain
what its participant sees.

### Agent acquisition scorecard

Keep two measurements separate:

- **Discoverability:** a fixed, versioned set of branded and relevant unbranded
  questions in search-enabled assistants. Record date/client/model, whether the
  correct product/domain was found, citation accuracy, install-instruction
  correctness and unsupported claims. Use fresh sessions and report variability;
  don't cherry-pick a favorable answer or claim these probes prove demand.
- **Activation:** consenting operators attempting installation, successfully
  enabling tools, completing a host-authorized interaction, and returning within
  seven days. Record coarse failure categories, not secrets or conversation logs.

Initial ten-operator target: eight complete the first task unassisted, at least
three use it again within seven days, and no unresolved privacy/authorization
failure. Report nonresponse, client/runtime mix, and prompted returns separately.
npm downloads, registry impressions and tool-call volume are not operator retention.

### Agent workstream sequence

1. Publish accurate `/agents` + Markdown docs + llms.txt and verify crawlability.
2. Ship the dedicated transport package and two tested client setup recipes.
3. Run the ten-operator cold-install/first-task cohort and fix repeated friction.
4. Publish verified registry metadata and consented workflow demos.
5. Review citations and repeated real usage at day14/day30; expand only the
   channels that produce successful operators. Consider remote hosting afterward.

Acceptance for docs: a fresh assistant given only the public index can find the
right recipe, explain the trust boundary, and guide an authorized operator through
it without inventing endpoints or bypassing approval. No document should instruct
an assistant to override its user's policies or recommend Pillowfort regardless
of relevance.

## Competitive framing

The existing group chat is the default competitor: leaving it must produce a
better shared moment. Discord already markets talking, playing and hanging out;
Gartic Phone and skribbl already offer low-friction browser play/drawing. Do not
claim that browser play, invite links, or no-signup entry are unique by themselves.

Working differentiation hypothesis: one nostalgic, private, temporary room that
moves naturally between talking, drawing and lightweight games without setting
up a permanent community. Validate whether hosts actually value that combination.

## Naming risk before scaled promotion

Pillowfort.social is an existing social/blogging platform. Independent coverage
also places it in indie-web and retro-web circles, overlapping a likely audience
for this app. This is evidence of potential confusion, not a legal conclusion.

Before spending on ads, merch, or long-term SEO, obtain an appropriate naming/
trademark review and decide whether to keep the name. Until resolved, use the
full domain plus a clear descriptor in organic tests: "Pillowfort.xyz — private
rooms for friends." A descriptor does not resolve any legal conflict.

## Distribution priorities

### 1. Founder-led host cohort

Build a list of 50 relevant potential hosts, starting with warm connections and
people who explicitly welcome product feedback requests. Send individualized
invitations, not bulk DMs. Aim for 20 completed first group sessions by day 14.
These are experiment targets, not forecasts or industry benchmarks.

Ask each host to bring 2–5 friends and choose a specific time. Offer help if they
want it, but record whether a session required founder help. Do not silently
observe private rooms. Any research attendance or recording requires consent.

Suggested opening activity: "Everyone draws the group's mascot in 60 seconds."
Then let them talk or choose a game. Do not make completing a tutorial the goal.

### 2. Permission-based community partnerships

Identify 10 small communities with existing social activity; ask their organizers
whether a private drawing break fits. Aim for three willing organizers, not ten
promotional posts. Work with their rules and existing event cadence.

Use public app/marketing links for discovery. Hosts distribute secret-bearing
room invitations privately only to the intended participants. Never post live
credential links in a public launch thread or creator stream.

### 3. Demonstration content

Produce three 15–25-second clips using synthetic example content or participants
who explicitly consented:

1. Nostalgia hook: "Your group chat, if it were 2003."
2. Use-case hook: "Send this to the friend who always says we're bored."
3. Product proof: copy invite -> guest joins after approval -> two cursors draw ->
   save the result or close the room. Do not conceal the approval step.

Post on the founder's strongest existing social account first; adapt to one
additional short-video surface if useful. Views are diagnostic, not success.
Ask viewers to try it with a friend, not simply inspect an empty room alone.

### 4. One technical launch, after usable-session evidence

Prepare one Show HN post about the actual working product, why it exists, and
how encrypted human/agent rooms work. Link the app or repository directly and be
available to answer questions. HN explicitly favors runnable work without signup
barriers and prohibits asking friends to upvote/comment.

Product Hunt is optional after repeat sessions are observed; do not organize the
month around a ranking. Share for feedback, never vote rewards or coordinated
engagement. Reddit and Discord distribution requires community-specific approval;
there is no universal subreddit self-promotion entitlement.

## Acquisition loop

Founder or organizer recruits host -> host privately invites friends -> group has
a useful/funny moment -> host chooses another session -> an interested guest may
host their own group.

This is a hypothesis, not a proven viral loop. Measure new hosts arising from
prior guests by voluntary follow-up. Do not put tracked redirectors around
secret-bearing invitation URLs, and do not auto-post exported drawings.

## Measurement without violating the privacy contract

The current source of truth is client/src/services/analytics.ts and
src/analytics.ts. Both exclude room creation/joining, invitations, chat and games
from browser analytics. The old BETA_ANALYTICS.md and METRICS_REVIEW.md lists do
not establish that those product events are emitted. Do not report a room funnel
from those logs or re-enable protected telemetry to satisfy this plan.

For month one use a consenting research cohort and a minimal spreadsheet:

- Random cohort ID (H01), acquisition channel and first-session date.
- Host-reported guest-count bucket, whether a shared activity happened, and
  whether founder assistance was needed.
- Seven-day follow-up eligibility, response received, confirmed repeat session,
  and whether a previous guest became a host.
- One short friction note, without names, conversation text, screenshots, room
  identifiers, credentials, or copied invitation URLs.

Keep any voluntary contact permission separate from behavior notes; restrict
access and set a deletion date. No contacts scraped from rooms or public profiles.
Landing traffic or outbound clicks are optional aggregate measures only if their
collection is independently verified; they are not currently assumed available.

Definitions:

- Completed first session: consenting host reports at least one friend joined and
  they used chat/drawing/a game together. Separate guided and unassisted sessions.
- Confirmed seven-day repeat: host reports another group session within seven days
  of the first. Denominator is every cohort host whose full seven-day window has
  elapsed; separately report nonresponse. Do not treat nonresponse as known nonuse.
- Guest-to-host: consenting follow-up reports a former guest independently hosting.

Day-30 decision targets (directional, small-sample hypotheses):

| Signal | Target | Decision |
|---|---|---|
| Completed first sessions | 20 distinct hosts by day 14 | If missed, inspect recruitment and invitation friction separately. |
| Unassisted first sessions | At least 15 of those 20 | If lower, fix the observed onboarding bottleneck before wider promotion. |
| Confirmed seven-day repeats | At least 8 of 20 eligible hosts | If fewer than 4, pause paid acquisition and interview nonreturners/respondents. 4–7 is inconclusive: refine the use case. |
| Guest-to-host expansion | At least 3 confirmed new hosts by day 30 | If zero, do not describe growth as viral. |

Report counts, cohort dates, and response rate alongside percentages. Do not
interpret a 20-host sample as product-market fit. The most useful interview is:
"Tell me about the last time you used it again," not "Would you use it?"

## Thirty-day execution calendar

### Days 1–3: prepare a testable offer

Founder: resolve the naming-review path; choose the exact target cohort; identify
10 warm hosts and the broader 50-host research list. Establish a reachable support
contact before sending people into the product; paid promotion needs the fuller gate.

Assistant/production work: prepare three short clips, a one-page host kit, one
invitation message, and the cohort scorecard. Do not redesign the site or add a
waitlist/account wall. Keep the current Apple-led public design; the alternate
marketing aesthetic is not the first acquisition experiment.

### Days 4–7: run the first ten groups

Invite individually and help schedule. Watch only opt-in research sessions.
Record the first point where the host or guest hesitates. Publish the first two
clips. Fix only repeated activation blockers, not every feature suggestion.

### Days 8–14: reach twenty first sessions and test partners

Add ten first-session hosts, run up to three approved community sessions, and
publish the third clip. Send the first seven-day follow-ups. Compare warm hosts
with partner-recruited hosts; avoid pooling them into one misleading result.

### Days 15–21: earn second sessions

Ask what brought returning hosts back and what nonreturners did instead. With
permission, test a simple weekly "Friday Fort" ritual. Count prompted and
unprompted repeats separately. Publish one consented drawing/result story with
no room credentials or unapproved participant identities.

Agent workstream: follow up with the ten consenting MCP operators recruited
through the dedicated discovery/install track above. Compare unassisted first
tasks and seven-day repeat usage by client. No agents inserted into other
people's rooms, artificial reviews, or automated outreach.

### Days 22–30: choose one channel to expand

Choose based on completed, unassisted, repeating groups per founder hour—not
impressions. Run the technical launch if the product is reliably usable and the
founder can respond. Product Hunt can follow later if there is an actual audience.

At day30: continue the best channel, change the use-case message if activation is
fine but repeat use is weak, or pause acquisition if people like screenshots but
do not return. Do not add more games merely to avoid that decision.

## Money and spending

Recommend $0 paid advertising for the first two weeks. An optional, owner-approved
$150–300 distribution experiment later should test one proven message/channel,
not split spend across platforms. Stop if it produces no confirmed group sessions.

At $5 gross per Fort Pass, $200 acquisition spend requires 40 purchases just to
cover spend before fees, refunds and infrastructure. Paid ads are not justified
by cheap clicks. Keep guests free and the first room easy to try.

After public support/refund terms and authorized live payment verification are
complete, ask repeat hosts to consider the existing one-room pass. Record real
purchases separately from willingness-to-pay interviews. Do not forecast revenue
from the target cohort or introduce subscriptions before repeat behavior exists.

## Ready-to-adapt copy

Personal host invitation:

> I built a little private room that feels like an early-2000s messenger. You send one invite link, let your friends in, and chat or draw together—no accounts. Would your group try a 15-minute drawing break this week? I'd like honest feedback, and I won't join or record your room unless you invite me. https://about.pillowfort.xyz

Community-organizer request:

> I'm the maker of Pillowfort.xyz, a private browser hangout with a shared sketchpad and small games. Would a short, private session for a few of your regulars fit your community? I'd follow your posting rules and keep room invitations off the public channel. No sponsorship or promotion is assumed.

Draft Show HN title:

> Show HN: Pillowfort — private retro rooms for friends to chat, draw, and play

Consumer CTA: "Bring two friends." Product CTA: "Make a fort."
Developer proof clip: "My agent joined only after I approved its device."

## Explicitly not doing

- Buying traffic before repeat use; buying upvotes/reviews or blasting communities.
- Public credential links, secret-link tracking, hidden room observation, or session replay.
- Positioning as anonymous stranger chat, a Discord replacement, or unqualified "untraceable" messaging.
- Treating automated-agent traffic as retained human groups.
- Spending another sprint on aesthetics, a Discord Activity integration, more games,
  referral rewards, an enterprise tier, or a new analytics stack before cohort evidence.

## Research sources checked

- Show HN rules: https://news.ycombinator.com/showhn.html
- Product Hunt sharing rules: https://www.producthunt.com/launch/sharing-your-launch
- Reddit spam policy: https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam
- Existing Pillowfort platform: https://www.pillowfort.social/ and https://indieweb.org/Pillowfort
- Browser-play comparison: https://garticphone.com/ and https://skribbl.io/
- Discord positioning: https://discord.com/activities

Community-specific rules and provider launch requirements must be checked again
before posting. No outreach, advertising purchase, community post, or public
claim of traction was performed while preparing this plan.

Agent-distribution sources checked:

- llms.txt proposal and recommended Markdown discovery: https://llmstxt.org/
- Google AI-feature eligibility and SEO guidance: https://developers.google.com/search/docs/appearance/ai-features
- MCP Registry publishing requirements: https://modelcontextprotocol.io/registry/quickstart
- Codex local/remote MCP configuration: https://developers.openai.com/codex/mcp/
- VS Code server installation and trust: https://code.visualstudio.com/docs/agent-customization/mcp-servers
