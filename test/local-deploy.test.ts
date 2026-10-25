import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('local deployment migrates once, preserves monitoring state, and repeats without installation or desktop refresh', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../test/local-deploy-checks.mjs', import.meta.url))], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Local deployment checks passed/);
});
