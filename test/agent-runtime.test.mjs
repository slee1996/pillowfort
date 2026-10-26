import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const entrypoint = new URL('../scripts/agent.mjs', import.meta.url).href;

test('the CLI refuses unpatched and unsupported Node releases before starting a participant', () => {
  const cases = [
    ['22.23.3', false], ['22.23.4', true], ['22.24.0', true],
    ['23.3.0', false],
    ['24.22.0', false], ['24.22.1', true], ['24.23.0', true],
    ['25.0.0', false],
    ['26.12.0', false], ['26.12.1', true], ['26.13.0', true],
  ];
  for (const [version, supported] of cases) {
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
