import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const entrypoint = new URL('../scripts/agent.mjs', import.meta.url).href;
const sdkEntrypoint = new URL('../scripts/agent-sdk.mjs', import.meta.url).href;
const runtimeCases = [
  ['20.20.0', false],
  ['22.22.99', false], ['22.23.3', false], ['22.23.4', true], ['22.24.0', true],
  ['23.3.0', false],
  ['24.21.99', false], ['24.22.0', false], ['24.22.1', true], ['24.23.0', true],
  ['25.0.0', false],
  ['26.11.99', false], ['26.12.0', false], ['26.12.1', true], ['26.13.0', true],
  ['27.0.0', true],
];

test('the CLI refuses unpatched and unsupported Node releases before starting a participant', () => {
  for (const [version, supported] of runtimeCases) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const version = process.argv[1];
      process.argv.length = 1;
      Object.defineProperty(process.versions, 'node', { value: version });
      const { main } = await import(${JSON.stringify(entrypoint)});
      await main(['--help']);
    `, version], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, supported ? 0 : 1, `${version}: ${result.stderr}`);
    if (!supported) {
      assert.equal(JSON.parse(result.stdout).error.code, 'UNSUPPORTED_RUNTIME');
    }
  }
});

test('direct SDK consumers enforce the same runtime boundaries before browser startup or app connection', () => {
  for (const [version, supported] of runtimeCases) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const version = process.argv[1];
      Object.defineProperty(process.versions, 'node', { value: version });
      const { PillowfortAgent, AgentError, errorResult } = await import(${JSON.stringify(sdkEntrypoint)});
      const { chromium } = await import('playwright');
      let launches = 0;
      chromium.launch = async () => { launches++; throw new Error('A runtime boundary test must not launch Chromium.'); };
      if (${JSON.stringify(supported)}) {
        const agent = new PillowfortAgent({ baseURL: 'https://pillowfort.invalid' });
        assert.ok(agent instanceof PillowfortAgent);
        await agent.close();
      } else {
        assert.throws(() => new PillowfortAgent({ baseURL: 'https://pillowfort.invalid' }), error => {
          assert.ok(error instanceof AgentError);
          const result = errorResult(error);
          assert.equal(result.ok, false);
          assert.equal(result.error.code, 'UNSUPPORTED_RUNTIME');
          assert.equal(result.error.retryable, false);
          assert.match(result.error.message, /requires patched Node/);
          return true;
        });
      }
      assert.equal(launches, 0);
    `, version], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, '', version);
    assert.equal(result.stderr, '', version);
  }
});

test('unsupported CLI runtimes keep structured failures and MCP stdout protocol-safe', () => {
  for (const command of ['install-browser', 'doctor', 'discover', 'jsonl', 'mcp', 'autonomous']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.argv.length = 1;
      Object.defineProperty(process.versions, 'node', { value: '24.22.0' });
      const { main } = await import(${JSON.stringify(entrypoint)});
      await main([${JSON.stringify(command)}, '--url', 'https://pillowfort.invalid']);
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    if (command === 'mcp') {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^UNSUPPORTED_RUNTIME: /);
    } else {
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.ok, false);
      assert.equal(failure.error.code, 'UNSUPPORTED_RUNTIME');
      assert.equal(failure.error.retryable, false);
      assert.equal(result.stderr, '');
    }
  }
});

test('packaging changed documentation cannot replace a published versioned archive', async () => {
  const root = new URL('../', import.meta.url);
  const directory = await mkdtemp(path.join(tmpdir(), 'pillowfort-immutable-package-'));
  try {
    const manifest = JSON.parse(await readFile(new URL('agent-package.json', root), 'utf8'));
    for (const relative of ['package.json', 'agent-package.json', 'server.json', 'scripts/package-agent.mjs', ...manifest.files]) {
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(fileURLToPath(new URL(relative, root)), destination);
    }
    const pack = () => spawnSync(process.execPath, [path.join(directory, 'scripts/package-agent.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 120_000,
    });
    const first = pack();
    assert.equal(first.status, 0, first.stderr);
    const archive = path.join(directory, JSON.parse(first.stdout).file);
    const original = await readFile(archive);
    const checksum = await readFile(`${archive}.sha256`);
    await appendFile(path.join(directory, 'docs/agents/index.md'), '\nA later public documentation update.\n');
    const changed = pack();
    assert.equal(changed.status, 1);
    assert.deepEqual(await readFile(archive), original);
    assert.deepEqual(await readFile(`${archive}.sha256`), checksum);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const defect of ['missing-tool', 'wrong-schema', 'wrong-read-only']) {
  test(`release gate rejects ${defect} against the real participant runtime`, async () => {
    const root = new URL('../', import.meta.url);
    const directory = await mkdtemp(path.join(tmpdir(), 'pillowfort-catalog-parity-'));
    try {
      const catalog = JSON.parse(await readFile(new URL('docs/agents/tools.json', root), 'utf8'));
      if (defect === 'missing-tool') catalog.tools = catalog.tools.filter(tool => tool.name !== 'participant_preflight');
      if (defect === 'wrong-schema') {
        const tool = catalog.tools.find(tool => tool.name === 'chat_verify_received');
        tool.inputSchema.properties.input.required = [];
      }
      if (defect === 'wrong-read-only') catalog.tools.find(tool => tool.name === 'chat_history_export').annotations.readOnlyHint = false;
      catalog.release.toolsSha256 = createHash('sha256').update(JSON.stringify(catalog.tools)).digest('hex');
      const file = path.join(directory, 'tools.json');
      await writeFile(file, JSON.stringify(catalog));
      const result = spawnSync('bun', ['scripts/check-agent-catalog.ts', '--runtime', 'hosted', '--catalog', file], {
        cwd: fileURLToPath(root), encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, 'CATALOG_MISMATCH');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
