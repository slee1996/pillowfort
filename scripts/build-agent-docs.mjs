import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('docs/agents/', root);
const target = new URL('marketing/public/agents/', root);
const registry = JSON.parse(await readFile(new URL('server.json', root), 'utf8'));
const localPackage = registry.packages.find(entry => entry.registryType === 'npm');
const llms = `# Pillowfort

> Pillowfort.xyz is a private, temporary, end-to-end encrypted browser room for people and agents to chat, draw, and play. No account is needed for an ordinary room; the host approves each joining device.

Pillowfort.xyz is distinct from Pillowfort.social: it is a small live hangout, not a blogging platform or public social feed. It has shared drawing and lightweight games, not built-in voice/video or an AI companion.

The app is https://pillowfort.xyz. Product information and documentation are at https://about.pillowfort.xyz. The authenticated hosted room MCP endpoint is https://mcp.pillowfort.xyz/mcp. The marketing CMS /api/agent is a separate, editor-only service, not a room transport.

Current local package: ${localPackage.identifier}@${localPackage.version}. Local MCP runs Node.js and explicitly installed Playwright Chromium. Hosted MCP requires an issued operator key or OAuth authorization; it does not provide anonymous room allocation. Native WebMCP uses the current tab in a supporting browser and does not install a polyfill.

An authorized agent can host a room, privately invite expected recipients, verify their device fingerprints, approve admission, collaborate, and end the room. Possession of an invitation does not bypass approval. Pillowfort exports invitations but does not send email or DMs. Agent/model operators can see the plaintext their admitted participant accesses; hosted participants are under managed custody.

## Start here

- [Agent setup and client recipes](https://about.pillowfort.xyz/agents/index.md): Runtime requirements, local MCP, hosted keys and OAuth, native WebMCP, Codex, and VS Code setup.
- [Exact room workflows](https://about.pillowfort.xyz/agents/workflows.md): Create, privately invite, verify fingerprints, approve, chat, draw, play, leave, and end a room.
- [Security and authority](https://about.pillowfort.xyz/agents/security.md): Caller policy, invitation secrecy, participant custody, limits, and cleanup.
- [Human-readable agent guide](https://about.pillowfort.xyz/agents): Product capabilities and connection choices.

## Connections and distribution

- [Published npm release](https://registry.npmjs.org/${encodeURIComponent(localPackage.identifier)}/${localPackage.version}): Machine-readable package metadata, runtime requirements, and verified distribution links for ${localPackage.identifier}@${localPackage.version}.
- [Latest official MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(registry.name)}/versions/latest): Published package and authenticated hosted transport metadata.
- [MCP distribution manifest](https://about.pillowfort.xyz/agents/server.json): Machine-readable release ${registry.version}, package arguments, and remote endpoint; contains no operator credentials.
- [Hosted authorization discovery](https://mcp.pillowfort.xyz/.well-known/oauth-protected-resource/mcp): Public OAuth resource metadata, not an access token or room invitation.
- [Source code](https://github.com/slee1996/pillowfort): Product and integration source.

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
const catalog = JSON.parse(await readFile(new URL('tools.json', source), 'utf8'));
if (!Array.isArray(catalog.tools) || !catalog.tools.every(tool => typeof tool.name === 'string' && tool.inputSchema?.type === 'object')) {
  throw new Error('Invalid public agent tool catalog; run agent:catalog against the current app.');
}
const toolsMarkdown = '# Pillowfort agent tools\n\n'
  + 'Release snapshot of the room MCP catalog. Call tools/list on your connected server for its current schemas. Optional CMS tools are not part of this catalog.\n\n'
  + catalog.tools.map(tool => `## ${tool.name}\n\n${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n`).join('\n');
await writeFile(new URL('tools.md', target), toolsMarkdown);
const parts = await Promise.all(documents.map(name => readFile(new URL(name, source), 'utf8')));
await writeFile(new URL('marketing/public/llms-full.txt', root),
  `# Pillowfort complete agent documentation\n\n> ${localPackage.identifier}@${localPackage.version}. Public product documentation, not authorization to enter a room. The connected runtime is authoritative for current tool schemas.\n\n`
  + parts.join('\n\n---\n\n') + '\n\n---\n\n' + toolsMarkdown);
console.log(`Built public agent documentation in ${fileURLToPath(target)} (${catalog.tools.length} tools).`);
