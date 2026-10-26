import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { daemonOptions } from '../src/daemon.js';
import { temporaryProfile } from './fixture.js';

test('named daemon instances isolate default paths and validate explicit ports', () => {
  assert.deepEqual(daemonOptions(['--instance', 'octopulse-test', '--port', '3001'], '/home/synthetic'), {
    instance: 'octopulse-test', port: 3001, profile: '/home/synthetic/.local/state/octopulse-test',
  });
  for (const port of ['0', '-1', '65536', '1.5', '3e3', 'NaN', ' 3001']) assert.throws(() => daemonOptions([`--port=${port}`]), /Port/);
  for (const instance of ['../octopulse', 'octopulse.service', '', 'BAD', 'a'.repeat(65)]) assert.throws(() => daemonOptions(['--instance', instance]), /instance/);
});

test('named installer preserves the original installation and its database', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../test/instance-install-checks.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /only octopulse-test is enabled/);
});

test('two daemon instances serve concurrently with independent settings and profile ownership', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const start = async (instance: string) => {
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./daemon-failure-hook.js', import.meta.url)),
      fileURLToPath(new URL('../src/daemon.js', import.meta.url)), '--instance', instance, '--development', '--profile', join(directory, instance)], {
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '', DISPLAY: '', WAYLAND_DISPLAY: '', OCTOPULSE_TEST_CLOSE_FAILURE: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic daemon startup timed out')), 10_000);
      let pending = '';
      child.stderr.on('data', chunk => {
        pending += String(chunk); const lines = pending.split('\n'); pending = lines.pop()!;
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            if (record.message === 'Octopulse ready') {
              assert.equal(record.context.instance, instance); clearTimeout(timer); resolve(record.context.origin);
            }
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic daemon exited before ready')); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    return { child, exited, origin };
  };
  const first = await start('octopulse');
  const second = await start('octopulse-test');
  assert.notEqual(first.origin, second.origin);
  for (const app of [first, second]) assert.equal((await fetch(app.origin + '/health')).status, 200);
  const me = await (await fetch(first.origin + '/api/me')).json() as { actionToken: string };
  const response = await fetch(first.origin + '/api/settings', { method: 'PUT',
    headers: { Origin: first.origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken },
    body: JSON.stringify({ github: {}, logging: { retention: '7 days' } }) });
  assert.equal(response.status, 200);
  const firstSettings = await (await fetch(first.origin + '/api/settings')).json() as { logging: { retention: string } };
  const secondSettings = await (await fetch(second.origin + '/api/settings')).json() as { logging: { retention: string } };
  assert.equal(firstSettings.logging.retention, '7 days'); assert.equal(secondSettings.logging.retention, '14 days');
  first.child.kill('SIGTERM'); assert.equal((await first.exited)[0], 0);
  assert.equal((await fetch(second.origin + '/health')).status, 200);
  second.child.kill('SIGTERM'); assert.equal((await second.exited)[0], 0);
});
