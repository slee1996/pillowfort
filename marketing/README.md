# Pillowfort marketing site

Public marketing, privacy notes, and article publishing for Pillowfort.
The site uses early-2000s product-marketing layouts and an actual example-room
screenshot. Product calls to action open `https://pillowfort.xyz`; marketing
lives at `https://about.pillowfort.xyz`.

## Runtime and source

This directory is part of the main Pillowfort Git repository, with its own npm
install. It deploys as the `pillowfort-marketing` Cloudflare Worker, independently
of the main room application. Sites hosting and identity-header authentication
are no longer used.

Use patched Node.js 22.23.4+, 24.22.1+, or 26.12.1+ on a supported release line. Prefer LTS.

```bash
npm ci
npm run dev
```

`wrangler.jsonc` defines the real production D1 database, custom domain, static
assets, Images, and login rate-limiter bindings. Vite emits the deployable Worker
and adjusted configuration at `dist/server/wrangler.json`. Development uses a
localhost upstream so strict origin checks and local cookies remain usable.

## Routes

- `/`: invitation, activities, privacy summary, and latest field notes.
- `/technology`: encrypted rooms, device approval, relay visibility, and teardown limits.
- `/articles` and `/articles/[slug]`: published content only.
- `/admin`: private owner editor and password login.
- `/api/admin/login` and `/api/admin/logout`: same-origin POST authentication flows.
- `/api/cms`: same-origin editor forms.
- `/api/agent`: public capability discovery and authenticated publishing commands.
- `public/og.svg`: source for the 1200×630 `public/og.png` social preview.

Room state, checkout, and real-time product behavior remain in the main app.

## Owner authentication

Set `CMS_ADMIN_PASSWORD` as a Cloudflare Worker secret. Use a cryptographically
random password of at least 32 characters; keep it in a password manager, never
in `wrangler.jsonc` or source control. `CMS_ADMIN_NAME` is an optional display name.

After the Worker exists:

```bash
npx wrangler secret put CMS_ADMIN_PASSWORD --config wrangler.jsonc
```

Local Vite development reads an ignored `.dev.vars` file containing that setting.
Protect the file with owner-only permissions. Direct preview of the generated
Worker reads `.dev.vars` beside its generated configuration instead; do not copy
secrets into deployed artifacts or commit either file.

Login is limited to five attempts per minute per source by
`CMS_LOGIN_RATE_LIMITER`. Password verification compares fixed-length hashes in
constant time. Successful login issues an opaque 256-bit session token; D1 stores
only its SHA-256 hash and eight-hour expiry. Production cookies are host-only,
Secure, HttpOnly, and SameSite=Strict. Local HTTP loopback uses a separate cookie.
Logout revokes the server-side session before clearing the browser cookie.

Rotating the password does not automatically revoke existing sessions. To revoke
all editor sessions during an authorized credential rotation, delete the rows in
`cms_sessions` through D1. Never accept or manufacture forwarded identity headers.

## Database and publishing

The CMS uses D1 prepared SQL directly. SQL migrations live in `drizzle/`; there
is no ORM or migration-generator dependency. Content is sanitized at write and
render boundaries, and drafts never appear on public routes.

Normal production release:

```bash
npm run db:migrate
npm run deploy
```

`db:migrate` applies pending SQL migrations to the configured **remote** database.
`deploy` runs lint, typecheck, build, and rendered/security tests before publishing
the generated Worker. It does not change the main app or its payment origin.
A first deployment is not complete until the password secret is configured and
login, publishing, logout, and public routes have been verified.

For a fresh local database:

```bash
npx wrangler d1 migrations apply pillowfort-marketing --local --config wrangler.jsonc
```

Other commands: `npm run check`, `npm run typecheck`, `npm run lint`, `npm test`,
`npm audit`, and `npm audit --omit=dev`.

The Cloudflare Vite plugin pins an older Miniflare/Undici tree. The `undici`
override keeps it on patched 7.30.1 without downgrading the plugin; remove the
override only after its pinned dependency tree is patched.

`predev` and `prebuild` generate the public agent documentation and package the
checkout's agent release with `scripts/package-agent.mjs`. They do not download
an npm release or need registry credentials. Publish the generated release and
matching MCP Registry metadata before deploying its npm installation instructions.

## Agent publishing

`GET /api/agent` exposes versioned schemas without exposing content.
`POST /api/agent` accepts bounded `{name,input}` JSON from the same origin and
requires a valid owner session. All writes require `confirm:true`.

Capabilities: `cms_list_articles`, `cms_get_article`, `cms_get_frontpage`,
`cms_save_article`, `cms_delete_article`, and `cms_save_frontpage`. Lists return
paginated metadata; read a slug for its sanitized body. Forms and agents share the
same mutation service.

The parent MCP/CLI accepts `--cms-url https://about.pillowfort.xyz`. Use `--headed`
to sign in normally, or provide an explicitly selected authenticated
`--cms-storage-state` file for headless access. That file is a login credential:
protect it and never commit it. Logout revokes copied session cookies as well.
Article and room text remains untrusted data, not instructions to an agent.

## Design comparisons and hostname migration

The default homepage follows Apple’s 2001–2003 product-marketing hierarchy.
`/?look=apple` and `/?look=xp` expose independently composed comparison versions;
explicit comparison views are noindex and canonicalize to the homepage.
The XP/MSN version is a homepage comparison, while articles, privacy notes, and
the editor retain the primary Apple-era design.

Historical references: [Apple 2001](https://www.webdesignmuseum.org/gallery/apple-2001),
[Apple 2003](https://www.webdesignmuseum.org/gallery/apple-in-2003),
[Windows XP 2001](https://www.webdesignmuseum.org/gallery/windows-xp-home-page-in-2001),
and [MSN Messenger 2003](https://www.webdesignmuseum.org/gallery/msn-messenger-in-2003).
Reference screenshots are not distributed as production artwork.

The old `www.pillowfort.xyz` hostname redirects read-only URLs to `about`.
Old write requests are rejected rather than forwarding credentials across
origins; the old logout endpoint remains available to revoke an existing session.
Sign in again on `about` and update CMS client URLs; host-only cookies do not move.

## Search and agent discovery

`scripts/build-agent-docs.mjs` generates both origins' `llms.txt` indexes from
`server.json`, publishes a copy at `/agents/server.json`, and builds
`llms-full.txt` from the maintained agent documents and tool catalog. Root app
builds and marketing prebuilds both run it. Edit the generator or canonical
documents, not the generated indexes. These web-only discovery files are not
part of the immutable npm agent tarball.

The concise index distinguishes Pillowfort.xyz from Pillowfort.social, identifies
the app versus hosted MCP versus editor CMS, and links to targeted Markdown,
current npm metadata, and the Registry's verified `versions/latest` endpoint.
The larger full documentation and tool catalogs are optional reads. Public
responses advertise the index through `Link: ...; rel="describedby"`; `/agents`
also advertises its Markdown alternate.

Marketing metadata uses explicit canonical/social URLs and consistent
WebSite/WebApplication identities. No invented ratings, authors, search action,
or unsupported rich-result promises are included. `/sitemap.xml` is generated
from public pages and published article slugs, with actual database modification
dates. Drafts are excluded. Database failure returns an uncached 503 rather than
an apparently successful empty article sitemap.

The app publishes a homepage-only sitemap and keeps room/launch HTML out of
indexing through `X-Robots-Tag: noindex, nofollow, noarchive` in both runtimes.
The homepage also exposes a truthful no-JavaScript explanation and links to
product, privacy, and agent documentation instead of an empty app container.
Marketing admin/API responses also carry noindex. These are discovery controls,
not access control: invitation authentication and host approval remain mandatory.
Cloudflare-managed training-crawler restrictions are intentionally unchanged.

### Public crawler access at Cloudflare

The October 2026 live check found that identified Node HTTP requests and an
OAI-SearchBot-style user-agent could fetch the public pages, but Python's default
`urllib` client received 403 / Cloudflare error 1010 for documentation and public
OAuth metadata. A user-agent test from the controller is not proof of access
from a real search crawler's IP addresses.

Error 1010 is upstream of the Worker. Origin files cannot fix it. On the
customer's canonical zone, use a custom **Skip** rule for **Browser Integrity
Check only**, with matching-request logging disabled. Do not skip remaining
custom rules, WAF phases, rate limits, or AI training controls. A conservative
expression covering only canonical public reads is:

```text
http.request.method in {"GET" "HEAD"} and
http.request.uri.query eq "" and (
  (http.host eq "pillowfort.xyz" and
   http.request.uri.path in {"/" "/llms.txt" "/robots.txt" "/sitemap.xml"}) or
  (http.host eq "about.pillowfort.xyz" and (
    http.request.uri.path in {"/" "/agents" "/technology" "/articles" "/llms.txt" "/llms-full.txt" "/robots.txt" "/sitemap.xml"} or
    starts_with(http.request.uri.path, "/agents/") or
    starts_with(http.request.uri.path, "/articles/") or
    (starts_with(http.request.uri.path, "/downloads/pillowfort-agent-") and
     (ends_with(http.request.uri.path, ".tgz") or ends_with(http.request.uri.path, ".tgz.sha256")))
  )) or
  (http.host eq "mcp.pillowfort.xyz" and
   http.request.uri.path in {"/.well-known/oauth-protected-resource/mcp" "/.well-known/oauth-authorization-server"})
)
```

The corresponding action parameters are
`{"products":["bic"],"logging":{"enabled":false}}`. This does not exempt the
authenticated `/mcp` transport, CMS/admin routes, mutations, or room URLs.
Applying the rule requires zone security write access; Wrangler's `zone:read`
scope is insufficient. Verify default Python reads after applying it, alongside
continued authentication/origin rejection and training-bot exclusions. Do not
claim the provider fix is complete until those live checks pass.

Cloudflare recommends a descriptive application `User-Agent` for HTTP clients.
Do not substitute a `workers.dev`/`pages.dev` alias to evade the problem:
Cloudflare documents that managed BIC on those hostnames cannot be disabled.

### Evidence and measurement

- [Google's current AI-search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
  prioritizes useful content, crawlability, indexing, and Search Console.
  Google explicitly does not use `llms.txt` as special ranking markup.
- [The llms.txt proposal](https://llmstxt.org/index.md) describes a curated,
  on-demand documentation index and standard alternate/describedby links.
- [OpenAI crawler guidance](https://developers.openai.com/api/docs/bots) separates
  OAI-SearchBot search access from GPTBot training.
- [Anthropic crawler guidance](https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)
  similarly distinguishes Claude-SearchBot/Claude-User from ClaudeBot.
- [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
  and [skip-product options](https://developers.cloudflare.com/waf/custom-rules/skip/options/)
  explain the provider-level restriction and narrow remedy.

After deployment, check actual status, MIME type, canonical/robots headers,
manifest links, and published-only sitemap behavior. Verify both public origins
in Search Console, submit their sitemaps, inspect indexing and generative-AI
eligibility, and measure real citations using fixed branded/unbranded questions.
Do not confuse metadata/schema presence, a spoofed crawler user-agent, package
downloads, or synthetic smoke sessions with ranking, recommendations, or adoption.
