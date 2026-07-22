import { describe, expect, it } from "bun:test";
import { readByteLimitedText } from "../src/requestBody";

function requestWithStream(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://pillow.test/body", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("byte-limited request bodies", () => {
  it("counts UTF-8 bytes rather than JavaScript string characters", async () => {
    const bytes = new TextEncoder().encode("🙂");

    expect(await readByteLimitedText(requestWithStream(oneChunk(bytes)), 4)).toEqual({
      ok: true,
      text: "🙂",
      byteLength: 4,
    });
    expect(await readByteLimitedText(requestWithStream(oneChunk(bytes)), 3)).toEqual({
      ok: false,
      reason: "body_too_large",
    });
  });

  it("preserves a UTF-8 BOM for raw-body signature verification", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    const result = await readByteLimitedText(requestWithStream(oneChunk(bytes)), bytes.length);
    expect(result).toEqual({ ok: true, text: "\ufeff{}", byteLength: bytes.length });
    if (result.ok) expect(new TextEncoder().encode(result.text)).toEqual(bytes);
  });

  it("rejects an oversized declaration and cancels without pulling the stream", async () => {
    let pulled = false;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await readByteLimitedText(
      requestWithStream(stream, { "content-length": "5" }),
      4
    );

    expect(result).toEqual({ ok: false, reason: "body_too_large" });
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("cancels a chunked stream as soon as actual bytes cross the limit", async () => {
    let cancelledWith: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });

    const result = await readByteLimitedText(requestWithStream(stream), 4);

    expect(result).toEqual({ ok: false, reason: "body_too_large" });
    expect(cancelledWith).toBe("body_too_large");
  });

  it("bounds stream-read work even when the body stays under the byte limit", async () => {
    let cancelledWith: unknown;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(0));
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });

    const result = await readByteLimitedText(requestWithStream(stream), 1);

    expect(result).toEqual({ ok: false, reason: "body_too_fragmented" });
    expect(reads).toBeLessThanOrEqual(8_193);
    expect(cancelledWith).toBe("body_too_fragmented");
  });

  it("fails closed on malformed or false Content-Length values", async () => {
    for (const value of ["+1", "1.5", "1e1", "Infinity", "-1"]) {
      const result = await readByteLimitedText(
        requestWithStream(oneChunk(new Uint8Array([1])), { "content-length": value }),
        4
      );
      expect(result).toEqual({ ok: false, reason: "invalid_content_length" });
    }

    const mismatch = await readByteLimitedText(
      requestWithStream(oneChunk(new Uint8Array([1, 2])), { "content-length": "1" }),
      4
    );
    expect(mismatch).toEqual({ ok: false, reason: "body_length_mismatch" });
  });

  it("rejects invalid UTF-8 and converts reader failures into bounded errors", async () => {
    const invalidUtf8 = await readByteLimitedText(
      requestWithStream(oneChunk(new Uint8Array([0xc3, 0x28]))),
      4
    );
    expect(invalidUtf8).toEqual({ ok: false, reason: "invalid_utf8" });

    const failedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("transport failed"));
      },
    });
    const failed = await readByteLimitedText(requestWithStream(failedStream), 4);
    expect(failed).toEqual({ ok: false, reason: "stream_error" });
  });
});
