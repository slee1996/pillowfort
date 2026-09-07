import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { HostedMcpSession } from './session';
import type { AccessKeyStore } from './auth';
import type { BrowserQuota } from './quota';

export interface Env {
  BROWSER: Fetcher;
  MCP_SESSIONS: DurableObjectNamespace<HostedMcpSession>;
  MCP_ACCESS_KEYS: DurableObjectNamespace<AccessKeyStore>;
  MCP_QUOTAS: DurableObjectNamespace<BrowserQuota>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ADMIN_TOKEN: string;
  CONSENT_SECRET: string;
  PUBLIC_MCP_URL: string;
  APP_URL: string;
  ALLOWED_ORIGINS: string;
  MAX_ACTIVE_BROWSERS: string;
  MAX_DAILY_BROWSER_MINUTES: string;
  MAX_SESSION_SECONDS: string;
  IDLE_TIMEOUT_SECONDS: string;
}

export interface AuthenticatedProps {
  principalId: string;
}

export type LeaseResult =
  | { ok: true; expiresAt: number }
  | { ok: false; code: string; retryAfter: number };
