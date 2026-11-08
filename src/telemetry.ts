import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { ExportResultCode, SDK_INFO, type ExportResult } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, BasicTracerProvider, TraceIdRatioBasedSampler, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { FORT_PASS_CHECKOUT_PATH, FORT_PASS_CODE_PATH, FORT_PASS_REDEEM_PATH, FORT_PASS_STATUS_PATH, STRIPE_WEBHOOK_PATH } from "./routes";
import catalog from "../docs/agents/tools.json";

export interface TelemetryEnv {
  OTEL_ENABLED?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_SAMPLE_RATE?: string;
  OTEL_SERVICE_VERSION?: string;
  OTEL_DEPLOYMENT_ENVIRONMENT?: string;
}

type Service = "pillowfort.app" | "pillowfort.hosted-mcp";
type Operation = "page" | "commerce" | "mcp" | "auth" | "health";
type Lifetime = { waitUntil(promise: Promise<unknown>): void };
type Scope = "pillowfort.operational" | "pillowfort.volume" | "pillowfort.mcp.tools" | "pillowfort.mcp.tools.trace";

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
        // Workers rejects "error". Manual mode also prevents forwarding credentials.
        redirect: "manual",
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
const states = new Map<TelemetryEnv, Map<Service | Exclude<Scope, "pillowfort.operational">, State>>();

function stateFor(service: Service, env: TelemetryEnv, scope: Scope = "pillowfort.operational"): State | undefined {
  if (env.OTEL_ENABLED !== "true") return;
  const key = scope === "pillowfort.operational" ? service : scope;
  const unsampled = scope === "pillowfort.volume" || scope === "pillowfort.mcp.tools";
  let services = states.get(env);
  const cached = services?.get(key);
  if (cached && cached.endpoint === env.OTEL_EXPORTER_OTLP_ENDPOINT
    && cached.headers === env.OTEL_EXPORTER_OTLP_HEADERS && cached.sampleRate === env.OTEL_SAMPLE_RATE
    && cached.version === env.OTEL_SERVICE_VERSION && cached.environment === env.OTEL_DEPLOYMENT_ENVIRONMENT) return cached;
  const config = configurationFor(env);
  if (!config || (!unsampled && config.sampleRate === 0)) return;
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
    sampler: unsampled ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(config.sampleRate),
    spanProcessors: [processor],
    spanLimits: {
      attributeCountLimit: 4, attributeValueLengthLimit: 32,
      eventCountLimit: 0, linkCountLimit: 0,
      attributePerEventCountLimit: 0, attributePerLinkCountLimit: 0,
    },
  });
  const state: State = {
    tracer: provider.getTracer(scope), processor,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    sampleRate: env.OTEL_SAMPLE_RATE, version: env.OTEL_SERVICE_VERSION,
    environment: env.OTEL_DEPLOYMENT_ENVIRONMENT,
  };
  if (!services) {
    if (states.size >= MAX_CACHED_ENVS) states.delete(states.keys().next().value!);
    services = new Map();
    states.set(env, services);
  }
  services.set(key, state);
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

export type RoomActivity = "room.created" | "room.retired" | "application.accepted" | "member.admitted";

/** Unsampled, content-free count events. The collector aggregates these without storing traces. */
export function recordRoomActivity(env: TelemetryEnv, ctx: Lifetime, activity: RoomActivity): void {
  if (env.OTEL_ENABLED !== "true") return;
  // Enforce the closed vocabulary at runtime too; never accept a caller's labels or identifiers.
  switch (activity) {
    case "room.created": case "room.retired": case "application.accepted": case "member.admitted": break;
    default: return;
  }
  try {
    const state = stateFor("pillowfort.app", env, "pillowfort.volume");
    if (!state) return;
    const span = state.tracer.startSpan("room.activity", {
      kind: SpanKind.INTERNAL,
      attributes: { "pillowfort.activity": activity },
    }, ROOT_CONTEXT);
    finish(span, state, ctx);
  } catch {
    // Counting must never delay or fail an authenticated room transition.
  }
}

type McpToolError = "none" | "invalid_input" | "unknown_tool" | "busy" | "quota" | "timeout" | "connection" | "session" | "internal";
let mcpTools: Record<string, true> | undefined;

// Only exact, known codes are classified. Messages, stacks, and arbitrary codes
// never become attributes, status descriptions, or events.
function mcpToolError(code: unknown, tool: string): McpToolError {
  switch (code) {
    case -32602: // MCP InvalidParams: distinguish an unknown name without reading the message.
      return tool === "_unknown" ? "unknown_tool" : "invalid_input";
    case "INVALID_INPUT": case "INVALID_SESSION": case "SIZE_LIMIT": case "invalid-input":
    case "invalid-target": case "invalid-name": case "invalid-room": case "invalid-secret":
    case "confirmation-required": case "invalid-invitation": case "unauthorized":
    case "incompatible-context": case "stale-room": case "stale-member":
      return "invalid_input";
    case "UNKNOWN_TOOL": case "unknown-tool": return "unknown_tool";
    case "BUSY": case "busy": case "active-room": return "busy";
    case "SESSION_LIMIT": case "PRINCIPAL_SESSION_LIMIT": case "SESSION_CAPACITY":
    case "SESSION_START_RATE": case "DAILY_SESSION_BUDGET":
      return "quota";
    case "TIMEOUT": case "timeout": return "timeout";
    case "CONNECTION_FAILED": case "BRIDGE_ERROR": case "reconnecting": case "unavailable": case "delivery-unavailable":
    case "drawing-not-queued": case "recovery-required": case "no-recovery":
      return "connection";
    case "STALE_SESSION": case "CLOSED": case "SESSION_CLOSED": case "SESSION_EXISTS": case "SESSION_NOT_FOUND":
    case "SESSION_NOT_READY": case "MCP_SESSION_UNAVAILABLE": case "closed":
    case "room-closed": case "credential-unavailable":
      return "session";
    default: return "internal";
  }
}

function thrownMcpToolError(error: unknown, tool: string): McpToolError {
  try {
    return mcpToolError(typeof error === "object" && error !== null && "code" in error ? error.code : undefined, tool);
  } catch {
    return "internal";
  }
}

function returnedMcpToolError(result: unknown, tool: string): McpToolError {
  try {
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== false) return "none";
    return thrownMcpToolError("error" in result ? result.error : undefined, tool);
  } catch {
    return "internal";
  }
}

function finishMcpTool(span: Span | undefined, state: State | undefined, ctx: Lifetime, error: McpToolError, endTime: number): void {
  if (!span || !state) return;
  try {
    span.setAttribute("pillowfort.outcome", error === "none" ? "success" : "error");
    span.setAttribute("pillowfort.error", error);
    if (error !== "none") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(endTime);
    const pending = state.processor.flush(span);
    if (pending) ctx.waitUntil(pending.catch(() => {}));
  } catch {
    // Export and lifetime failures must not replace a tool result or exception.
  }
}

/** One content-free count span plus an independently sampled diagnostic span. */
export async function withMcpToolTelemetry<T>(
  env: TelemetryEnv,
  ctx: Lifetime,
  toolName: string,
  handler: () => Promise<T>,
): Promise<T> {
  if (env.OTEL_ENABLED !== "true") return handler();
  mcpTools ??= Object.fromEntries(catalog.tools.map(tool => [tool.name, true as const]));
  const tool = Object.hasOwn(mcpTools, toolName) ? toolName : "_unknown";
  let countState: State | undefined;
  let traceState: State | undefined;
  let countSpan: Span | undefined;
  let traceSpan: Span | undefined;
  try {
    countState = stateFor("pillowfort.hosted-mcp", env, "pillowfort.mcp.tools");
    traceState = stateFor("pillowfort.hosted-mcp", env, "pillowfort.mcp.tools.trace");
    const options = {
      kind: SpanKind.INTERNAL,
      startTime: Date.now(),
      attributes: { "pillowfort.tool": tool },
    };
    countSpan = countState?.tracer.startSpan("mcp.tool.call", options, ROOT_CONTEXT);
    traceSpan = traceState?.tracer.startSpan("mcp.tool.call", options, ROOT_CONTEXT);
  } catch {
    // Invalid configuration or SDK failure disables telemetry, not tool execution.
  }
  if (!countSpan && !traceSpan) return handler();
  let result: T;
  try {
    result = await handler();
  } catch (error) {
    const endTime = Date.now();
    const category = thrownMcpToolError(error, tool);
    finishMcpTool(countSpan, countState, ctx, category, endTime);
    finishMcpTool(traceSpan, traceState, ctx, category, endTime);
    throw error;
  }
  const endTime = Date.now();
  const category = returnedMcpToolError(result, tool);
  finishMcpTool(countSpan, countState, ctx, category, endTime);
  finishMcpTool(traceSpan, traceState, ctx, category, endTime);
  return result;
}
