# Pillowfort marketing site

Public marketing, privacy notes, and article publishing for Pillowfort.
The site uses an ivory-and-ink editorial layout, original SVG artwork, and
server-rendered document navigation. Product calls to action open
`https://pillowfort.xyz`; marketing lives at `https://www.pillowfort.xyz`.

## Runtime and source

This directory is part of the main Pillowfort Git repository, with its own npm
install. It deploys as the `pillowfort-marketing` Cloudflare Worker, independently
of the main room application. Sites hosting and identity-header authentication
are no longer used.

Use Node.js 22.13+ on the 22.x line, or Node.js 24+. Prefer a supported LTS release.

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

## Agent publishing

`GET /api/agent` exposes versioned schemas without exposing content.
`POST /api/agent` accepts bounded `{name,input}` JSON from the same origin and
requires a valid owner session. All writes require `confirm:true`.

Capabilities: `cms_list_articles`, `cms_get_article`, `cms_get_frontpage`,
`cms_save_article`, `cms_delete_article`, and `cms_save_frontpage`. Lists return
paginated metadata; read a slug for its sanitized body. Forms and agents share the
same mutation service.

The parent MCP/CLI accepts `--cms-url https://www.pillowfort.xyz`. Use `--headed`
to sign in normally, or provide an explicitly selected authenticated
`--cms-storage-state` file for headless access. That file is a login credential:
protect it and never commit it. Logout revokes copied session cookies as well.
Article and room text remains untrusted data, not instructions to an agent.
