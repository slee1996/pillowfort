import { Buffer } from 'node:buffer';
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_WAIT_MS = 30_000;

export class AgentError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {boolean} [retryable]
   * @param {number} [retryAfterSeconds]
   */
  constructor(code, message, retryable = false, retryAfterSeconds = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function errorResult(error) {
  return { ok: false, error: error instanceof AgentError
    ? { code: error.code, message: error.message, retryable: error.retryable, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) }
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
