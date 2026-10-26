import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployUserService } from '../scripts/deploy-user-service.mjs';
import { installPackage } from '../scripts/install.mjs';
import { installUserService } from '../scripts/install-user-service.mjs';

await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'opencode/octopulse-deploy-check-'));
const backups = [];
async function setup(name) {
  const base = join(work, name);
  const root = join(base, "checkout with spaces % $ 'quotes'");
  const home = join(base, 'home with spaces % $');
  const profile = join(home, '.local/state/octopulse');
  for (const directory of [join(root, 'dist/src'), join(root, 'web'), join(root, 'assets'), profile]) await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'dist/src/daemon.js'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  await writeFile(join(root, 'web/index.html'), '<!doctype html>');
  await writeFile(join(root, 'assets/octopulse-mark-small-white.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(profile, 'state.sqlite'), 'existing synthetic state');
  const bundle = join(base, 'bundle'); await mkdir(bundle);
  await writeFile(join(bundle, 'octopulse-package.json'), JSON.stringify({ schema: 1, target: 'linux-x64-glibc', digest: 'b'.repeat(64) }));
  const installed = await installPackage(bundle, home);
  const original = join(home, '.config/systemd/user/octopulse-test.service');
  await writeFile(original, 'Other named monitor must remain unchanged');
  return { root, home, profile, original, ...installed };
}
const healthy = async url => {
  assert.equal(url, 'http://127.0.0.1:3000/health');
  return Response.json({ status: 'ok' });
};
const managedFiles = fixture => [fixture.unit, fixture.launcher, fixture.identity];
const contents = fixture => Promise.all(managedFiles(fixture).map(path => readFile(path, 'utf8')));
try {
  const fresh = await setup('fresh-install');
  const installPaths = managedFiles(fresh);
  for (const path of installPaths) await rm(path);
  const installCalls = [];
  const installRun = async (file, args) => { installCalls.push([file, args]); return { stdout: '', stderr: '' }; };
  const installed = await installUserService(fresh.root, fresh.home, { run: installRun });
  assert.deepEqual(installed.created, installPaths);
  await assert.rejects(stat(join(fresh.home, '.config/octopulse')), { code: 'ENOENT' });
  for (const path of installPaths) assert.equal((await stat(path)).mode & 0o777, path === fresh.launcher ? 0o700 : 0o600);
  assert.deepEqual(installCalls, [['systemctl', ['--user', 'daemon-reload']]]);
  assert.equal((await deployUserService(fresh.root, fresh.home, { run: installRun, request: healthy })).metadataChanged, false);
  const installedLaunch = spawnSync(fresh.launcher, ['--probe'], { encoding: 'utf8' });
  assert.equal(installedLaunch.status, 0, installedLaunch.stderr);
  assert.deepEqual(JSON.parse(installedLaunch.stdout), ['--instance', 'octopulse', '--port', '3000', '--profile', fresh.profile, '--probe']);
  for (const path of installPaths) await writeFile(path, 'User-owned content');
  const installTimes = await Promise.all(installPaths.map(async path => (await stat(path, { bigint: true })).mtimeNs));
  installCalls.length = 0;
  assert.deepEqual((await installUserService(fresh.root, fresh.home, { run: installRun })).created, []);
  assert.deepEqual(await Promise.all(installPaths.map(path => readFile(path, 'utf8'))), installPaths.map(() => 'User-owned content'));
  assert.deepEqual(await Promise.all(installPaths.map(async path => (await stat(path, { bigint: true })).mtimeNs)), installTimes);
  assert.deepEqual(installCalls, []);
  assert.equal(await readFile(fresh.unit, 'utf8'), 'User-owned content');
  assert.equal(await readFile(join(fresh.profile, 'state.sqlite'), 'utf8'), 'existing synthetic state');
  await assert.rejects(installUserService('relative', fresh.home, { run: installRun }), /Absolute single-line/);

  const fixture = await setup('deployment');
  const before = await contents(fixture);
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: file === 'systemctl' && args.includes('show') ? String(process.pid) : '', stderr: '' };
  };
  const first = await deployUserService(fixture.root, fixture.home, { run, request: healthy });
  backups.push(first.backup);
  assert.equal(first.origin, 'http://127.0.0.1:3000'); assert.equal(first.metadataChanged, true);
  const savedPaths = JSON.parse(await readFile(join(first.backup, 'files.json'), 'utf8'));
  assert.deepEqual(savedPaths, managedFiles(fixture));
  for (const [index, text] of before.entries()) assert.equal(await readFile(join(first.backup, String(index)), 'utf8'), text);
  const unit = await readFile(fixture.unit, 'utf8');
  assert.ok(unit.includes(`WorkingDirectory=${fixture.root.replaceAll('%', '%%')}\n`));
  assert.ok(unit.includes(`ExecStart="${process.execPath}"`));
  assert.ok(unit.includes('/dist/src/daemon.js" "--instance" "octopulse" "--port" "3000"'));
  assert.ok(unit.includes('Description=Octopulse GitHub pull request monitor\n'));
  assert.ok((await readFile(fixture.identity, 'utf8')).includes('Name=Octopulse\n'));
  assert.ok((await readFile(fixture.identity, 'utf8')).includes('Exec=xdg-open http://127.0.0.1:3000\n'));
  assert.ok((await readFile(fixture.identity, 'utf8')).includes(`Icon=${join(fixture.root, 'assets/octopulse-mark-small-white.svg')}\n`));
  assert.equal((await stat(fixture.launcher)).mode & 0o777, 0o700);
  const launch = spawnSync(fixture.launcher, ['--probe'], { encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  assert.deepEqual(JSON.parse(launch.stdout), ['--instance', 'octopulse', '--port', '3000', '--profile', fixture.profile, '--probe']);
  const verify = spawnSync('systemd-analyze', ['--user', 'verify', fixture.unit], { encoding: 'utf8', env: { ...process.env, HOME: fixture.home } });
  assert.equal(verify.status, 0, verify.stderr);
  await assert.rejects(stat(join(fixture.home, '.config/octopulse')), { code: 'ENOENT' });
  assert.equal(await readFile(join(fixture.profile, 'state.sqlite'), 'utf8'), 'existing synthetic state');
  assert.equal(await readFile(fixture.original, 'utf8'), 'Other named monitor must remain unchanged');
  assert.deepEqual(calls.map(call => call.file), [process.execPath, 'systemctl', 'systemctl', 'kbuildsycoca6', 'systemctl']);
  assert.deepEqual(calls.at(-1).args, ['--user', 'restart', 'octopulse.service']);
  assert.ok(calls.every(call => !call.args.includes('octopulse-test.service')));

  const timestamps = await Promise.all(managedFiles(fixture).map(async path => (await stat(path, { bigint: true })).mtimeNs));
  calls.length = 0;
  const second = await deployUserService(fixture.root, fixture.home, { run, request: healthy });
  assert.equal(second.metadataChanged, false); assert.equal(second.backup, undefined);
  assert.deepEqual(calls.map(call => [call.file, call.args[0]]), [[process.execPath, '--input-type=module'], ['systemctl', '--user']]);
  assert.deepEqual(calls[1].args, ['--user', 'restart', 'octopulse.service']);
  assert.deepEqual(await Promise.all(managedFiles(fixture).map(async path => (await stat(path, { bigint: true })).mtimeNs)), timestamps);

  const native = await setup('native-failure'); const unchanged = await contents(native);
  await assert.rejects(deployUserService(native.root, native.home, { run: async file => { assert.equal(file, process.execPath); throw Error('Native dependency mismatch'); }, request: healthy }), /Native dependency mismatch/);
  assert.deepEqual(await contents(native), unchanged);

  for (const key of ['unit', 'launcher', 'identity']) {
    const unmanaged = await setup(`unmanaged-${key}`); await writeFile(unmanaged[key], 'User-owned file');
    const snapshot = await contents(unmanaged);
    await assert.rejects(deployUserService(unmanaged.root, unmanaged.home, { run: async () => assert.fail('Must not execute'), request: healthy }), /unmanaged file/);
    assert.deepEqual(await contents(unmanaged), snapshot);
  }
  const custom = await setup('custom-service');
  await writeFile(custom.unit, (await readFile(custom.unit, 'utf8')).replace('"--port" "3000"', '"--port" "3900"'));
  await assert.rejects(deployUserService(custom.root, custom.home, { run: async () => assert.fail('Must not execute'), request: healthy }), /different --port/);
  let probes = 0;
  const retry = await deployUserService(fixture.root, fixture.home, { run, request: async () => {
    probes++;
    if (probes === 1) throw Error('Listener not ready');
    if (probes === 2) return Response.json({ status: 'starting' });
    return Response.json({ status: 'ok' });
  } });
  assert.equal(retry.origin, first.origin); assert.equal(probes, 3);
  await assert.rejects(deployUserService(fixture.root, fixture.home, { run, request: async () => Response.json({ status: 'not-ok' }), healthTimeoutMs: 0 }), /did not become healthy/);
  await assert.rejects(deployUserService('relative', fixture.home, { run, request: healthy }), /Absolute single-line/);
  console.log('Local deployment checks passed: repeat deploy, quoting, native preflight, state preservation, ownership guards, and health recovery.');
} finally {
  for (const backup of backups) if (backup) await rm(backup, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
