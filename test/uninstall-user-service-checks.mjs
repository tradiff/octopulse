import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userServiceFiles } from '../scripts/deploy-user-service.mjs';
import { uninstallUserService } from '../scripts/uninstall-user-service.mjs';
import Database from 'better-sqlite3';

await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'opencode/octopulse-uninstall-check-'));
async function setup(name) {
  const home = join(work, name);
  const { unit, files } = userServiceFiles(work, home);
  const config = join(home, '.config/octopulse/config.toml');
  const state = join(home, '.local/state/octopulse/state.sqlite');
  const dataDirectories = [dirname(config), dirname(state)];
  const otherUnit = join(home, '.config/systemd/user/octopulse-test.service');
  for (const [path, text] of [...files, [config, 'Synthetic config'], [state, 'Saved activity'], [otherUnit, 'Other instance'],
    [join(dirname(state), 'logs/day.jsonl'), 'Saved logs'], [join(dirname(state), 'cache/avatars/user.png'), 'Cached avatar'],
    [join(dirname(config), 'nested/extra.toml'), 'Additional config'], [join(home, '.local/state/octopulse-test/state.sqlite'), 'Other instance data']]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  new Database(join(dirname(state), 'ownership.sqlite')).close();
  return { home, unit, files, config, state, otherUnit, dataDirectories };
}
const missing = path => assert.rejects(lstat(path), { code: 'ENOENT' });
try {
  for (const answer of [undefined, false, true]) {
    const fixture = await setup(`answer-${answer}`);
    const calls = [];
    let prompts = 0;
    const options = { run: async (file, args) => {
      assert.equal(file, 'systemctl');
      if (calls.length === 0) for (const path of fixture.files.keys()) assert.ok((await lstat(path)).isFile());
      else for (const path of fixture.files.keys()) await missing(path);
      calls.push(args);
    } };
    if (answer !== undefined) options.confirmDataRemoval = async directories => {
      assert.deepEqual(directories, fixture.dataDirectories);
      assert.equal(calls.length, 2);
      prompts++;
      return answer;
    };
    const result = await uninstallUserService(fixture.home, options);
    assert.deepEqual(calls, [['--user', 'disable', '--now', 'octopulse.service'], ['--user', 'daemon-reload']]);
    assert.deepEqual(result.removed, [...fixture.files.keys(), ...(answer === true ? fixture.dataDirectories : [])]);
    assert.equal(result.dataRemoved, answer === true);
    for (const path of fixture.files.keys()) await missing(path);
    if (answer === true) {
      for (const path of fixture.dataDirectories) await missing(path);
    } else {
      assert.equal(await readFile(fixture.config, 'utf8'), 'Synthetic config');
      assert.equal(await readFile(fixture.state, 'utf8'), 'Saved activity');
      assert.equal(await readFile(join(dirname(fixture.state), 'logs/day.jsonl'), 'utf8'), 'Saved logs');
      assert.equal(await readFile(join(dirname(fixture.state), 'cache/avatars/user.png'), 'utf8'), 'Cached avatar');
    }
    assert.equal(prompts, answer === undefined ? 0 : 1);
    assert.equal(await readFile(fixture.otherUnit, 'utf8'), 'Other instance');
    assert.equal(await readFile(join(fixture.home, '.local/state/octopulse-test/state.sqlite'), 'utf8'), 'Other instance data');
    for (const directory of ['.config', '.local/state', '.local/bin', '.local/share/applications']) assert.ok((await lstat(join(fixture.home, directory))).isDirectory());
    calls.length = 0;
    assert.deepEqual((await uninstallUserService(fixture.home, { run: async () => assert.fail('No unit to stop') })).removed, []);
  }

  for (const index of [0, 1, 2]) {
    const fixture = await setup(`unmanaged-${index}`);
    const paths = [...fixture.files.keys()];
    await writeFile(paths[index], 'User-owned file');
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    await assert.rejects(uninstallUserService(fixture.home, {
      run: async () => assert.fail('Ownership checks must precede service operations'),
      confirmDataRemoval: async () => assert.fail('Must not prompt'),
    }), /unmanaged file/);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
    assert.equal(await readFile(fixture.config, 'utf8'), 'Synthetic config');
  }

  const linked = await setup('symlink');
  const linkedUnit = linked.unit;
  const target = join(work, 'target.service');
  await writeFile(target, linked.files.get(linkedUnit));
  await rm(linkedUnit);
  await symlink(target, linkedUnit);
  await assert.rejects(uninstallUserService(linked.home, { run: async () => assert.fail('Must not stop a symlinked unit') }), /unmanaged file/);
  assert.ok((await lstat(linkedUnit)).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), linked.files.get(linkedUnit));

  const failed = await setup('systemctl-failure');
  await assert.rejects(uninstallUserService(failed.home, {
    run: async () => { throw Error('Systemd unavailable'); },
    confirmDataRemoval: async () => assert.fail('Must not prompt after failure'),
  }), /Systemd unavailable/);
  for (const [path, text] of failed.files) assert.equal(await readFile(path, 'utf8'), text);
  assert.equal(await readFile(failed.config, 'utf8'), 'Synthetic config');

  const partial = await setup('partial');
  await rm(partial.unit);
  for (const directory of partial.dataDirectories) await rm(directory, { recursive: true });
  assert.deepEqual((await uninstallUserService(partial.home, {
    run: async () => assert.fail('No unit to stop'),
    confirmDataRemoval: async () => assert.fail('No data to remove'),
  })).removed, [...partial.files.keys()].slice(1));

  const piped = await setup('noninteractive');
  for (const path of piped.files.keys()) await rm(path);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/uninstall-user-service.mjs', import.meta.url))], {
    env: { ...process.env, HOME: piped.home }, encoding: 'utf8', input: 'yes\n', timeout: 5000,
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /config and data kept/);
  assert.equal(await readFile(piped.config, 'utf8'), 'Synthetic config');
  assert.equal(await readFile(piped.state, 'utf8'), 'Saved activity');

  const stateOnly = await setup('state-only');
  await rm(stateOnly.dataDirectories[0], { recursive: true });
  assert.equal((await uninstallUserService(stateOnly.home, {
    run: async () => {}, confirmDataRemoval: async () => true,
  })).dataRemoved, true);
  await missing(stateOnly.dataDirectories[1]);

  const active = await setup('active-profile');
  const ownership = new Database(join(dirname(active.state), 'ownership.sqlite'));
  ownership.exec('BEGIN EXCLUSIVE');
  try {
    await assert.rejects(uninstallUserService(active.home, {
      run: async () => {}, confirmDataRemoval: async () => true,
    }), /stop any running Octopulse process/);
    assert.equal(await readFile(active.config, 'utf8'), 'Synthetic config');
    assert.equal(await readFile(active.state, 'utf8'), 'Saved activity');
  } finally { ownership.close(); }

  const linkedData = await setup('symlinked-data');
  const outside = join(work, 'outside-data');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'Unrelated data');
  for (const directory of linkedData.dataDirectories) {
    await rm(directory, { recursive: true });
    await symlink(outside, directory);
  }
  await uninstallUserService(linkedData.home, { run: async () => {}, confirmDataRemoval: async () => true });
  for (const directory of linkedData.dataDirectories) await missing(directory);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'Unrelated data');
  await assert.rejects(uninstallUserService('relative'), /Absolute single-line/);
  console.log('User service uninstall checks passed.');
} finally {
  await rm(work, { recursive: true, force: true });
}
