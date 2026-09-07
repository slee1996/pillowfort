import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('docs/agents/', root);
const target = new URL('marketing/public/agents/', root);
await mkdir(target, { recursive: true });
const documents = ['index.md', 'workflows.md', 'security.md'];
for (const name of [...documents, 'tools.json']) {
  await copyFile(new URL(name, source), new URL(name, target));
}
const catalog = JSON.parse(await readFile(new URL('tools.json', source), 'utf8'));
if (!Array.isArray(catalog.tools) || !catalog.tools.every(tool => typeof tool.name === 'string' && tool.inputSchema?.type === 'object')) {
  throw new Error('Invalid public agent tool catalog; run agent:catalog against the current app.');
}
const toolsMarkdown = '# Pillowfort agent tools\n\n'
  + 'Release snapshot of the room MCP catalog. Call tools/list on your connected server for its current schemas. Optional CMS tools are not part of this catalog.\n\n'
  + catalog.tools.map(tool => `## ${tool.name}\n\n${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n`).join('\n');
await writeFile(new URL('tools.md', target), toolsMarkdown);
const parts = await Promise.all(documents.map(name => readFile(new URL(name, source), 'utf8')));
await writeFile(new URL('marketing/public/llms-full.txt', root), parts.join('\n\n---\n\n') + '\n\n---\n\n' + toolsMarkdown);
console.log(`Built public agent documentation in ${fileURLToPath(target)} (${catalog.tools.length} tools).`);
