import { DurableObject } from 'cloudflare:workers';
import { AuthorizationError, CimdFetchError, OAuthProvider, OAuthError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import type { AuthenticatedProps, Env } from './env';
import { readByteLimitedText } from '../../src/requestBody';

const SCOPE = 'mcp:rooms';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATOR_KEY = /^pfm_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const COOKIE = '__Host-pillowfort-consent';
const encoder = new TextEncoder();
const policies = {
  api: { window: 60_000, perAddress: 120, global: 1000 },
  consent: { window: 600_000, perAddress: 30, global: 150 },
  registration: { window: 3_600_000, perAddress: 5, global: 100 },
  token: { window: 60_000, perAddress: 30, global: 300 },
  admin: { window: 3_600_000, perAddress: 30, global: 100 },
  adminFailure: { window: 3_600_000, perAddress: 30, global: 100 },
  issuance: { window: 86_400_000, perAddress: 20, global: 20 },
  initialization: { window: 86_400_000, perAddress: 100, global: 500 },
} as const;
type RateKind = keyof typeof policies;
type KeyRecord = { id: string; hash: string; label: string; createdAt: number; expiresAt: number; revokedAt: number | null };

class InvalidRequest extends Error {}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidRequest('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
function signingKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Authentication secret unavailable');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function mac(key: CryptoKey, value: string): Promise<string> {
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function matches(key: CryptoKey, signature: string, value: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', key, decode64(signature), encoder.encode(value));
  } catch {
    return false;
  }
}

/** Strongly consistent credential, nonce, and abuse bookkeeping; never stores raw credentials. */
export class AccessKeyStore extends DurableObject<Env> {
  private readonly key: Promise<CryptoKey>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.key = signingKey(env.CONSENT_SECRET);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS operator_keys (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT NOT NULL,
      createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_rates (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS consent_nonces (hash TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);`);
  }

  async issue(label: string, expiresInDays: number): Promise<{ id: string; key: string; label: string; expiresAt: number }> {
    if (!validLabel(label) || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) throw new Error('Invalid key metadata');
    const id = crypto.randomUUID();
    const key = `pfm_${id}.${randomSecret()}`;
    const now = Date.now();
    const expiresAt = now + expiresInDays * 86_400_000;
    const hash = await mac(await this.key, `operator:${key}`);
    this.ctx.storage.sql.exec('INSERT INTO operator_keys (id, hash, label, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)', id, hash, label, now, expiresAt);
    return { id, key, label, expiresAt };
  }

  async validate(token: string): Promise<string | null> {
    const parsed = OPERATOR_KEY.exec(token);
    if (!parsed || !UUID.test(parsed[1])) return null;
    const row = this.ctx.storage.sql.exec<KeyRecord>('SELECT * FROM operator_keys WHERE id = ?', parsed[1]).toArray()[0];
    if (!row || row.revokedAt !== null || row.expiresAt <= Date.now()) return null;
    const valid = await matches(await this.key, row.hash, `operator:${token}`);
    // Re-read after crypto awaits so a concurrent revocation always wins before return.
    return valid && this.active(row.id) ? row.id : null;
  }

  active(id: string): boolean {
    if (typeof id !== 'string' || !UUID.test(id)) return false;
    return this.ctx.storage.sql.exec('SELECT id FROM operator_keys WHERE id = ? AND revokedAt IS NULL AND expiresAt > ?', id, Date.now()).toArray().length === 1;
  }

  revoke(id: string): void {
    if (!UUID.test(id)) return;
    this.ctx.storage.sql.exec('UPDATE operator_keys SET revokedAt = COALESCE(revokedAt, ?) WHERE id = ?', Date.now(), id);
  }

  async allow(kind: RateKind, address: string): Promise<boolean> {
    const policy = policies[kind];
    if (!policy) return false;
    const addressHash = await mac(await this.key, `address:${address.slice(0, 128)}`);
    const now = Date.now();
    const window = Math.floor(now / policy.window);
    const expiresAt = (window + 1) * policy.window;
    const globalId = `${kind}:${window}:global`;
    const addressId = `${kind}:${window}:${addressHash}`;
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM auth_rates WHERE expiresAt <= ?', now);
      this.ctx.storage.sql.exec('DELETE FROM consent_nonces WHERE expiresAt <= ?', now);
      const count = (id: string) => this.ctx.storage.sql.exec<{ count: number }>('SELECT count FROM auth_rates WHERE id = ?', id).toArray()[0]?.count ?? 0;
      if (count(globalId) >= policy.global || count(addressId) >= policy.perAddress) return false;
      for (const id of [globalId, addressId]) {
        this.ctx.storage.sql.exec('INSERT INTO auth_rates (id, count, expiresAt) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET count = count + 1', id, expiresAt);
      }
      return true;
    });
  }

  async rememberNonce(nonce: string, expiresAt: number): Promise<void> {
    const hash = await mac(await this.key, `nonce:${nonce}`);
    this.ctx.storage.sql.exec('INSERT INTO consent_nonces (hash, expiresAt) VALUES (?, ?)', hash, expiresAt);
  }

  async consumeNonce(nonce: string): Promise<boolean> {
    const hash = await mac(await this.key, `nonce:${nonce}`);
    return this.ctx.storage.sql.exec('DELETE FROM consent_nonces WHERE hash = ? AND expiresAt > ? RETURNING hash', hash, Date.now()).toArray().length === 1;
  }
}

function store(env: Env) {
  return env.MCP_ACCESS_KEYS.get(env.MCP_ACCESS_KEYS.idFromName('global'));
}
function validLabel(label: unknown): label is string {
  return typeof label === 'string' && label.trim() === label && label.length >= 1 && label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(label);
}
function bearer(request: Request): string | null {
  const value = request.headers.get('Authorization');
  if (!value || value.length > 4096) return null;
  return /^Bearer ([^\s,]+)$/i.exec(value)?.[1] ?? null;
}
function error(status: number, code = 'invalid_request', extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Access-Control-Allow-Origin', '*');
  return Response.json({ error: code }, { status, headers });
}
function unauthorized(env: Env): Response {
  return error(401, 'invalid_token', { 'WWW-Authenticate': `Bearer resource_metadata="${new URL(env.PUBLIC_MCP_URL).origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"` });
}
async function limited(request: Request, env: Env, kind: RateKind): Promise<Response | null> {
  // CF-Connecting-IP is supplied by Cloudflare, never X-Forwarded-For or a client identity.
  const allowed = await store(env).allow(kind, request.headers.get('CF-Connecting-IP') ?? 'unknown');
  return allowed ? null : error(429, 'temporarily_unavailable', { 'Retry-After': String(Math.ceil(policies[kind].window / 1000)) });
}
async function boundedBody(request: Request, limit = 16_384): Promise<string> {
  const result = await readByteLimitedText(request, limit);
  if (!result.ok) throw new InvalidRequest('Invalid body');
  return result.text;
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function consentHtml(clientName: string, clientId: string, redirectUri: string, token: string, env: Env): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Pillowfort</title>
<style>body{font:16px Tahoma,Arial,sans-serif;color:#1d2c42;background:#dce7f5;margin:0;padding:32px 16px}main{max-width:620px;margin:auto;background:#fff;padding:24px;border:1px solid #8c9db5}h1{font-size:24px;color:#1556a8}p,li{line-height:1.5}code{overflow-wrap:anywhere}label{display:block;margin-top:20px}input[type=password]{box-sizing:border-box;width:100%;padding:10px;margin:8px 0 16px;border:1px solid #8c9db5;font:inherit}button{font:inherit;background:#1556a8;color:white;padding:10px 16px;border:0;margin:12px 8px 0 0}button[value=deny]{background:#536078}</style>
<main><h1>Authorize Pillowfort</h1><p><strong>${escape(clientName)}</strong> requests access to your managed room participant.</p><p>Client identifier: <code>${escape(clientId)}</code><br>Return address: <code>${escape(redirectUri)}</code></p>
<p>Permission: <strong>${SCOPE}</strong> — create and join private rooms, privately invite participants, verify and approve peers, read and write room content, and collaborate without asking you for each action.</p>
<ul><li>The hosted service runs a managed browser and can access participant plaintext and room encryption keys in memory. This is not the local end-to-end custody model. Raw keys are not exported and room content is not written to service logs or stored transcripts.</li><li>Only authorize a client you trust. Room invitation links are private capabilities; share them privately and approve only expected verified peers.</li><li>At most one active browser per operator, ${escape(env.MAX_ACTIVE_BROWSERS)} globally; a shared ${escape(env.MAX_DAILY_BROWSER_MINUTES)}-browser-minute reservation budget per UTC day across this hosted service. Sessions last at most ${escape(env.MAX_SESSION_SECONDS)} seconds and idle browsers close after ${escape(env.IDLE_TIMEOUT_SECONDS)} seconds.</li><li>Authorization cannot access CMS administration or payments. Revoking or expiring your operator key blocks direct access and all OAuth access derived from it. Active work stops at the next authorization check or session limit.</li></ul>
<form action="/authorize" method="post"><input type="hidden" name="consent" value="${escape(token)}"><label for="operator-key">Operator access key</label><input id="operator-key" name="key" type="password" autocomplete="off" spellcheck="false" maxlength="128"><label><input type="checkbox" name="approve" value="yes"> I trust this client and approve the permissions and managed key custody described above.</label><button name="decision" value="allow">Authorize client</button><button name="decision" value="deny">Deny</button></form></main></html>`;
}
function consentHeaders(cookie: string, redirectUri: string): Record<string, string> {
  // Chromium applies form-action across the POST redirect. Only permit the
  // callback origin that the OAuth provider already validated for this client.
  const callbackOrigin = new URL(redirectUri).origin;
  return {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Set-Cookie': `${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookie ? 600 : 0}`,
  };
}
function correctScope(scopes: string[]): boolean {
  return scopes.length === 1 && scopes[0] === SCOPE;
}
async function parseAuthorization(request: Request, env: Env): Promise<AuthRequest> {
  const params = new URL(request.url).searchParams;
  for (const name of params.keys()) if (params.getAll(name).length !== 1) throw new InvalidRequest('Duplicate parameter');
  const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!correctScope(auth.scope) || auth.codeChallengeMethod !== 'S256' || !auth.codeChallenge || auth.responseType !== 'code') throw new InvalidRequest('Invalid authorization');
  if (params.get('resource') !== env.PUBLIC_MCP_URL) throw new InvalidRequest('Invalid resource');
  return auth;
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const rate = await limited(request, env, 'consent');
  if (rate) return rate;
  const key = await signingKey(env.CONSENT_SECRET);
  if (request.method === 'GET') {
    const auth = await parseAuthorization(request, env);
    const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
    if (!client) return error(400);
    const nonce = randomSecret();
    const expiresAt = Date.now() + 600_000;
    const payload = base64url(encoder.encode(JSON.stringify({ nonce, expiresAt, query: new URL(request.url).search })));
    const token = `${payload}.${await mac(key, `consent:${payload}`)}`;
    await store(env).rememberNonce(nonce, expiresAt);
    return new Response(consentHtml(client.clientName ?? auth.clientId, auth.clientId, auth.redirectUri, token, env), { headers: consentHeaders(nonce, auth.redirectUri) });
  }
  if (request.method !== 'POST') return error(405);
  const origin = new URL(env.PUBLIC_MCP_URL).origin;
  if (request.headers.get('Origin') !== origin || (request.headers.has('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin')) return error(403, 'access_denied');
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return error(415);
  const form = new URLSearchParams(await boundedBody(request));
  for (const name of form.keys()) if (!['consent', 'key', 'approve', 'decision'].includes(name) || form.getAll(name).length !== 1) return error(400);
  const [payload, signature, extra] = (form.get('consent') ?? '').split('.');
  if (!payload || !signature || extra !== undefined || !await matches(key, signature, `consent:${payload}`)) return error(403, 'access_denied');
  const bound = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decode64(payload))) as { nonce: string; expiresAt: number; query: string };
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1 || cookies[0] !== `${COOKIE}=${bound.nonce}` || bound.expiresAt <= Date.now() || bound.expiresAt > Date.now() + 600_000) return error(403, 'access_denied');
  if (!await store(env).consumeNonce(bound.nonce)) return error(403, 'access_denied');
  const auth = await parseAuthorization(new Request(`${origin}/authorize${bound.query}`), env);
  if (form.get('decision') === 'deny') {
    const redirect = new URL(auth.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    if (auth.state) redirect.searchParams.set('state', auth.state);
    if (auth.issuer) redirect.searchParams.set('iss', auth.issuer);
    return new Response(null, { status: 302, headers: { ...consentHeaders('', auth.redirectUri), Location: redirect.toString() } });
  }
  if (form.get('decision') !== 'allow' || form.get('approve') !== 'yes') return error(403, 'access_denied');
  const principalId = await store(env).validate(form.get('key') ?? '');
  if (!principalId) return error(401, 'access_denied');
  const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: auth, userId: principalId, metadata: {}, scope: [SCOPE], props: { principalId } });
  return new Response(null, { status: 302, headers: { ...consentHeaders('', auth.redirectUri), Location: result.redirectTo } });
}

async function admin(request: Request, env: Env): Promise<Response> {
  if (request.headers.has('Origin')) return error(403, 'access_denied');
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return error(503, 'temporarily_unavailable');
  const key = await signingKey(env.CONSENT_SECRET);
  const expected = await mac(key, `admin:${env.ADMIN_TOKEN}`);
  if (!await matches(key, expected, `admin:${bearer(request) ?? ''}`)) {
    const failedAttempt = await limited(request, env, 'adminFailure');
    return failedAttempt ?? error(401, 'access_denied');
  }
  const rate = await limited(request, env, 'admin');
  if (rate) return rate;
  const path = new URL(request.url).pathname;
  if (path === '/admin/keys' && request.method === 'POST') {
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return error(415);
    const value: unknown = JSON.parse(await boundedBody(request, 1024));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return error(400);
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(name => name !== 'label' && name !== 'expiresInDays') || !validLabel(input.label) || typeof input.expiresInDays !== 'number' || !Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365) return error(400);
    const issuance = await limited(request, env, 'issuance');
    if (issuance) return issuance;
    const issued = await store(env).issue(input.label, input.expiresInDays);
    return Response.json(issued, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  }
  const id = path.slice('/admin/keys/'.length);
  if (request.method === 'DELETE' && path.startsWith('/admin/keys/') && UUID.test(id)) {
    await store(env).revoke(id);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  return error(404, 'not_found');
}

const publicPaths: Record<string, true> = {
  '/authorize': true,
  '/oauth/token': true,
  '/oauth/register': true,
  '/.well-known/oauth-authorization-server': true,
  '/.well-known/oauth-protected-resource': true,
  '/.well-known/oauth-protected-resource/mcp': true,
};

/** The only route into the MCP router, after provider token validation and live principal recheck. */
export function createAuthorizedWorker(apiHandler: ExportedHandler<Env, unknown, unknown, AuthenticatedProps>): ExportedHandler<Env> {
  const providers = new WeakMap<Env, OAuthProvider<Env>>();
  function providerFor(env: Env): OAuthProvider<Env> {
    let provider = providers.get(env);
    if (provider) return provider;
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: {
        async fetch(request, environment, ctx) {
          if (new URL(request.url).pathname !== '/mcp') return error(404, 'not_found');
          const principalId = (ctx.props as Partial<AuthenticatedProps> | undefined)?.principalId;
          if (typeof principalId !== 'string' || !await store(environment).active(principalId)) return unauthorized(environment);
          const token = bearer(request);
          if (!token) return unauthorized(environment);
          if (!OPERATOR_KEY.test(token)) {
            const summary = await environment.OAUTH_PROVIDER.unwrapToken<AuthenticatedProps>(token);
            if (!summary || summary.userId !== principalId || !correctScope(summary.scope)) return error(403, 'insufficient_scope');
          }
          if (!apiHandler.fetch) return error(503, 'temporarily_unavailable');
          if (request.method === 'POST' && !request.headers.has('MCP-Session-Id')
            && !await store(environment).allow('initialization', principalId)) {
            return error(429, 'rate_limit_exceeded', { 'Retry-After': '3600' });
          }
          return apiHandler.fetch(request, environment, ctx as ExecutionContext<AuthenticatedProps>);
        },
      },
      defaultHandler: { async fetch(request, environment) {
        if (new URL(request.url).pathname === '/authorize') return authorize(request, environment);
        return error(404, 'not_found');
      } },
      authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: [SCOPE],
      resourceMetadata: { resource: env.PUBLIC_MCP_URL, authorization_servers: [new URL(env.PUBLIC_MCP_URL).origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Pillowfort private rooms' },
      clientIdMetadataDocumentEnabled: true, allowPlainPKCE: false, allowImplicitFlow: false,
      allowTokenExchangeGrant: false, accessTokenTTL: 600, refreshTokenTTL: 86_400, clientRegistrationTTL: 86_400,
      clientRegistrationCallback({ clientMetadata }) {
        if (clientMetadata.scope !== undefined && clientMetadata.scope !== SCOPE) return { code: 'invalid_client_metadata', description: 'Unsupported scope' };
      },
      async tokenExchangeCallback(options) {
        if (!correctScope(options.requestedScope) || !correctScope(options.scope)) throw new OAuthError('invalid_scope', { description: 'Unsupported scope' });
        if (options.props?.principalId !== options.userId || !await store(env).active(options.userId)) throw new OAuthError('invalid_grant', { description: 'Authorization unavailable' });
      },
      async resolveExternalToken({ token, env: environment }) {
        const principalId = await store(environment).validate(token);
        return principalId ? { props: { principalId }, audience: environment.PUBLIC_MCP_URL } : null;
      },
      // No credential, URL, client metadata, or exception logging; retain standards-based challenges.
      onError({ code, status, headers }) { return error(status, code, headers); },
    });
    providers.set(env, provider);
    return provider;
  }
  return {
    async fetch(request, env, ctx) {
      try {
        const url = new URL(request.url);
        if (url.origin !== new URL(env.PUBLIC_MCP_URL).origin) return error(404, 'not_found');
        if (url.href.length > 8192 || (request.headers.get('Authorization')?.length ?? 0) > 4096) return error(400);
        if (url.pathname === '/admin/keys' || /^\/admin\/keys\/[0-9a-f-]{36}$/.test(url.pathname)) return await admin(request, env);
        if (url.pathname !== '/mcp' && !Object.hasOwn(publicPaths, url.pathname)) return error(404, 'not_found');
        if (url.pathname === '/mcp') {
          const origin = request.headers.get('Origin');
          const allowed = new Set([new URL(env.PUBLIC_MCP_URL).origin, new URL(env.APP_URL).origin, ...env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean)]);
          if (origin !== null && !allowed.has(origin)) return error(403, 'access_denied');
          if (!['GET', 'POST', 'DELETE', 'OPTIONS'].includes(request.method)) return error(405);
          if (request.method !== 'OPTIONS') {
            const rate = await limited(request, env, 'api');
            if (rate) return rate;
          }
        } else if (url.pathname.startsWith('/.well-known/')) {
          if (!['GET', 'OPTIONS'].includes(request.method)) return error(405);
        } else if (url.pathname === '/oauth/token' || url.pathname === '/oauth/register') {
          if (!['POST', 'OPTIONS'].includes(request.method)) return error(405);
          if (request.method === 'POST') {
            const rate = await limited(request, env, url.pathname === '/oauth/token' ? 'token' : 'registration');
            if (rate) return rate;
            const body = await boundedBody(request);
            request = new Request(request, { body });
          }
        }
        const response = await providerFor(env).fetch(request, env, ctx);
        const headers = new Headers(response.headers);
        headers.delete('Access-Control-Allow-Credentials');
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        if (url.pathname === '/mcp' && request.headers.has('Origin')) {
          headers.set('Access-Control-Allow-Origin', request.headers.get('Origin')!);
          headers.append('Vary', 'Origin');
          headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
          headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID');
          headers.set('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate, Retry-After');
        }
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch (cause) {
        if (cause instanceof InvalidRequest || cause instanceof SyntaxError || cause instanceof AuthorizationError || cause instanceof CimdFetchError) return error(400);
        return error(503, 'temporarily_unavailable');
      }
    },
  };
}
