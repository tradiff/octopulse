import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installPackage } from '../scripts/install.mjs';

await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'opencode/octopulse-install-'));
try {
  const bundle = join(directory, 'bundle'); const home = join(directory, 'home with spaces % $');
  await mkdir(bundle); await writeFile(join(bundle, 'octopulse-package.json'), JSON.stringify({ schema: 1, target: 'linux-x64-glibc', digest: 'a'.repeat(64) }));
  await writeFile(join(bundle, 'config.example.toml'), '[github]\ntoken="REPLACE_ME"\n');
  const commands = []; const service = async args => { commands.push(args); };
  const first = await installPackage(bundle, home, { activate: true }, service);
  assert.equal((await stat(first.config)).mode & 0o777, 0o600);
  assert.match(await readFile(first.config, 'utf8'), /REPLACE_ME/);
  const custom = '# user settings\n[github]\ntoken="synthetic-token"\n'; await writeFile(first.config, custom);
  const second = await installPackage(bundle, home, { activate: true }, service);
  assert.equal(await readFile(second.config, 'utf8'), custom);
  assert.deepEqual(commands, [['--user', 'daemon-reload'], ['--user', 'enable', 'octopulse.service'], ['--user', 'daemon-reload'], ['--user', 'enable', 'octopulse.service']]);
  const unit = await readFile(second.unit, 'utf8');
  for (const line of ['After=network-online.target graphical-session.target', 'PartOf=graphical-session.target', 'Restart=on-failure', 'RestartSec=5', 'WantedBy=graphical-session.target', 'UMask=0077']) assert.ok(unit.includes(line));
  assert.match(unit, /ExecStart="\/.*runtime\/bin\/node"/); assert.ok(unit.includes('%%')); assert.ok(unit.includes('$$'));
  const identity = await readFile(second.identity, 'utf8'); assert.match(identity, /NoDisplay=true/); assert.match(identity, /Exec=xdg-open/); assert.doesNotMatch(identity, /daemon\.js/);
  assert.ok(identity.includes(`Icon=${join(second.prefix, 'assets/octopulse-mark-small-white.svg')}\n`));
  assert.match(await readFile(second.launcher, 'utf8'), /runtime\/bin\/node/);
  await writeFile(second.unit, 'unrelated existing service');
  await assert.rejects(installPackage(bundle, home, { activate: true }, service), /coexistence/);
  assert.equal(await readFile(second.unit, 'utf8'), 'unrelated existing service');
  console.log('Installer preservation, private config, service invocation, and coexistence checks passed');
} finally { await rm(directory, { recursive: true, force: true }); }
