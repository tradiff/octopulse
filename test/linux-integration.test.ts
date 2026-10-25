import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { daemonOptions } from '../src/daemon.js';
import { temporaryProfile } from './fixture.js';
import { Profile } from '../src/profile.js';

test('desktop protocols operate on a private session bus with synthetic services', () => {
  const result = spawnSync('dbus-run-session', ['--', process.execPath, fileURLToPath(new URL('./dbus-child.js', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '', DISPLAY: '', WAYLAND_DISPLAY: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Private D-Bus notification/);
});

test('development daemon requires explicit absolute disposable paths and chooses an ephemeral port', () => {
  assert.deepEqual(daemonOptions(['--config', '/tmp/opencode/c.toml', '--profile', '/tmp/opencode/p', '--development']),
    { config: '/tmp/opencode/c.toml', profile: '/tmp/opencode/p', port: 0, instance: 'octopulse' });
  assert.deepEqual(daemonOptions([], '/synthetic-home'), { config: '/synthetic-home/.config/octopulse/config.toml', profile: '/synthetic-home/.local/state/octopulse', port: 3000, instance: 'octopulse' });
  for (const args of [['--development'], ['--config', '/tmp/config'], ['--config', 'relative', '--profile', '/tmp/profile'], ['--port', '65536']]) {
    assert.throws(() => daemonOptions(args));
  }
});

test('installer preserves config and simulates graphical-session service installation', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../test/install-checks.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Installer preservation/);
});

test('daemon serves after synthetic startup and SIGTERM releases its profile successfully', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.toml'); const profile = join(directory, 'state');
  await writeFile(config, '[github]\ntoken="synthetic-token"\nlogin="alex"\n');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon-child.js', import.meta.url)), '--config', config, '--profile', profile, '--development'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  let output = '';
  let pending = '';
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Daemon startup timed out: ' + output)), 10_000);
    child.stderr.on('data', chunk => {
      output += String(chunk);
      pending += String(chunk);
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.message === 'Octopulse ready') { clearTimeout(timer); resolve(record.context.origin); }
      }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Daemon exited before startup')); });
  });
  assert.match(output, /Tray unavailable: no graphical display/);
  assert.equal((await fetch(origin + '/health')).status, 200);
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  const reopened = new Profile(profile); reopened.close();
});

test('actual daemon CLI distinguishes graceful SIGTERM from shutdown failure', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.toml'); await writeFile(config, '[github]\ntoken="synthetic-secret"\nlogin="alex"\n');
  for (const fail of [false, true]) {
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./daemon-failure-hook.js', import.meta.url)),
      fileURLToPath(new URL('../src/daemon.js', import.meta.url)), '--config', config, '--profile', join(directory, String(fail)), '--development'], {
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: '', DISPLAY: '', WAYLAND_DISPLAY: '', OCTOPULSE_TEST_CLOSE_FAILURE: fail ? '1' : '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit'); let output = ''; let ready = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stderr.on('data', chunk => {
      output += String(chunk);
      if (!ready && output.includes('Octopulse ready')) { ready = true; child.kill('SIGTERM'); }
    });
    const [code] = await exited; clearTimeout(timer);
    assert.ok(ready, output);
    assert.equal(code, fail ? 1 : 0, output);
    if (fail) assert.match(output, /startup or shutdown failed/);
    assert.doesNotMatch(output, /synthetic-secret/);
  }
});
