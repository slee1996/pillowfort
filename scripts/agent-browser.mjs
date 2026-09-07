import { Buffer } from 'node:buffer';
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_WAIT_MS = 30_000;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export class AgentError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorResult(error) {
  return { ok: false, error: error instanceof AgentError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: 'INTERNAL_ERROR', message: 'The operation failed. Check the app connection and session state.', retryable: false } };
}

export function boundedJSON(value, maximum = MAX_INPUT_BYTES) {
  let text;
  try { text = JSON.stringify(value); } catch {
    throw new AgentError('INVALID_INPUT', 'Input must be JSON serializable.');
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) {
    throw new AgentError('SIZE_LIMIT', `JSON payload exceeds the ${maximum}-byte limit or is not a JSON value.`);
  }
  return text;
}

export function validateBaseURL(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AgentError('INVALID_ORIGIN', 'Set --url or baseURL to an explicit HTTPS or loopback HTTP app URL.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new AgentError('INVALID_ORIGIN', 'Use HTTPS or loopback HTTP without URL credentials or a fragment.');
  }
  if ([...url.searchParams.keys()].some(key => key !== 'agent')) {
    throw new AgentError('INVALID_ORIGIN', 'Use the base app URL without invitation, credential, or other query parameters. Pass invitations only to explicit bridge actions.');
  }
  url.searchParams.set('agent', '1');
  return url;
}

/**
 * @typedef {Object} BrowserAgentOptions
 * @property {string} [baseURL]
 * @property {(options: {timeout: number}) => Promise<unknown>} [launchBrowser]
 * @property {number} [maxSessions]
 * @property {number} [timeoutMs]
 * @property {string} [cmsURL]
 * @property {string} [cmsStorageState]
 */

/** Real ephemeral Chromium contexts retain IndexedDB, Web Locks and MLS in the browser. */
export class PillowfortBrowserAgent {
  #browser;
  #starting;
  #closed = false;
  #closing;
  #sessions = new Map();
  #discovery;
  #discovering;
  #pending = new Set();
  #url;
  #launchBrowser;
  #maxSessions;
  #timeoutMs;
  #cmsURL;
  #cmsStorageState;
  #cmsSession;
  #cmsOpening;
  #cmsQueue = Promise.resolve();
  #cmsPending = 0;
  #roomTrafficActions;

  /** @param {BrowserAgentOptions} options */
  constructor({ baseURL, launchBrowser, maxSessions = 8, timeoutMs = 30_000, cmsURL, cmsStorageState } = {}) {
    if (typeof launchBrowser !== 'function') throw new AgentError('INVALID_INPUT', 'A real launchBrowser factory is required.');
    this.#url = validateBaseURL(baseURL);
    if (cmsStorageState && !cmsURL) throw new AgentError('INVALID_INPUT', 'cmsStorageState requires an explicit cmsURL.');
    if (cmsURL) {
      this.#cmsURL = validateBaseURL(cmsURL);
      this.#cmsURL.search = '';
      this.#cmsURL.pathname = '/admin';
    }
    if (cmsStorageState !== undefined && (typeof cmsStorageState !== 'string' || !cmsStorageState)) {
      throw new AgentError('INVALID_INPUT', 'cmsStorageState must be a user-selected Playwright storage-state file path. This file is sensitive.');
    }
    this.#cmsStorageState = cmsStorageState;
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16) {
      throw new AgentError('INVALID_INPUT', 'maxSessions must be an integer from 1 to 16.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new AgentError('INVALID_INPUT', 'timeoutMs must be an integer from 1000 to 60000.');
    }
    this.#launchBrowser = launchBrowser;
    this.#maxSessions = maxSessions;
    this.#timeoutMs = timeoutMs;
  }

  async start() {
    if (this.#closed) throw new AgentError('CLOSED', 'This SDK has closed. Create a new PillowfortAgent instance.');
    if (!this.#starting) {
      this.#starting = (async () => {
        this.#browser = await this.#launchBrowser({ timeout: this.#timeoutMs });
        if (this.#closed) {
          await this.#browser.close();
          throw new AgentError('CLOSED', 'The SDK closed during browser startup.');
        }
      })().catch(error => { this.#starting = undefined; throw error; });
    }
    await this.#starting;
    if (!this.#browser?.isConnected()) throw new AgentError('BROWSER_DISCONNECTED', 'The browser disconnected. Close this SDK and create a new instance.', true);
    return this;
  }

  async #open() {
    await this.start();
    let context;
    try {
      context = await this.#browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
      if (this.#closed) throw new AgentError('CLOSED', 'The SDK is closed.');
      // Subresources may use the app's configured relay/CDN. Top-level navigation
      // cannot leave the explicitly selected app, including external checkout.
      await context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame().parentFrame() === null && request.url() !== this.#url.href) {
          await route.abort('blockedbyclient');
        } else {
          await route.continue();
        }
      });
      const page = await context.newPage();
      context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      const response = await page.goto(this.#url.href, { waitUntil: 'domcontentloaded', timeout: this.#timeoutMs });
      if (response && !response.ok()) throw new AgentError('APP_UNAVAILABLE', 'The selected app returned an HTTP error. Check the app URL and server.', true);
      try {
        await page.waitForFunction(() => {
          const bridge = window.pillowfortAgent;
          return bridge?.version === 1 && ['capabilities', 'execute', 'observe', 'waitForChange'].every(name => typeof bridge[name] === 'function');
        }, null, { timeout: this.#timeoutMs });
      } catch {
        throw new AgentError('BRIDGE_UNAVAILABLE', 'Agent bridge v1 is absent. Serve the updated Pillowfort client at the selected URL; the SDK adds ?agent=1.', true);
      }
      const actionAbort = new AbortController();
      page.on('close', () => actionAbort.abort());
      return { context, page, pendingCalls: 0, pendingActions: 0, nextActionAt: 0, actionQueue: Promise.resolve(), actionAbort };
    } catch (error) {
      await context?.close().catch(() => {});
      if (error instanceof AgentError) throw error;
      throw new AgentError('CONNECTION_FAILED', 'Could not load the selected app. Check its URL, TLS certificate, and running server. Redirects to other pages are blocked.', true);
    }
  }

  async createSession(name) {
    if (typeof name !== 'string' || !SESSION_NAME.test(name)) throw new AgentError('INVALID_SESSION', 'Session names must be 1–64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit.');
    if (this.#closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    if (this.#sessions.has(name)) throw new AgentError('SESSION_EXISTS', 'That session already exists. Reuse it or close it first.');
    if (this.#sessions.size >= this.#maxSessions || this.#pending.size >= this.#maxSessions) throw new AgentError('SESSION_LIMIT', `At most ${this.#maxSessions} named sessions may be open or opening. Close one or wait for creation to finish.`);
    const slot = { name, state: 'opening' };
    this.#sessions.set(name, slot);
    const opening = this.#open();
    this.#pending.add(opening);
    try {
      const session = await opening;
      if (this.#closed || this.#sessions.get(name) !== slot) {
        await session.context.close();
        throw new AgentError('SESSION_CLOSED', 'The session was closed while opening.');
      }
      Object.assign(slot, session, { state: 'ready' });
      return { name, state: 'ready' };
    } catch (error) {
      if (this.#sessions.get(name) === slot) this.#sessions.delete(name);
      throw error;
    } finally {
      this.#pending.delete(opening);
    }
  }

  listSessions() {
    return [...this.#sessions.values()].map(session => ({ name: session.name, state: session.page?.isClosed() ? 'stale' : session.state }));
  }

  #session(name) {
    if (this.#closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    const session = this.#sessions.get(name);
    if (!session) throw new AgentError('SESSION_NOT_FOUND', 'No such session. Use session_list or create a named session first.');
    if (session.state !== 'ready') throw new AgentError('SESSION_NOT_READY', 'The session is still opening. Wait for session_create to finish.', true);
    if (session.page.isClosed() || !this.#browser?.isConnected()) throw new AgentError('STALE_SESSION', 'The session browser page is gone. Close and recreate this session.', true);
    return session;
  }

  async #call(session, method, args, timeoutMs = this.#timeoutMs) {
    boundedJSON(args);
    if (session.pendingCalls >= 32) throw new AgentError('BUSY', 'Too many outstanding calls for this session. Wait for pending calls to finish.', true);
    session.pendingCalls++;
    let timer;
    try {
      const serialized = await Promise.race([
        session.page.evaluate(async ({ method, args, maxBytes }) => {
          const bridge = window.pillowfortAgent;
          if (bridge?.version !== 1) return JSON.stringify({ transportError: 'STALE_SESSION' });
          try {
            const value = await bridge[method](...args);
            const text = JSON.stringify({ value });
            if (new TextEncoder().encode(text).byteLength > maxBytes) return JSON.stringify({ transportError: 'OUTPUT_LIMIT' });
            return text;
          } catch {
            return JSON.stringify({ transportError: 'BRIDGE_ERROR' });
          }
        }, { method, args, maxBytes: MAX_OUTPUT_BYTES }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new AgentError('TIMEOUT', 'The browser operation timed out; this session was closed to prevent late actions. An action may already have committed: inspect state before retrying in a new session.', false)), timeoutMs); }),
      ]);
      const payload = JSON.parse(serialized);
      if (payload.transportError) {
        const messages = {
          STALE_SESSION: 'The page no longer exposes agent bridge v1. Close and recreate the session.',
          OUTPUT_LIMIT: 'The result exceeds the output limit. Request a smaller result through the action parameters.',
          BRIDGE_ERROR: 'The app could not complete this operation. Inspect the session and check action parameters.',
        };
        throw new AgentError(payload.transportError, messages[payload.transportError]);
      }
      if (!Object.hasOwn(payload, 'value')) throw new AgentError('INVALID_RESULT', 'The bridge did not return a JSON value.');
      return payload.value;
    } catch (error) {
      if (error instanceof AgentError) {
        if (error.code === 'TIMEOUT') {
          await session.context.close().catch(() => {});
          if (session.name && this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
          if (session === this.#discovery) this.#discovery = undefined;
        }
        throw error;
      }
      throw new AgentError('STALE_SESSION', 'The browser connection or page was lost. Close and recreate this session; inspect state before retrying mutations.', false);
    } finally {
      clearTimeout(timer);
      session.pendingCalls--;
    }
  }

  async capabilities(name) {
    let session;
    if (name !== undefined) session = this.#session(name);
    else {
      if (!this.#discovery) {
        if (!this.#discovering) {
          this.#discovering = this.#open().then(async result => {
            if (this.#closed) {
              await result.context.close();
              throw new AgentError('CLOSED', 'The SDK is closed.');
            }
            this.#discovery = result;
            return result;
          }).finally(() => { this.#discovering = undefined; });
        }
        await this.#discovering;
      }
      session = this.#discovery;
    }
    const capabilities = await this.#call(session, 'capabilities', []);
    if (!Array.isArray(capabilities) || capabilities.length > 256 || capabilities.some(capability =>
      !capability || typeof capability.name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(capability.name) ||
      typeof capability.description !== 'string' || capability.inputSchema?.type !== 'object' || typeof capability.destructive !== 'boolean' || typeof capability.roomTraffic !== 'boolean') ||
      new Set(capabilities.map(capability => capability.name)).size !== capabilities.length) {
      throw new AgentError('INVALID_CAPABILITIES', 'The app returned an unsupported capability catalog. Update the app and SDK together.');
    }
    this.#roomTrafficActions = new Set(capabilities.filter(capability => capability.roomTraffic).map(capability => capability.name));
    return capabilities;
  }

  async execute(sessionName, name, input = {}) {
    if (typeof name !== 'string' || !name || !input || typeof input !== 'object' || Array.isArray(input)) throw new AgentError('INVALID_INPUT', 'Provide an action name and a JSON object input.');
    const session = this.#session(sessionName);
    if (!this.#roomTrafficActions) await this.capabilities(sessionName);
    input = JSON.parse(boundedJSON(input));
    const deadline = Date.now() + this.#timeoutMs;
    const paced = typeof input.roomId === 'string' && this.#roomTrafficActions.has(name);
    const run = async () => {
      if (paced) {
        const snapshot = await this.#call(session, 'observe', []);
        const members = Math.max(1, snapshot.room?.members?.length ?? 1);
        // The relay allows 256 aggregate frames per five seconds. Reserve half
        // for membership/crypto automation and account for recipient ACK fanout.
        const interval = Math.max(500, Math.ceil(5_000 * members * (members + 4) / 128));
        const waitMs = Math.max(0, session.nextActionAt - Date.now());
        if (Date.now() + waitMs + 1_000 > deadline) throw new AgentError('BUSY', 'The room action budget is busy. Observe state and wait before submitting another action.', true);
        if (waitMs) {
          try { await delay(waitMs, session.actionAbort.signal); }
          catch { throw new AgentError('SESSION_CLOSED', 'The session closed before this action was submitted.'); }
        }
        this.#session(sessionName);
        session.nextActionAt = Date.now() + interval;
      }
      if (Date.now() >= deadline) throw new AgentError('BUSY', 'This action expired in the local queue and was not submitted.', true);
      const result = await this.#call(session, 'execute', [name, input], deadline - Date.now());
      if (!result || typeof result.ok !== 'boolean' || (!result.ok && (!result.error || typeof result.error.code !== 'string' || typeof result.error.message !== 'string' || typeof result.error.retryable !== 'boolean'))) {
        throw new AgentError('INVALID_RESULT', 'The app returned an unsupported action result. Update the app and SDK together.');
      }
      return result;
    };
    // Cancel/recovery/local reads are not held behind paced room mutations.
    if (!paced) return run();
    if (session.pendingActions >= 8) throw new AgentError('BUSY', 'At most eight room actions may be queued per session. Wait for pending actions.', true);
    session.pendingActions++;
    const result = session.actionQueue.then(run).finally(() => { session.pendingActions--; });
    session.actionQueue = result.catch(() => {});
    return result;
  }

  observe(name) { return this.#call(this.#session(name), 'observe', []); }

  wait(name, afterRevision, timeoutMs = MAX_WAIT_MS) {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
      throw new AgentError('INVALID_INPUT', 'afterRevision must be a nonnegative safe integer; timeoutMs must be an integer from 0 to 30000.');
    }
    return this.#call(this.#session(name), 'waitForChange', [afterRevision, timeoutMs], timeoutMs + 5_000);
  }

  async #openCMS() {
    if (!this.#cmsURL) throw new AgentError('CMS_NOT_CONFIGURED', 'Set cmsURL or --cms-url to enable optional authenticated CMS tools.');
    await this.start();
    if (this.#cmsSession && !this.#cmsSession.page.isClosed()) return this.#cmsSession;
    if (!this.#cmsOpening) {
      this.#cmsOpening = (async () => {
        let context;
        try {
          context = await this.#browser.newContext({
            acceptDownloads: false,
            serviceWorkers: 'block',
            ...(this.#cmsStorageState ? { storageState: this.#cmsStorageState } : {}),
          });
          if (this.#closed) throw new AgentError('CLOSED', 'The SDK is closed.');
          await context.route('**/*', async route => {
            const request = route.request();
            if (request.isNavigationRequest() && request.frame().parentFrame() === null &&
                new URL(request.url()).origin !== this.#cmsURL.origin) await route.abort('blockedbyclient');
            else await route.continue();
          });
          const page = await context.newPage();
          context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
          page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
          await page.goto(this.#cmsURL.href, { waitUntil: 'domcontentloaded', timeout: this.#timeoutMs });
          if (new URL(page.url()).origin !== this.#cmsURL.origin) throw new AgentError('INVALID_ORIGIN', 'CMS redirected outside the selected origin.');
          if (this.#closed) throw new AgentError('CLOSED', 'The SDK is closed.');
          this.#cmsSession = { context, page };
          return this.#cmsSession;
        } catch (error) {
          await context?.close().catch(() => {});
          if (error instanceof AgentError) throw error;
          throw new AgentError('CMS_CONNECTION_FAILED', 'Could not open the CMS. Check --cms-url, TLS, and the selected storage-state file. External login and checkout navigation is not automated.', true);
        }
      })().finally(() => { this.#cmsOpening = undefined; });
    }
    return this.#cmsOpening;
  }

  async #fetchCMS(body) {
    const session = await this.#openCMS();
    const serializedBody = body === undefined ? undefined : boundedJSON(body);
    let timer;
    try {
      const result = await Promise.race([
        session.page.evaluate(async ({ body, origin, timeoutMs, maxBytes }) => {
          if (location.origin !== origin) return { failure: 'ORIGIN_CHANGED' };
          try {
            const response = await fetch('/api/agent', {
              method: body === undefined ? 'GET' : 'POST',
              credentials: 'same-origin',
              redirect: 'error',
              headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
              body,
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (response.status === 401 || response.status === 403) return { failure: 'AUTH_REQUIRED' };
            if (!response.body) return { failure: 'INVALID_RESULT' };
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let length = 0;
            let text = '';
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > maxBytes) {
                await reader.cancel();
                return { failure: 'OUTPUT_LIMIT' };
              }
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
            return { value: JSON.parse(text), status: response.status };
          } catch (error) {
            return { failure: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'CMS_REQUEST_FAILED' };
          }
        }, { body: serializedBody, origin: this.#cmsURL.origin, timeoutMs: this.#timeoutMs, maxBytes: MAX_OUTPUT_BYTES }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new AgentError('TIMEOUT', 'CMS request timed out. Inspect article state before retrying a write.', false)), this.#timeoutMs + 2_000); }),
      ]);
      if (result.failure === 'AUTH_REQUIRED') throw new AgentError('AUTH_REQUIRED', `Sign in with an authorized CMS account at ${this.#cmsURL.href}. Use --headed or an explicitly selected authenticated --cms-storage-state file; no login or payment is automated.`);
      if (result.failure) throw new AgentError(result.failure, result.failure === 'TIMEOUT'
        ? 'CMS request timed out. Inspect article state before retrying a write.'
        : 'The CMS request failed or returned an invalid/oversized response. Check the CMS connection and endpoint.', false);
      if (result.status >= 400 && result.value?.ok !== false) throw new AgentError('CMS_REQUEST_FAILED', 'The CMS returned an HTTP error. Check authentication, permissions, and input.', false);
      return result.value;
    } catch (error) {
      if (error instanceof AgentError) {
        if (error.code === 'TIMEOUT') {
          await session.context.close().catch(() => {});
          this.#cmsSession = undefined;
        }
        throw error;
      }
      throw new AgentError('CMS_CONNECTION_FAILED', 'The CMS browser connection was lost. Inspect article state before retrying a write.', false);
    } finally {
      clearTimeout(timer);
    }
  }

  async cmsCapabilities() {
    if (!this.#cmsURL) return [];
    const catalog = await this.#fetchCMS();
    if (catalog?.version !== 1 || !Array.isArray(catalog.capabilities) || catalog.capabilities.length > 128 ||
        catalog.capabilities.some(capability => !capability || typeof capability.name !== 'string' ||
          !/^cms_[A-Za-z0-9_]{1,96}$/.test(capability.name) || typeof capability.description !== 'string' ||
          capability.inputSchema?.type !== 'object' || typeof capability.destructive !== 'boolean') ||
        new Set(catalog.capabilities.map(capability => capability.name)).size !== catalog.capabilities.length) {
      throw new AgentError('INVALID_CAPABILITIES', 'The CMS returned an unsupported capability catalog. Update the CMS and SDK together.');
    }
    return catalog.capabilities;
  }

  executeCMS(name, input = {}) {
    if (typeof name !== 'string' || !/^cms_[A-Za-z0-9_]+$/.test(name) || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AgentError('INVALID_INPUT', 'Provide a cms_* action name and a JSON object input.');
    }
    boundedJSON({ name, input });
    if (this.#cmsPending >= 32) throw new AgentError('BUSY', 'At most 32 CMS calls may be queued. Wait for pending calls to finish.', true);
    this.#cmsPending++;
    const result = this.#cmsQueue.then(async () => {
      const value = await this.#fetchCMS({ name, input });
      if (!value || typeof value.ok !== 'boolean' || (!value.ok && (!value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string' || typeof value.error.retryable !== 'boolean'))) {
        throw new AgentError('INVALID_RESULT', 'The CMS returned an unsupported action result.');
      }
      return value;
    }).finally(() => { this.#cmsPending--; });
    this.#cmsQueue = result.catch(() => {});
    return result;
  }

  async closeSession(name) {
    const session = this.#sessions.get(name);
    if (!session) throw new AgentError('SESSION_NOT_FOUND', 'No such session. Use session_list to find open sessions.');
    this.#sessions.delete(name);
    session.actionAbort?.abort();
    await session.context?.close().catch(() => {});
    return { name, closed: true };
  }

  close() {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => {
        for (const session of this.#sessions.values()) session.actionAbort?.abort();
        await this.#browser?.close().catch(() => {});
        await Promise.allSettled([this.#starting, this.#discovering, this.#cmsOpening, ...this.#pending].filter(Boolean));
        this.#sessions.clear();
        this.#discovery = undefined;
        this.#cmsSession = undefined;
      })();
    }
    return this.#closing;
  }
}
