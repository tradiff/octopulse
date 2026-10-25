import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPackage } from '../scripts/install.mjs';

const directory = await mkdtemp('/tmp/opencode/octopulse-instance-install-');
try {
  const home = join(directory, 'home');
  const bundle = process.argv[2] ? resolve(process.argv[2]) : join(directory, 'bundle');
  if (!process.argv[2]) {
    await mkdir(bundle);
    await writeFile(join(bundle, 'octopulse-package.json'), JSON.stringify({ schema: 1, target: 'linux-x64-glibc', digest: 'b'.repeat(64) }));
    await writeFile(join(bundle, 'config.example.toml'), '[github]\ntoken="REPLACE_ME"\n');
  }
  const install = process.argv[2] ? (await import(pathToFileURL(join(bundle, 'scripts/install.mjs')).href)).installPackage : installPackage;
  const config = join(home, '.config/octopulse/config.toml');
  const legacy = new Map([
    [config, '[github]\ntoken="synthetic-shared"\nlogin="alex"\n'],
    [join(home, '.config/systemd/user/octopulse.service'), 'Synthetic existing service'],
    [join(home, '.local/state/octopulse/octopulse.db'), 'Synthetic original database'],
    [join(home, '.local/share/applications/octopulse.desktop'), 'Synthetic original desktop entry'],
  ]);
  for (const [path, contents] of legacy) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, contents, { mode: 0o644 }); }
  const commands = []; const service = async args => { commands.push(args); };
  const options = { instance: 'octopulse-test', port: 3001, config, activate: true };
  const installed = await install(bundle, home, options, service);
  await install(bundle, home, options, service);
  for (const [path, contents] of legacy) {
    assert.equal(await readFile(path, 'utf8'), contents);
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  }
  assert.deepEqual(commands, [['--user', 'daemon-reload'], ['--user', 'enable', 'octopulse-test.service'],
    ['--user', 'daemon-reload'], ['--user', 'enable', 'octopulse-test.service']]);
  assert.equal(installed.config, config);
  assert.equal(installed.profile, join(home, '.local/state/octopulse-test'));
  assert.equal(installed.unit, join(home, '.config/systemd/user/octopulse-test.service'));
  const unit = await readFile(installed.unit, 'utf8');
  assert.ok(unit.includes('"--instance" "octopulse-test" "--port" "3001"'));
  assert.ok(unit.includes(`"--config" "${config}"`));
  assert.ok(unit.includes(`"--profile" "${installed.profile}"`));
  const launcher = await readFile(installed.launcher, 'utf8');
  assert.ok(launcher.includes("'--instance' 'octopulse-test' '--port' '3001'"));
  assert.ok(launcher.includes(`'--profile' '${installed.profile}'`));
  const identity = await readFile(installed.identity, 'utf8');
  assert.match(identity, /Name=Octopulse \(octopulse-test\)/);
  assert.match(identity, /Exec=xdg-open http:\/\/127\.0\.0\.1:3001/);
  await assert.rejects(stat(join(home, '.config/octopulse-test')), { code: 'ENOENT' });
  await assert.rejects(stat(installed.profile), { code: 'ENOENT' });
  for (const instance of ['../octopulse', 'octopulse.service', '', 'BAD', 'a'.repeat(65)]) {
    await assert.rejects(install(bundle, home, { ...options, instance }, service), /instance/);
  }
  for (const port of [0, -1, 65536, 1.5, NaN]) await assert.rejects(install(bundle, home, { ...options, port }, service), /Port/);
  await assert.rejects(install(bundle, home, { ...options, config: join(home, 'missing.toml') }, service), { code: 'ENOENT' });
  console.log('Named installation preserves original service, state, desktop identity and shared config; only octopulse-test is enabled.');
} finally { await rm(directory, { recursive: true, force: true }); }
