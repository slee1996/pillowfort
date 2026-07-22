export type LimitedTextFailureReason =
  | "missing_body"
  | "invalid_content_length"
  | "body_too_large"
  | "body_too_fragmented"
  | "body_length_mismatch"
  | "stream_error"
  | "invalid_utf8";

export type LimitedTextResult =
  | { ok: true; text: string; byteLength: number }
  | { ok: false; reason: LimitedTextFailureReason };

export interface ByteLimitedBody {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

// Byte limits alone do not bound the number of stream reads: a hostile or
// buggy producer can emit arbitrarily many empty/tiny chunks. Real HTTP bodies
// are coalesced well below this ceiling, while the cap bounds per-request CPU
// and the temporary chunk array even for synthetic streams.
const MAX_BODY_CHUNKS = 8_192;

function declaredContentLength(input: ByteLimitedBody, maxBytes: number): number | null | LimitedTextFailureReason {
  const value = input.headers.get("content-length");
  if (value === null) return null;

  // HTTP Content-Length is a decimal integer. Reject alternate Number() forms
  // such as signs, whitespace, exponents, Infinity, and fractional values.
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return "invalid_content_length";

  try {
    const parsed = BigInt(value);
    if (parsed > BigInt(maxBytes)) return "body_too_large";
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return "invalid_content_length";
    return Number(parsed);
  } catch {
    return "invalid_content_length";
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, reason: string): Promise<void> {
  if (!body || body.locked) return;
  try {
    await body.cancel(reason);
  } catch {
    // The connection may already be aborted or errored. Rejection is expected
    // in that case and must not turn a bounded-body rejection into a 500.
  }
}

/**
 * Read a small text body without ever buffering more than maxBytes.
 *
 * Both Content-Length and the bytes actually received are enforced. Missing
 * Content-Length is supported for chunked requests; malformed or mismatched
 * declarations fail closed. Invalid UTF-8 is rejected rather than normalized
 * with replacement characters before signature or JSON processing.
 */
export async function readByteLimitedText(input: ByteLimitedBody, maxBytes: number): Promise<LimitedTextResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const declared = declaredContentLength(input, maxBytes);
  if (typeof declared === "string") {
    await cancelBody(input.body, declared);
    return { ok: false, reason: declared };
  }
  if (!input.body) return { ok: false, reason: "missing_body" };

  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        try { await reader.cancel("stream_error"); } catch {}
        return { ok: false, reason: "stream_error" };
      }

      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) {
        try { await reader.cancel("stream_error"); } catch {}
        return { ok: false, reason: "stream_error" };
      }


      chunkCount += 1;
      if (chunkCount > MAX_BODY_CHUNKS) {
        try { await reader.cancel("body_too_fragmented"); } catch {}
        return { ok: false, reason: "body_too_fragmented" };
      }

      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        try { await reader.cancel("body_too_large"); } catch {}
        return { ok: false, reason: "body_too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (declared !== null && declared !== byteLength) {
    return { ok: false, reason: "body_length_mismatch" };
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      // Preserve a UTF-8 BOM byte-for-byte when the caller authenticates the
      // decoded text (Stripe HMACs the raw body). TextEncoder then round-trips
      // the exact original bytes instead of silently dropping the BOM.
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      byteLength,
    };
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
}
