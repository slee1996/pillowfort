#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const runtimeFiles = [
  'scripts/agent.mjs',
  'scripts/agent-sdk.mjs',
  'scripts/agent-tools.mjs',
  'scripts/agent-mcp.mjs',
  'scripts/agent-guidance.mjs',
  'scripts/agent-autonomous.mjs',
  'docs/agents/index.md',
  'docs/agents/workflows.md',
  'docs/agents/security.md',
  'LICENSE',
];

async function packageAgent() {
  const manifest = JSON.parse(await readFile(path.join(root, 'agent-package.json'), 'utf8'));
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const registryManifest = JSON.parse(await readFile(path.join(root, 'server.json'), 'utf8'));
  const registryPackage = registryManifest.packages?.find(entry => entry.registryType === 'npm');
  if (registryManifest.name !== manifest.mcpName || registryManifest.version !== manifest.version
    || registryPackage?.identifier !== manifest.name || registryPackage.version !== manifest.version) {
    throw new Error('MCP Registry metadata must match the packaged name and release version.');
  }
  if (manifest.name !== '@slee1996/pillowfort-agent' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Expected @slee1996/pillowfort-agent with a release version in agent-package.json.');
  }
  if (manifest.scripts || manifest.devDependencies || manifest.optionalDependencies || manifest.bundledDependencies || manifest.bundleDependencies) {
    throw new Error('The agent package must not contain lifecycle scripts or additional dependency groups.');
  }
  const dependencies = ['@modelcontextprotocol/sdk', 'playwright'];
  if (Object.keys(manifest.dependencies ?? {}).sort().join('\n') !== dependencies.sort().join('\n')) {
    throw new Error('The agent package must contain only the MCP SDK and Playwright runtime dependencies.');
  }
  for (const name of dependencies) {
    const version = manifest.dependencies[name];
    if (!/^\d+\.\d+\.\d+$/.test(version) || version !== rootManifest.dependencies?.[name]) {
      throw new Error(`Pin ${name} to the exact root runtime dependency version before packaging.`);
    }
  }
  if (!Array.isArray(manifest.files) || [...manifest.files].sort().join('\n') !== [...runtimeFiles].sort().join('\n')) {
    throw new Error('The package files allowlist must match the explicit runtime and agent documentation inputs.');
  }
  const stage = await mkdtemp(path.join(tmpdir(), 'pillowfort-agent-package-'));
  const downloads = path.join(root, 'marketing/public/downloads');
  const filename = `pillowfort-agent-${manifest.version}.tgz`;
  let stagedDownload;
  try {
    await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const relative of runtimeFiles) {
      const destination = path.join(stage, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, relative), destination);
      await chmod(destination, relative === 'scripts/agent.mjs' ? 0o755 : 0o644);
    }
    // npm pack needs no installed dependencies and no registry authentication.
    const { stdout } = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', stage,
    ], { cwd: stage, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    const [packed] = JSON.parse(stdout);
    const expected = ['package.json', ...runtimeFiles].sort();
    if (!packed || !Array.isArray(packed.files) || packed.files.map(file => file.path).sort().join('\n') !== expected.join('\n')) {
      throw new Error('npm pack emitted an unexpected file inventory; refusing to distribute it.');
    }
    if (typeof packed.filename !== 'string' || path.basename(packed.filename) !== packed.filename) {
      throw new Error('npm pack returned an invalid artifact filename.');
    }
    const artifact = await readFile(path.join(stage, packed.filename));
    const sha256 = createHash('sha256').update(artifact).digest('hex');
    await mkdir(downloads, { recursive: true });
    stagedDownload = await mkdtemp(path.join(downloads, '.agent-package-'));
    await writeFile(path.join(stagedDownload, filename), artifact);
    await writeFile(path.join(stagedDownload, `${filename}.sha256`), `${sha256}  ${filename}\n`);
    await rename(path.join(stagedDownload, filename), path.join(downloads, filename));
    await rename(path.join(stagedDownload, `${filename}.sha256`), path.join(downloads, `${filename}.sha256`));
    process.stdout.write(JSON.stringify({
      package: manifest.name,
      version: manifest.version,
      file: path.relative(root, path.join(downloads, filename)),
      sha256,
      checksumFile: path.relative(root, path.join(downloads, `${filename}.sha256`)),
      url: `https://about.pillowfort.xyz/downloads/${filename}`,
    }) + '\n');
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (stagedDownload) await rm(stagedDownload, { recursive: true, force: true });
  }
}

try { await packageAgent(); }
catch (error) {
  process.stderr.write(`Agent packaging failed: ${String(error.message).slice(0, 2000)}\n`);
  process.exitCode = 1;
}
