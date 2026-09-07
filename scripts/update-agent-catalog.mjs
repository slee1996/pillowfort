import { mkdir, writeFile } from 'node:fs/promises';
import { PillowfortAgent } from './agent-sdk.mjs';
import { createAgentToolRegistry } from './agent-tools.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--url') throw new Error('Usage: node scripts/update-agent-catalog.mjs --url https://pillowfort.xyz');
const agent = new PillowfortAgent({ baseURL: args[1] });
try {
  const registry = await createAgentToolRegistry(agent);
  const tools = [...registry.values()].map(tool => tool.definition);
  const directory = new URL('../docs/agents/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('tools.json', directory), JSON.stringify({ tools }, null, 2) + '\n');
  console.log(`Recorded ${tools.length} room/session tool schemas. No rooms created or joined.`);
} finally {
  await agent.close();
}
