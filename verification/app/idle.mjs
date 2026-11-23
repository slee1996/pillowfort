// Explicitly opt in: occupies one otherwise-unused production lease for 125 seconds. Never creates a room.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
const [mode, output] = process.argv.slice(2);
if (mode !== "--production" || !output)
  throw Error("Usage: node verification/app/idle.mjs --production OUTPUT");
const issuer = "https://mcp.pillowfort.xyz",
  version = "2026-07-28";
const preflight = async () => (await (await fetch(issuer + "/preflight")).json()).quota;
const quota = await preflight();
assert(
  quota.activeSessions === 0 && quota.canStartFullSession,
  "Leave shared capacity to existing participants",
);
const grant = await fetch(issuer + "/access", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ acceptManagedCustody: true }),
});
assert.equal(grant.status, 201);
const { access_token: token } = await grant.json();
const result = {};
let id = 0;
async function call(name, args) {
  const response = await fetch(issuer + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      "MCP-Protocol-Version": version,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "release-acceptance", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return [response.status, await response.json()];
}
try {
  const [created, reply] = await call("session_create", {});
  assert.equal(created, 200);
  const session = reply.result.structuredContent.data.session;
  const [before, observed] = await call("session_observe", { session });
  assert.equal(before, 200);
  assert.equal(observed.result.structuredContent.ok, true);
  const start = Date.now();
  await wait(125000);
  const [after, lost] = await call("session_observe", { session });
  result.secondsIdle = Math.floor((Date.now() - start) / 1000);
  result.status = after;
  result.identityRestorable = lost.error?.data?.identityRestorable;
  assert.equal(after, 404);
  assert.equal(result.identityRestorable, false);
  [result.recreate] = await call("session_create", {});
  assert.equal(result.recreate, 404);
  result.quotaAfter = (await preflight()).activeSessions; // May include unrelated participants; never close them.
} finally {
  result.revoked = (
    await fetch(issuer + "/mcp/access", { method: "DELETE", headers: { Authorization: "Bearer " + token } })
  ).ok;
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  assert(result.revoked);
}
