import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { ExportResultCode, SDK_INFO, type ExportResult } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, TraceIdRatioBasedSampler, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { FORT_PASS_CHECKOUT_PATH, FORT_PASS_CODE_PATH, FORT_PASS_REDEEM_PATH, FORT_PASS_STATUS_PATH, STRIPE_WEBHOOK_PATH } from "./routes";

export interface TelemetryEnv {
  OTEL_ENABLED?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_SAMPLE_RATE?: string;
  OTEL_SERVICE_VERSION?: string;
  OTEL_DEPLOYMENT_ENVIRONMENT?: string;
}

type Service = "pillowfort.app" | "pillowfort.marketing" | "pillowfort.hosted-mcp";
type Operation = "page" | "commerce" | "mcp" | "auth" | "health";
type Lifetime = { waitUntil(promise: Promise<unknown>): void };

// Only this classifier sees paths. Its output never contains a route, slug, or ID.
function operationFor(service: Service, path: string): Operation | undefined {
  switch (service) {
    case "pillowfort.app":
      switch (path) {
        case "/":
        case "/activity": return "page";
        case FORT_PASS_CHECKOUT_PATH:
        case FORT_PASS_CODE_PATH:
        case FORT_PASS_REDEEM_PATH:
        case FORT_PASS_STATUS_PATH:
        case STRIPE_WEBHOOK_PATH: return "commerce";
        default: return undefined; // Includes /ws, every room and all internal DO routes.
      }
    case "pillowfort.marketing":
      switch (path) {
        case "/":
        case "/technology":
        case "/agents":
        case "/articles":
        case "/agents/index.md":
        case "/agents/workflows.md":
        case "/agents/security.md":
        case "/agents/tools.md": return "page";
        case "/admin":
        case "/api/admin/login":
        case "/api/admin/logout":
        case "/api/cms":
        case "/api/agent": return "auth";
        default: return /^\/articles\/[^/]{1,240}$/.test(path) ? "page" : undefined;
      }
    case "pillowfort.hosted-mcp":
      switch (path) {
        case "/": return "page";
        case "/health": return "health";
        case "/mcp": return "mcp";
        case "/authorize":
        case "/oauth/token":
        case "/oauth/register":
        case "/.well-known/oauth-authorization-server":
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
        case "/admin/keys": return "auth";
        default: return /^\/admin\/keys\/[0-9a-f-]{36}$/.test(path) ? "auth" : undefined;
      }
    default: return undefined;
  }
}

function methodFor(method: string): string {
  switch (method) {
    case "GET": case "HEAD": case "POST": case "PUT": case "DELETE":
    case "CONNECT": case "OPTIONS": case "TRACE": case "PATCH": return method;
    default: return "_OTHER";
  }
}

interface Configuration {
  endpoint: string;
  headers: Headers;
  sampleRate: number;
  version?: string;
  environment: "production" | "development" | "test";
}

function configurationFor(env: TelemetryEnv): Configuration | undefined {
  if (env.OTEL_ENABLED !== "true") return;
  const rawEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!rawEndpoint || rawEndpoint.length > 2048 || rawEndpoint !== rawEndpoint.trim()) return;
  const endpoint = new URL(rawEndpoint);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  // Check delimiters too: URL.search/hash omit empty '?' and '#'. Never redirect credentials.
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
    || endpoint.username || endpoint.password || rawEndpoint.includes("?") || rawEndpoint.includes("#")) return;
  const rawRate = env.OTEL_SAMPLE_RATE ?? "0.1";
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawRate)) return;
  const sampleRate = Number(rawRate);
  if (sampleRate === 0) return;
  const environment = env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "production";
  if (environment !== "production" && environment !== "development" && environment !== "test") return;
  const version = env.OTEL_SERVICE_VERSION;
  if (version !== undefined && (version.length > 64
    || !/^(?:\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?|[a-f0-9]{7,40})$/.test(version))) return;
  const rawHeaders = env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!rawHeaders || rawHeaders.length > 8192) return;
  const entries = rawHeaders.split(",");
  if (entries.length > 16) return;
  const headers = new Headers();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) return;
    const name = entry.slice(0, separator).trim().toLowerCase();
    const value = decodeURIComponent(entry.slice(separator + 1).trim());
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || !value || /[\u0000-\u001f\u007f]/.test(value)
      || headers.has(name) || ["host", "content-length", "content-type", "content-encoding", "transfer-encoding", "connection"].includes(name)) return;
    headers.set(name, value);
  }
  if (!headers.has("authorization")) return;
  headers.set("content-type", "application/json");
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/traces`;
  return { endpoint: endpoint.href, headers, sampleRate, version, environment };
}

const EXPORT_TIMEOUT_MS = 3000;
const MAX_EXPORT_BYTES = 8192;
const MAX_ACTIVE_EXPORTS = 8;
// Isolate-wide, including evicted providers: a config rotation cannot defeat the cap.
let activeExports = 0;

class FetchSpanExporter implements SpanExporter {
  constructor(private readonly config: Configuration) {}

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    if (activeExports >= MAX_ACTIVE_EXPORTS || spans.length !== 1) {
      callback({ code: ExportResultCode.FAILED });
      return;
    }
    let body: Uint8Array<ArrayBuffer>;
    try {
      const serialized = JsonTraceSerializer.serializeRequest(spans);
      if (!serialized || serialized.byteLength > MAX_EXPORT_BYTES || !(serialized.buffer instanceof ArrayBuffer)) {
        callback({ code: ExportResultCode.FAILED });
        return;
      }
      body = serialized as Uint8Array<ArrayBuffer>;
    } catch {
      callback({ code: ExportResultCode.FAILED });
      return;
    }
    activeExports += 1;
    void this.send(body).then(
      code => callback({ code }),
      () => callback({ code: ExportResultCode.FAILED }),
    );
  }

  private async send(body: Uint8Array<ArrayBuffer>): Promise<ExportResultCode> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: this.config.headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });
      // The response is untrusted too. No body parsing, retries, or diagnostic logging.
      await response.body?.cancel();
      return response.ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED;
    } catch {
      return ExportResultCode.FAILED;
    } finally {
      clearTimeout(timer);
      activeExports -= 1;
    }
  }

  shutdown(): Promise<void> { return Promise.resolve(); }
}

// No shared batch queue or provider-wide forceFlush: Workers cannot await another
// request's I/O. Each request takes its own ended SDK span and owns its export.
class RequestSpanProcessor implements SpanProcessor {
  private readonly ended = new WeakMap<object, ReadableSpan>();
  constructor(private readonly exporter: FetchSpanExporter) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void { this.ended.set(span, span); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }

  flush(span: Span): Promise<void> | undefined {
    const ended = this.ended.get(span);
    if (!ended) return;
    this.ended.delete(span);
    return new Promise<void>(resolve => {
      this.exporter.export([ended], () => resolve());
    });
  }
}

interface State {
  tracer: Tracer;
  processor: RequestSpanProcessor;
  endpoint?: string;
  headers?: string;
  sampleRate?: string;
  version?: string;
  environment?: string;
}

const MAX_CACHED_ENVS = 8;
const states = new Map<TelemetryEnv, Map<Service, State>>();

function stateFor(service: Service, env: TelemetryEnv): State | undefined {
  if (env.OTEL_ENABLED !== "true") return;
  let services = states.get(env);
  const cached = services?.get(service);
  if (cached && cached.endpoint === env.OTEL_EXPORTER_OTLP_ENDPOINT
    && cached.headers === env.OTEL_EXPORTER_OTLP_HEADERS && cached.sampleRate === env.OTEL_SAMPLE_RATE
    && cached.version === env.OTEL_SERVICE_VERSION && cached.environment === env.OTEL_DEPLOYMENT_ENVIRONMENT) return cached;
  const config = configurationFor(env);
  if (!config) return;
  const processor = new RequestSpanProcessor(new FetchSpanExporter(config));
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": service,
      ...(config.version === undefined ? {} : { "service.version": config.version }),
      "deployment.environment.name": config.environment,
      "telemetry.sdk.name": SDK_INFO["telemetry.sdk.name"],
      "telemetry.sdk.language": SDK_INFO["telemetry.sdk.language"],
      "telemetry.sdk.version": SDK_INFO["telemetry.sdk.version"],
    }),
    sampler: new TraceIdRatioBasedSampler(config.sampleRate),
    spanProcessors: [processor],
    spanLimits: {
      attributeCountLimit: 4, attributeValueLengthLimit: 32,
      eventCountLimit: 0, linkCountLimit: 0,
      attributePerEventCountLimit: 0, attributePerLinkCountLimit: 0,
    },
  });
  const state: State = {
    tracer: provider.getTracer("pillowfort.operational"), processor,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    sampleRate: env.OTEL_SAMPLE_RATE, version: env.OTEL_SERVICE_VERSION,
    environment: env.OTEL_DEPLOYMENT_ENVIRONMENT,
  };
  if (!services) {
    if (states.size >= MAX_CACHED_ENVS) states.delete(states.keys().next().value!);
    services = new Map();
    states.set(env, services);
  }
  services.set(service, state);
  return state;
}

function finish(span: Span, state: State, ctx: Lifetime, status?: number, failed = false): void {
  try {
    if (status !== undefined || failed) span.setAttribute("http.response.status_code", status ?? 500);
    if (failed || (status !== undefined && status >= 500)) {
      span.setAttribute("error.type", "internal_error");
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
    const pending = state.processor.flush(span);
    if (pending) ctx.waitUntil(pending.catch(() => {}));
  } catch {
    // Telemetry must never change a response or replace a business exception.
  }
}

/** Operational metadata only. The handler never receives a span or active context. */
export async function withOperationalTelemetry(
  service: Service,
  request: Request,
  env: TelemetryEnv,
  ctx: Lifetime,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  let state: State | undefined;
  let span: Span | undefined;
  try {
    if (env.OTEL_ENABLED === "true") {
      const operation = operationFor(service, new URL(request.url).pathname);
      if (operation) {
        state = stateFor(service, env);
        span = state?.tracer.startSpan("http.server.request", {
          kind: SpanKind.SERVER,
          attributes: { "http.request.method": methodFor(request.method), "pillowfort.operation": operation },
        }, ROOT_CONTEXT);
      }
    }
  } catch {
    // Invalid configuration or SDK failure disables tracing, not application handling.
  }
  let response: Response;
  try {
    response = await handler();
  } catch (error) {
    if (span && state) finish(span, state, ctx, undefined, true);
    throw error;
  }
  if (span && state) finish(span, state, ctx, response.status);
  return response;
}
