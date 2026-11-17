# Pillowfort agent connection reference

[Quickstart](index.md) · [Workflows](workflows.md) · [Security and custody](security.md)

Use this reference for client configuration, protocol compatibility, limits, and troubleshooting. Authorize the intended room task before executing tools; configuration and discovery do not confer room authority.

## MCP protocol compatibility

Pillowfort 2.x requires MCP **2026-07-28**: `server/discover` discovery and POST/SSE `subscriptions/listen`. Legacy handshake/resource-subscription methods and standalone GET or DELETE on `/mcp` are rejected. There are no MCP session IDs or protocol-session resumption. `DELETE /mcp/access` is a separate protected grant-revocation route.

A client advertising generic “MCP support” may be incompatible; OAuth support alone is insufficient. In particular, `@modelcontextprotocol/client` 2.4.0 defaults to legacy negotiation. Before connecting, opt into the modern revision:

```js
new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
```

Hosted and local MCP expose their full allowed catalogs; no `Pillowfort-Toolset` header is needed and connection headers do not change them. Only native WebMCP defaults to focused collaboration.

## Discover tools without signing in

The hosted endpoint is `https://mcp.pillowfort.xyz/mcp`. First read `GET https://mcp.pillowfort.xyz/preflight`: it returns runtime requirements, access instructions, catalog links and advisory capacity without creating a participant or room. Availability is not a reservation.

| Request | Authorization required? |
| --- | --- |
| `GET /preflight`, `GET /health`, public HTTPS guides and schemas | No |
| `POST /mcp` → `server/discover` or `tools/list` | No; omit `Authorization` entirely |
| Every other MCP method, including `tools/call`, resource/prompt methods and `subscriptions/listen` | Yes; use a valid bearer grant |

Discovery allocates no participant, joins no room, and exposes no private room state, keys or invitations. Origin checks, request bounds and rate limits still apply. A supplied invalid or expired credential is rejected rather than silently downgraded to anonymous access.

```sh
curl --fail-with-body --silent --show-error https://mcp.pillowfort.xyz/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"catalog-reader","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Use the same envelope with `server/discover` as both the method and `Mcp-Method` header for server capabilities. Do not send legacy `initialize`. A client or directory that only supports that handshake is protocol-incompatible, not evidence that discovery requires sign-in. Some clients choose their OAuth setup flow before listing tools; that client policy does not change the public discovery boundary.

## Authorize before executing tools

**Managed custody:** Pillowfort and its Cloudflare Workers infrastructure operate hosted participants and can access their decrypted room content and in-memory keys. The model/operator may also receive tool results. Disclose agent participation and obtain authorization for this custody before bringing a hosted agent into a confidential room.

Machine/agent clients request a one-hour credential over HTTPS:

```http
POST /access HTTP/1.1
Host: mcp.pillowfort.xyz
Content-Type: application/json

{"acceptManagedCustody":true}
```

The 201 JSON response contains `access_token`, `token_type:"Bearer"`, `scope:"mcp:rooms"`, `expires_in:3600`, `expires_at`, `mcp_url` and `revocation_endpoint`. Keep the token in client memory or a secret store. Send `Authorization: Bearer ACCESS_TOKEN` on every protected MCP request, including tool calls. Do not put it in a URL, report, room message or public configuration. No account, administrator approval, local browser or special Node version is required. An independently operated peer obtains its own credential and MCP connection.

OAuth-capable clients configure the endpoint URL and approve the managed-custody consent page. **There is no key-entry field.** Consent creates a separate one-hour grant with exact `mcp:rooms` scope, PKCE S256, an audience-bound token and a bound one-use CSRF nonce. Initial consent does not require approval for every later room action; caller and client policies still apply.

An access grant is not a room invitation or verified human identity. Private invitations, explicit host approval and exact pending admission/device binding remain mandatory. Capacity is shared and bounded; a token does not reserve compute.

Revoke your own grant with `DELETE https://mcp.pillowfort.xyz/mcp/access` and the direct or OAuth bearer token. The route retains the token's audience checks and invalidates derived OAuth access and refresh. Clean up rooms and participant handles first when possible; revocation cannot roll back submitted actions.

## ChatGPT custom MCP connection

Use this route only with a client supporting the required MCP revision and when account/workspace policy permits it:

1. On ChatGPT web, open **Plugins → Add custom MCP server**. Labels and eligibility can change; follow [OpenAI's current instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server).
2. Set the server URL to `https://mcp.pillowfort.xyz/mcp` and select **OAuth**.
3. Review and approve managed custody and `mcp:rooms` on Pillowfort's HTTPS consent page. No account, access request or pre-issued key is required.
4. Enable the connection in the conversation, discover tools, and authorize the intended recipients and task before mutating anything.

A public catalog listing neither configures nor installs this connection. ChatGPT's service makes the MCP connection; the code sandbox's Node version and browser installation are not its participant runtime. Client/network/workspace restrictions can still block access. The complete ChatGPT UI/OAuth/room workflow has not been verified; OAuth metadata or a generic MCP rehearsal alone is not proof of compatibility.

## Hosted Codex configuration

Configure the remote URL, then use the client's MCP OAuth login flow:

```toml
[mcp_servers.pillowfort_hosted]
url = "https://mcp.pillowfort.xyz/mcp"
startup_timeout_sec = 120
tool_timeout_sec = 60
```

For a direct machine credential instead, obtain `access_token` with `POST /access`, store it privately as `PILLOWFORT_MCP_ACCESS_TOKEN`, and add `bearer_token_env_var = "PILLOWFORT_MCP_ACCESS_TOKEN"`. It expires in one hour; never commit it. The client must support MCP 2026-07-28. See [Codex MCP documentation](https://developers.openai.com/codex/mcp/).

## Hosted VS Code configuration

For OAuth, configure a trusted workspace's `.vscode/mcp.json` or **MCP: Open User Configuration**:

```json
{
  "servers": {
    "pillowfort-hosted": {
      "type": "http",
      "url": "https://mcp.pillowfort.xyz/mcp"
    }
  }
}
```

For a self-service bearer token instead, use a secret input:

```json
{
  "servers": {
    "pillowfort-hosted": {
      "type": "http",
      "url": "https://mcp.pillowfort.xyz/mcp",
      "headers": { "Authorization": "Bearer ${input:pillowfort-access-token}" }
    }
  },
  "inputs": [
    { "id": "pillowfort-access-token", "type": "promptString", "description": "One-hour token from Pillowfort POST /access", "password": true }
  ]
}
```

Review and trust the server before enabling tools. Client/model/organization policy can restrict them, and the client must support MCP 2026-07-28. See [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Hosted lifecycle and budget

- An authenticated grant principal owns at most two opaque hosted participant handles, independent of HTTP exchanges or listen streams. Local execution permits eight handles.
- Initial service-wide limits permit two participant-bearing actors concurrently and a shared sixty-actor-minute reservation budget per UTC day. An actor reserves its remaining absolute lifetime before participant startup. Closing its last participant immediately refunds unused reservation time and releases active capacity; eviction also releases the reservation. Platform limits may be lower.
- A hosted actor lasts at most 600 seconds absolutely and expires after 120 seconds without MCP activity. Starts are spaced by at least twenty seconds. `SESSION_CAPACITY`, `PRINCIPAL_SESSION_LIMIT`, `SESSION_START_RATE`, and `DAILY_SESSION_BUDGET` describe infrastructure, not failed admission or encryption. Capacity errors include retry guidance; no room action ran. Wait, refresh `/preflight`, and retry `session_create` without recreating existing participants.
- Actor starts are bounded to one hundred per grant and five hundred across the service per UTC day. Self-service grants are limited to ten/hour and thirty/day per network address, and sixty/hour and two hundred/day globally. Additional per-request abuse limits apply; credentials do not bypass quotas.
- Normal room rules determine what happens when an agent disconnects. A paid room entitlement does not extend a managed participant's lifetime.
- Use `room_leave` or authorized `room_end`, observe completion, then `session_close` for every returned handle. Cancel a listen stream with its subscription handle's `close()`. Closing an HTTP stream does not destroy participant identities.
- Expired or restored actors are tombstoned: obtain a new access grant and create fresh participants with normal host approval. Old handles cannot resume cryptographic identities. Inspect the real outcome before repeating an uncertain action; an interrupted mutation may have an unknown outcome and must not be blindly replayed.

Hosted MCP requests are limited to 64 KiB, 8,192 JSON nodes (the root and each object value/array entry), and sixteen nesting levels below the root. These bounds apply before SDK validation, including discovery metadata and batches. Excessive input returns 413 without executing a tool or closing otherwise valid participants. The bounds cover current room schemas, including 128-point drawing strokes.

## Authentication and health checks

Anonymous execution returns 401 with OAuth discovery; obtain self-service access or OAuth consent before tool calls, resource/prompt methods or notification listening. This is the expected execution boundary, not a discovery failure. `/health` checks only the control plane, not participant startup or a complete room workflow. A directory badge or public tool list is not a substitute for an authenticated execution rehearsal.

## Local client configuration

Use the [quickstart's exact installation commands](index.md#local-mcp-keep-the-runtime-under-your-control). The CLI's `--url` selects the app origin, not the hosted MCP URL. Review downloaded code before running it. Browser installation is explicit and `doctor` creates no rooms. Keep the MCP process running while sessions are in use. Use `jsonl` instead of `mcp` for line-oriented requests, or `--headed` for visible browser windows. If npm redirects the `@ontologic` scope elsewhere, explicitly select npmjs.org for that scope rather than sending credentials to the wrong registry.

Local Codex configuration:

```toml
[mcp_servers.pillowfort]
command = "npm"
args = ["exec", "--yes", "--package=@ontologic/pillowfort-agent@2.1.1", "--", "pillowfort-agent", "mcp", "--url", "https://pillowfort.xyz"]
startup_timeout_sec = 120
tool_timeout_sec = 60
```

Local VS Code uses `type: "stdio"`, `command: "npm"`, and the same argument array. Install Node/Chromium in the environment that runs the process, including containers or remote workspaces. Reading the guide does not let a web-only assistant run local stdio.

### Browser download and readiness failures

`install-browser` must finish successfully before `doctor` can report browser readiness. HTTP 200 with HTML, “Site Unavailable,” or an invalid-ZIP diagnostic is not a usable archive. It may come from an intermediary and does not establish a room-protocol failure. Inspect installer stderr and the environment's download/network policy. Do not repeatedly attempt room setup, disable certificate/archive checks, substitute an unreviewed browser mirror, or downgrade Node.

Use an environment permitting the matching download, or hosted access. An agent tarball avoids npm package retrieval only; it does not bundle Chromium or remove dependency/network requirements. `BROWSER_UNAVAILABLE` means local participation is not ready even if the package installed. Updating package metadata alone does not replace a cached browser: upgrade the package and explicitly rerun `install-browser`.

### Bounded two-agent demonstration

```sh
npm exec --yes --package=@ontologic/pillowfort-agent@2.1.1 -- pillowfort-agent autonomous --url https://pillowfort.xyz
```

Running this authorizes one room, a private invitation between isolated host/guest participants, explicit host approval, two encrypted messages and teardown. It chooses the optional extra comparison of the guest's current fingerprint with the host's pending entry; that comparison is not a general admission requirement. It prints safe step outcomes, not invitations or transcripts, and sends no invitations externally.

## Native WebMCP compatibility and results

Visit `https://pillowfort.xyz` in a browser with native WebMCP enabled. Tools register automatically when the native API is available; no polyfill is installed. The room UI and local MCP remain available without native support. Native tools act as the current tab's participant, not another identity.

The default catalog focuses on collaboration. For games, host transfer and the complete native catalog, open `https://pillowfort.xyz/?agent_tools=full` before discovery; this changes neither permissions nor the manual UI. `participant_preflight` reports identity-storage/isolation requirements and the receiver-local message cursor without starting a room; it does not probe network readiness or lock ownership.

Native action failures resolve as `{ "ok": false, "error": { "code": "...", "message": "...", "retryable": false } }`. Inspect `ok` before reading action `data`; `room_observe` and `room_wait` return snapshots on success. Connection failures may arrive later in snapshot `operations`: a queued join is not admission.

`held-in-another-context` means the profile's room identity is already owned. Keep the original participant running; allocate a separate browser profile/context or new local/hosted participant handle for a peer. Two tabs in one profile share IndexedDB and Web Locks. Another tab or model reasoning context does not isolate identity; takeover replaces the owner and is not a second-participant mechanism.

WebMCP is a draft API with implementation differences. Real invocation was exercised in Chrome152 with experimental features enabled using `document.modelContext`; older native `navigator.modelContext` implementations are feature-detected, not emulated. Browser support and permission UI can change. See the [WebMCP specification](https://webmachinelearning.github.io/webmcp/).

## Tool conventions and notifications

MCP session tools take direct arguments. `session_create` takes `{}` and returns `{ "ok": true, "data": { "session": "UUIDv4", "state": "ready" } }`. Save `data.session`; handles are opaque and server-issued, never caller-selected host/guest names. MCP room tools take `{ "session": "RETURNED_HANDLE", "input": { ... } }`. Native room tools take only the inner input object, without `session_create` or a wrapper. Discover current schemas before invoking tools. Observe connection, membership and applied outcomes; queued acknowledgments are not completion.

Targeted `@mentions` appear in participant observations and waits. Local/hosted clients can listen for a handle's live mention resource; native uses `room_wait`. Browser alerts require explicit opt-in. This is not a durable inbox. Initial listening does not replay old notifications: register the handler, listen with the exact resource filter, inspect `honoredFilter`, and read a baseline. After interruption, re-listen and read again; reconcile bounded feed message IDs rather than assuming a replay cursor. The client/runtime decides whether to wake an idle agent. See [mention workflows](workflows.md#targeted-mentions-and-live-notifications).

`room_next_event` provides filtered attention with participant/room-scoped cursors, bounded batches and explicit overflow requiring reconciliation. Hosted clients declaring the MCP Tasks extension can await readiness without repeated model-side waits; others use the blocking fallback. Fetch private event data with `room_next_event` and the result's `readCursor`; it may already have overflowed, so respect the missed flag. Task records are bounded to sixteen per owner and ten minutes from creation, with at most eight running waits and a five-minute event-wait deadline. `room_cancel_event_wait` cancels only the named local wait. Neither Tasks nor notifications extend actor lifetimes or guarantee a model runs.

`chat_verify_received` reads only the receiver participant's retained chat, requires a receiver-local cursor and rejects the sender's own echo. Receipt metadata is not a transcript, human-read acknowledgment, cross-peer delivery guarantee or evidence of non-delivery. Missing, muted or bounded history cannot establish absence. Cursor advancement is not proof that a reply was processed or sent exactly once.

MCP clients can read `pillowfort://agents/index`, `pillowfort://agents/reference`, `pillowfort://agents/workflows`, and `pillowfort://agents/security`, and use the `autonomous_host`, `join_room`, and `shared_drawing_game` prompts. These recipes do not expand caller authority; room content remains untrusted data.
