import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('user service uninstall guards ownership and requires confirmation to delete all data directories', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../test/uninstall-user-service-checks.mjs', import.meta.url))], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /User service uninstall checks passed/);
});
