import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { withOperationalTelemetry, type TelemetryEnv } from "../src/telemetry";

type Attribute = { key: string; value: { stringValue?: string; intValue?: number | string } };
type WireSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  events?: unknown[];
  links?: unknown[];
  status?: { code?: number; message?: string };
};
type Envelope = {
  resourceSpans: {
    resource: { attributes: Attribute[] };
    scopeSpans: { scope: { name: string }; spans: WireSpan[] }[];
  }[];
};
type Received = { path: string; authorization: string | null; contentType: string | null; text: string; envelope: Envelope };

function attributes(values: Attribute[]): Record<string, string | number | undefined> {
  return Object.fromEntries(values.map(({ key, value }) => [
    key, value.intValue === undefined ? value.stringValue : Number(value.intValue),
  ]));
}

const PRIVATE = "PRIVATE-room-session-operator-message-artwork-99d5a4";
const AUTH = "Basic b3RlbDp0ZXN0LW9ubHktcGFzc3dvcmQ=";
const PARENT_TRACE = "11111111111111111111111111111111";
const PARENT_SPAN = "2222222222222222";
let receiver: Server<undefined>;
let env: TelemetryEnv;
let received: Received[];
let pending: Promise<unknown>[];
let reply: (request: Request) => Response | Promise<Response>;
const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } };

beforeEach(() => {
  received = [];
  pending = [];
  reply = () => new Response("{}", { headers: { "content-type": "application/json" } });
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text();
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        text,
        envelope: JSON.parse(text) as Envelope,
      });
      return reply(request);
    },
  });
  env = {
    OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${encodeURIComponent(AUTH)}`,
    OTEL_SAMPLE_RATE: "1",
    OTEL_SERVICE_VERSION: "1.1.0",
    OTEL_DEPLOYMENT_ENVIRONMENT: "test",
  };
});

afterEach(async () => {
  await Promise.allSettled(pending);
  await receiver.stop(true);
});

describe("operational OTLP privacy boundary", () => {
  it("exports interoperable root spans without copying request, response, or parent data", async () => {
    const request = new Request(`https://app.test/api/fort-pass/checkout?room=${PRIVATE}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PRIVATE}`, cookie: PRIVATE, "user-agent": PRIVATE,
        "cf-connecting-ip": PRIVATE, baggage: `private=${PRIVATE}`,
        traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01`, tracestate: `private=${PRIVATE}`,
      },
      body: JSON.stringify({ room: PRIVATE, messages: PRIVATE, artwork: PRIVATE }),
    });
    const businessResponse = new Response(PRIVATE, { status: 201, statusText: PRIVATE, headers: { "x-private": PRIVATE } });
    const response = await withOperationalTelemetry("pillowfort.app", request, env, ctx, async () => {
      expect(await request.text()).toContain(PRIVATE);
      return businessResponse;
    });
    expect(response).toBe(businessResponse);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe(PRIVATE);
    await Promise.all(pending);
    expect(received).toHaveLength(1);
    const wire = received[0];
    expect(wire.path).toBe("/v1/traces");
    expect(wire.authorization).toBe(AUTH);
    expect(wire.contentType).toBe("application/json");
    expect(wire.text).not.toContain(PRIVATE);
    expect(wire.text).not.toContain(PARENT_TRACE);
    expect(wire.text).not.toContain(PARENT_SPAN);
    expect(wire.text).not.toContain(AUTH);
    const resource = wire.envelope.resourceSpans[0];
    const resourceAttributes = attributes(resource.resource.attributes);
    expect(Object.keys(resourceAttributes).sort()).toEqual([
      "deployment.environment.name", "service.name", "service.version",
      "telemetry.sdk.language", "telemetry.sdk.name", "telemetry.sdk.version",
    ]);
    expect(resourceAttributes["service.name"]).toBe("pillowfort.app");
    expect(resourceAttributes["deployment.environment.name"]).toBe("test");
    const scope = resource.scopeSpans[0];
    expect(scope.scope.name).toBe("pillowfort.operational");
    expect(scope.spans).toHaveLength(1);
    const span = scope.spans[0];
    expect(span.name).toBe("http.server.request");
    expect(span.kind).toBe(2);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.traceId).not.toBe("0".repeat(32));
    expect(span.spanId).not.toBe("0".repeat(16));
    expect(span.parentSpanId ?? "").toBe("");
    expect(span.traceState ?? "").toBe("");
    expect(BigInt(span.startTimeUnixNano)).toBeGreaterThan(0n);
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    expect(span.events ?? []).toEqual([]);
    expect(span.links ?? []).toEqual([]);
    expect(span.status?.message ?? "").toBe("");
    expect(attributes(span.attributes)).toEqual({
      "http.request.method": "POST", "http.response.status_code": 201, "pillowfort.operation": "commerce",
    });
  });

  it("never instruments room, websocket, internal, asset, or unknown paths", async () => {
    const paths: [Parameters<typeof withOperationalTelemetry>[0], string][] = [
      ["pillowfort.app", "/ws"], ["pillowfort.app", "/f-abcdefghij"],
      ["pillowfort.app", "/my-private-custom-room"], ["pillowfort.app", "/room/private"],
      ["pillowfort.app", "/__pillowfort/room-status"], ["pillowfort.app", "/analytics"],
      ["pillowfort.app", "/assets/main.js"], ["pillowfort.app", "/api/unknown"],
      ["pillowfort.marketing", "/admin/private"], ["pillowfort.marketing", "/articles/private/extra"],
      ["pillowfort.marketing", "/api/unknown"], ["pillowfort.hosted-mcp", "/mcp/private"],
      ["pillowfort.hosted-mcp", "/admin/keys/not-a-uuid"], ["pillowfort.hosted-mcp", "/oauth/private"],
    ];
    for (const [service, path] of paths) {
      const response = new Response(PRIVATE, { status: 404 });
      expect(await withOperationalTelemetry(service, new Request(`https://app.test${path}?private=${PRIVATE}`), env, ctx, () => response)).toBe(response);
    }
    expect(pending).toEqual([]);
    expect(received).toEqual([]);
  });

  it("classifies public, CMS, OAuth, MCP, and health traffic without exporting slugs or IDs", async () => {
    const routes: [Parameters<typeof withOperationalTelemetry>[0], string, string][] = [
      ["pillowfort.app", "/", "page"],
      ["pillowfort.app", "/api/stripe/webhook", "commerce"],
      ["pillowfort.marketing", `/articles/${PRIVATE}`, "page"],
      ["pillowfort.marketing", "/api/cms", "auth"],
      ["pillowfort.hosted-mcp", "/mcp", "mcp"],
      ["pillowfort.hosted-mcp", "/oauth/token", "auth"],
      ["pillowfort.hosted-mcp", "/admin/keys/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "auth"],
      ["pillowfort.hosted-mcp", "/health", "health"],
    ];
    for (const [service, path, operation] of routes) {
      await withOperationalTelemetry(service, new Request(`https://service.test${path}`), env, ctx, () => new Response(null, { status: 204 }));
      await Promise.all(pending);
      const latest = received[received.length - 1];
      const resource = latest.envelope.resourceSpans[0];
      expect(attributes(resource.resource.attributes)["service.name"]).toBe(service);
      expect(attributes(resource.scopeSpans[0].spans[0].attributes)["pillowfort.operation"]).toBe(operation);
    }
    expect(received).toHaveLength(routes.length);
    const traces = received.map(item => item.envelope.resourceSpans[0].scopeSpans[0].spans[0].traceId);
    expect(new Set(traces).size).toBe(routes.length);
    expect(JSON.stringify(received.map(item => item.envelope))).not.toContain(PRIVATE);
    expect(JSON.stringify(received.map(item => item.envelope))).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("reduces unknown methods and errors to fixed values while rethrowing the original exception", async () => {
    const error = new Error(PRIVATE);
    error.stack = PRIVATE;
    const request = new Request("https://mcp.test/mcp");
    // Bun normalizes unknown constructor methods; exercise the platform boundary explicitly.
    Object.defineProperty(request, "method", { value: "PRIVATECUSTOMMETHOD" });
    let caught: unknown;
    try {
      await withOperationalTelemetry("pillowfort.hosted-mcp", request, env, ctx, () => { throw error; });
    } catch (cause) { caught = cause; }
    expect(caught).toBe(error);
    await Promise.all(pending);
    expect(received).toHaveLength(1);
    expect(received[0].text).not.toContain(PRIVATE);
    expect(received[0].text).not.toContain("PRIVATECUSTOMMETHOD");
    const span = received[0].envelope.resourceSpans[0].scopeSpans[0].spans[0];
    expect(attributes(span.attributes)).toEqual({
      "http.request.method": "_OTHER", "http.response.status_code": 500, "pillowfort.operation": "mcp", "error.type": "internal_error",
    });
    expect(span.status?.code).toBe(2);
    expect(span.status?.message ?? "").toBe("");
    expect(span.events ?? []).toEqual([]);
  });

  it("records server failures but does not call expected 4xx client responses internal errors", async () => {
    for (const status of [401, 503]) {
      await withOperationalTelemetry("pillowfort.hosted-mcp", new Request("https://mcp.test/mcp"), env, ctx, () => new Response(PRIVATE, { status }));
      await Promise.all(pending);
    }
    const spans = received.map(item => item.envelope.resourceSpans[0].scopeSpans[0].spans[0]);
    expect(attributes(spans[0].attributes)["error.type"]).toBeUndefined();
    expect(spans[0].status?.code ?? 0).toBe(0);
    expect(attributes(spans[1].attributes)["error.type"]).toBe("internal_error");
    expect(attributes(spans[1].attributes)["http.response.status_code"]).toBe(503);
    expect(spans[1].status?.code).toBe(2);
  });

  it("does no export work for disabled, unsampled, or malformed configuration", async () => {
    const invalid: Partial<TelemetryEnv>[] = [
      { OTEL_ENABLED: undefined }, { OTEL_ENABLED: "false" }, { OTEL_SAMPLE_RATE: "0" },
      { OTEL_SAMPLE_RATE: "NaN" }, { OTEL_SAMPLE_RATE: "1.1" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: undefined }, { OTEL_EXPORTER_OTLP_ENDPOINT: "not a URL" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: `http://otel:password@127.0.0.1:${receiver.port}` },
      { OTEL_EXPORTER_OTLP_ENDPOINT: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}?` },
      { OTEL_EXPORTER_OTLP_ENDPOINT: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}#` },
      { OTEL_EXPORTER_OTLP_HEADERS: undefined },
      { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=%GG" },
      { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=secret%0d%0aX-Leak:private" },
      { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=one,authorization=two" },
      { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=one,Content-Length=0" },
      { OTEL_SERVICE_VERSION: PRIVATE }, { OTEL_DEPLOYMENT_ENVIRONMENT: PRIVATE },
    ];
    const response = new Response(PRIVATE);
    for (const config of invalid) {
      expect(await withOperationalTelemetry("pillowfort.app", new Request("https://app.test/"), { ...env, ...config }, ctx, () => response)).toBe(response);
    }
    expect(pending).toEqual([]);
    expect(received).toEqual([]);
  });

  it("honors configuration changes on a reused environment instead of retaining old credentials or sampling", async () => {
    const request = new Request("https://app.test/");
    await withOperationalTelemetry("pillowfort.app", request, env, ctx, () => new Response("one"));
    await Promise.all(pending);
    env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic%20cm90YXRlZA%3D%3D";
    await withOperationalTelemetry("pillowfort.app", request, env, ctx, () => new Response("two"));
    await Promise.all(pending);
    env.OTEL_SAMPLE_RATE = "0";
    await withOperationalTelemetry("pillowfort.app", request, env, ctx, () => new Response("three"));
    await Promise.all(pending);
    expect(received.map(item => item.authorization)).toEqual([AUTH, "Basic cm90YXRlZA=="]);
  });

  it("keeps business responses and exceptions intact when the receiver fails or redirects", async () => {
    for (const status of [503, 307]) {
      reply = () => new Response(PRIVATE, { status, headers: { location: `http://127.0.0.1:${receiver.port}/escaped` } });
      const response = new Response(PRIVATE, { status: 202 });
      expect(await withOperationalTelemetry("pillowfort.app", new Request("https://app.test/"), env, ctx, () => response)).toBe(response);
      const error = new Error(PRIVATE);
      let caught: unknown;
      try {
        await withOperationalTelemetry("pillowfort.app", new Request("https://app.test/"), env, ctx, () => { throw error; });
      } catch (cause) { caught = cause; }
      expect(caught).toBe(error);
      await Promise.all(pending);
    }
    expect(received).toHaveLength(4);
    expect(received.every(item => item.path === "/v1/traces")).toBe(true);
    expect(received.every(item => !item.text.includes(PRIVATE))).toBe(true);
  });

  it("returns before ingestion completes and drops overflow without a cross-request queue", async () => {
    const gate = Promise.withResolvers<void>();
    reply = async () => { await gate.promise; return new Response("{}"); };
    try {
      for (let index = 0; index < 20; index += 1) {
        const response = new Response(String(index), { status: 202 });
        // This must finish without releasing the collector response gate.
        expect(await withOperationalTelemetry("pillowfort.app", new Request("https://app.test/"), env, ctx, () => response)).toBe(response);
      }
    } finally {
      gate.resolve();
    }
    await Promise.all(pending);
    expect(received).toHaveLength(8);
    expect(received.every(item => new TextEncoder().encode(item.text).byteLength <= 8192)).toBe(true);
  });

  it("finishes request-owned export work when ingestion stalls", async () => {
    const gate = Promise.withResolvers<void>();
    reply = async () => { await gate.promise; return new Response("{}"); };
    try {
      const response = new Response(PRIVATE);
      expect(await withOperationalTelemetry("pillowfort.app", new Request("https://app.test/"), env, ctx, () => response)).toBe(response);
      await Promise.all(pending);
      expect(received).toHaveLength(1);
      // The timeout released its slot; a later request can export normally.
      reply = () => new Response("{}");
      await withOperationalTelemetry("pillowfort.app", new Request("https://app.test/"), env, ctx, () => new Response("after timeout"));
      await Promise.all(pending);
      expect(received).toHaveLength(2);
    } finally {
      gate.resolve();
    }
  }, 6000);
});
