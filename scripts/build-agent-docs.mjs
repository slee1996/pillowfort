import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const source = new URL('docs/agents/', root);
const target = new URL('marketing/public/agents/', root);
const registry = JSON.parse(await readFile(new URL('server.json', root), 'utf8'));
const localPackage = registry.packages.find(entry => entry.registryType === 'npm');
const catalog = JSON.parse(await readFile(new URL('tools.json', source), 'utf8'));
if (!Array.isArray(catalog.tools) || !catalog.tools.every(tool => typeof tool.name === 'string' && tool.inputSchema?.type === 'object')) {
  throw new Error('Invalid public agent tool catalog; run agent:catalog against the current app.');
}
if (catalog.release?.version !== registry.version || catalog.release?.version !== localPackage.version
  || catalog.release?.sourceTag !== `v${registry.version}`
  || catalog.release?.sourceUrl !== `https://github.com/slee1996/pillowfort/tree/v${registry.version}`
  || catalog.release?.toolsSha256 !== createHash('sha256').update(JSON.stringify(catalog.tools)).digest('hex')) {
  throw new Error('Stale release/catalog identity; regenerate agent:catalog for this source release before publishing.');
}
const llms = `# Pillowfort

> Pillowfort.xyz is a private, temporary, end-to-end encrypted browser room for people and agents to chat, draw, and play. No account is needed for an ordinary room; the host approves each joining device.

Pillowfort.xyz is distinct from Pillowfort.social: it is a small live hangout, not a blogging platform or public social feed. It has shared drawing and lightweight games, not built-in voice/video or an AI companion.

The app is https://pillowfort.xyz. Product information and documentation are at https://about.pillowfort.xyz. The authenticated hosted room MCP endpoint is https://mcp.pillowfort.xyz/mcp. The marketing CMS /api/agent is a separate, editor-only service, not a room transport.

Current local package: ${localPackage.identifier}@${localPackage.version}. Local MCP runs supported patched Node.js and explicitly installed Playwright Chromium. Hosted MCP provides self-service one-hour access or OAuth consent without an account or manually issued key. It runs isolated native participants, not a browser. Native WebMCP uses the current tab in a supporting browser and does not install a polyfill.

An authorized agent can host a room, privately invite expected recipients, verify their device fingerprints, approve admission, collaborate, and end the room. Possession of an invitation does not bypass approval. Pillowfort exports invitations but does not send email or DMs. Agent/model operators can see the plaintext their admitted participant accesses; hosted participants are under managed custody.

## Choose a usable runtime before creating a room

- Cloud/web-only agents can use hosted MCP without Node, npm, Chromium, an extension, an account, or maintainer approval. Read [machine preflight](https://mcp.pillowfort.xyz/preflight), then POST https://mcp.pillowfort.xyz/access with JSON {"acceptManagedCustody":true}; keep the returned access_token private and send it as a Bearer credential. It expires after one hour; DELETE /mcp/access revokes it. This grants managed runtime allocation, not admission into someone else's room.
- ChatGPT custom MCP clients select OAuth and approve the managed-custody consent page; no key entry is required. Follow the [ChatGPT setup recipe](https://about.pillowfort.xyz/agents/index.md#chatgpt-custom-mcp-connection); client/workspace permissions still apply. Reading docs does not install a connection.
- Local agents must pass the nonmutating doctor check after the matching browser install. Package installation alone is not readiness. If browser downloads are blocked, use self-service hosted access instead of weakening TLS or downgrading Node.
- Two native tabs in one profile share identity storage and locks. Use isolated browser contexts/profiles or separate named local/hosted sessions. Never use takeover to create a second participant.
- Start with the [focused collaboration catalog](https://about.pillowfort.xyz/agents/collaboration-tools.json) and participant_preflight before room creation. Capture the intended receiver's latestMessageId before sending, then call chat_verify_received on that receiver with the exact sender/text and cursor. Queued actions and sender echoes are not receipts; not-observed/history-unavailable are not proof of non-delivery.

## Start here

- [Agent setup and client recipes](https://about.pillowfort.xyz/agents/index.md): Runtime readiness, ChatGPT custom MCP, hosted access and OAuth, native isolation, Codex, and VS Code setup.
- [Hosted environment preflight](https://mcp.pillowfort.xyz/preflight): Public, nonallocating runtime/access requirements, advisory capacity, expiry and revocation.
- [Focused collaboration schemas](https://about.pillowfort.xyz/agents/collaboration-tools.json): Default hosted/native collaboration tools without the game catalog. Hosted full discovery uses Pillowfort-Toolset: full; native full discovery uses ?agent_tools=full. Local stdio retains its full catalog.
- [Exact room workflows](https://about.pillowfort.xyz/agents/workflows.md): Create, privately invite, verify fingerprints, approve, chat, draw, play, leave, and end a room.
- [Security and authority](https://about.pillowfort.xyz/agents/security.md): Caller policy, invitation secrecy, participant custody, limits, and cleanup.
- [Human-readable agent guide](https://about.pillowfort.xyz/agents): Product capabilities and connection choices.

## Connections and distribution

- [Published npm release](https://registry.npmjs.org/${encodeURIComponent(localPackage.identifier)}/${localPackage.version}): Machine-readable package metadata, runtime requirements, and verified distribution links for ${localPackage.identifier}@${localPackage.version}.
- [Latest official MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(registry.name)}/versions/latest): Published package and authenticated hosted transport metadata.
- [MCP distribution manifest](https://about.pillowfort.xyz/agents/server.json): Machine-readable release ${registry.version}, package arguments, and remote endpoint; contains no operator credentials.
- [Release identity](https://about.pillowfort.xyz/agents/release.json): Exact source tag, version, and full-catalog SHA-256; compare with app /agents-release.json and hosted /health before running.
- [Hosted authorization discovery](https://mcp.pillowfort.xyz/.well-known/oauth-protected-resource/mcp): Public OAuth resource metadata, not an access token or room invitation.
- [Released source code](${catalog.release.sourceUrl}): Product and integration implementation for this distribution.

## Product information

- [Product overview](https://about.pillowfort.xyz/): Private rooms for existing groups, shared drawing, and games.
- [Privacy and technology](https://about.pillowfort.xyz/technology): MLS encryption, host approval, relay metadata, and endpoint/lifecycle limitations.
- [Field notes](https://about.pillowfort.xyz/articles): Published product articles.

## Optional

- [Complete agent documentation](https://about.pillowfort.xyz/llms-full.txt): Combined setup, workflows, security, and full tool reference; larger than the targeted documents above.
- [Release tool schemas](https://about.pillowfort.xyz/agents/tools.json): Room/session JSON schemas. The connected MCP server's tools/list is authoritative.
- [Readable tool reference](https://about.pillowfort.xyz/agents/tools.md): Full release catalog in Markdown.
`;
await Promise.all([
  writeFile(new URL('marketing/public/llms.txt', root), llms),
  writeFile(new URL('client/public/llms.txt', root), llms),
]);
await mkdir(target, { recursive: true });
const documents = ['index.md', 'workflows.md', 'security.md'];
for (const name of [...documents, 'tools.json']) {
  await copyFile(new URL(name, source), new URL(name, target));
}
await copyFile(new URL('server.json', root), new URL('server.json', target));
const collaboration = JSON.parse(await readFile(new URL('collaboration.json', source), 'utf8'));
await writeFile(new URL('collaboration-tools.json', target), JSON.stringify({
  toolset: 'collaboration', fullCatalog: 'https://about.pillowfort.xyz/agents/tools.json',
  release: catalog.release,
  tools: catalog.tools.filter(tool => collaboration.tools[tool.name] === true),
}, null, 2) + '\n');
await writeFile(new URL('release.json', target), JSON.stringify(catalog.release, null, 2) + '\n');
await writeFile(new URL('client/public/agents-release.json', root), JSON.stringify(catalog.release, null, 2) + '\n');
const toolsMarkdown = '# Pillowfort agent tools\n\n'
  + 'Release snapshot of the room MCP catalog. Call tools/list on your connected server for its current schemas. Optional CMS tools are not part of this catalog.\n\n'
  + catalog.tools.map(tool => `## ${tool.name}\n\n${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n`).join('\n');
await writeFile(new URL('tools.md', target), toolsMarkdown);
const parts = await Promise.all(documents.map(name => readFile(new URL(name, source), 'utf8')));
await writeFile(new URL('marketing/public/llms-full.txt', root),
  `# Pillowfort complete agent documentation\n\n> ${localPackage.identifier}@${localPackage.version}. Public product documentation, not authorization to enter a room. The connected runtime is authoritative for current tool schemas.\n\n`
  + parts.join('\n\n---\n\n') + '\n\n---\n\n' + toolsMarkdown);
console.log(`Built public agent documentation in ${fileURLToPath(target)} (${catalog.tools.length} tools).`);
