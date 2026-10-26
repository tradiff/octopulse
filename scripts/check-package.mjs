import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const archive = process.argv[2];
if (!archive) throw new Error('Specify an Octopulse package archive');
const work = await mkdtemp('/tmp/opencode/octopulse-package-check-');
try {
  await execute('tar', ['-xzf', resolve(archive), '-C', work]);
  const bundle = join(work, 'octopulse');
  const { installPackage } = await import(pathToFileURL(join(bundle, 'scripts/install.mjs')).href);
  const commands = [];
  const home = join(work, 'disposable home');
  const installed = await installPackage(bundle, home, { activate: true }, async args => {
    commands.push(args);
  });
  assert.ok((await readFile(installed.identity, 'utf8')).includes(`Icon=${join(installed.prefix, 'assets/octopulse-mark-small-white.svg')}\n`));
  await installPackage(bundle, home, { activate: true }, async args => {
    commands.push(args);
  });
  assert.equal(commands.length, 4);
  const node = join(installed.prefix, 'runtime/bin/node');
  const probe = `
    import assert from 'node:assert/strict';
    import { startApplication } from './dist/src/application.js';
    import { SessionBus } from './dist/src/session-bus.js';
    import { readFile } from 'node:fs/promises';
    import Database from 'better-sqlite3';
    import sharp from 'sharp';
    import { AvatarCache } from './dist/src/desktop.js';
    import { fileURLToPath } from 'node:url';

    const db = new Database(':memory:');
    if (db.prepare('select 42 value').get().value !== 42 || !SessionBus) throw Error('Native load failed');
    db.close();

    const source = await sharp({
      create: { width: 512, height: 512, channels: 3, background: '#2096aa' },
    }).jpeg().toBuffer();
    const avatars = new AvatarCache(
      process.argv[1] + '/avatars',
      { now: () => new Date().toISOString() },
      async () => new Response(source),
    );
    const image = await avatars.image('https://synthetic.invalid/large.jpg', new AbortController().signal);
    if (!image) throw Error('Packaged avatar conversion failed');
    const metadata = await sharp(await readFile(fileURLToPath(image))).metadata();
    if (metadata.width !== 18 || metadata.height !== 18 || metadata.format !== 'png') {
      throw Error('Packaged avatar dimensions failed');
    }
    for (const file of ['octopulse-mark-blue.svg', 'octopulse-mark-small-white.svg', 'octopulse-mark-small-blue.svg']) {
      await sharp(await readFile('./assets/' + file)).resize(22, 22).png().toBuffer();
    }

    const start = environment => startApplication(
      undefined,
      process.argv[1],
      { now: () => new Date().toISOString() },
      { submit: async () => 'sent' },
      new AbortController().signal,
      0,
      async url => new Response(JSON.stringify(
        url.endsWith('/user') ? { login: 'alex' } : url.includes('/user/teams') ? [] : { total_count: 0, incomplete_results: false, items: [] },
      )),
      environment,
    );
    const app = await start({ GITHUB_TOKEN: 'synthetic-environment-token' });
    await app.initialize();
    for (const path of ['/health', '/', '/app.js', '/app.css', '/icon.svg', '/notification-history', '/logs', '/settings', '/api/settings']) {
      if ((await fetch(app.origin + path)).status !== 200) throw Error('Packaged route failed');
    }
    if (await (await fetch(app.origin + '/icon.svg')).text() !== await readFile('./assets/octopulse-mark-blue.svg', 'utf8')) {
      throw Error('Packaged header differs from the application mark');
    }
    if (await (await fetch(app.origin + '/favicon.svg')).text() !== await readFile('./assets/octopulse-mark-small-blue.svg', 'utf8')) {
      throw Error('Packaged favicon differs from the small blue mark');
    }
    const me = await (await fetch(app.origin + '/api/me')).json();
    const update = await fetch(app.origin + '/api/settings', { method: 'PUT',
      headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken },
      body: JSON.stringify({ github: { token: 'synthetic-saved-token' }, logging: { retention: '7 days' } }) });
    assert.equal(update.status, 200);
    assert.ok(!(await update.text()).includes('synthetic-saved-token'));
    await app.stop();
    const reopened = await start({});
    await reopened.initialize();
    assert.equal(reopened.settings.effective().github.token, 'synthetic-saved-token');
    assert.equal(reopened.settings.view().logging.retention, '7 days');
    assert.ok(!reopened.profile.store.metadata('settings').includes('synthetic-environment-token'));
    await reopened.stop();
    console.log(JSON.stringify({ node: process.version, native: 'loaded', routes: 'pass', settings: 'persisted', shutdown: 'pass' }));
  `;
  const result = await execute(node, ['--input-type=module', '-e', probe, join(home, '.local/state/disposable-profile')], {
    cwd: installed.prefix,
    env: { HOME: home, PATH: '/nonexistent' },
    timeout: 30_000,
  });
  assert.equal(JSON.parse(result.stdout).node, 'v24.22.1');
  await execute('systemd-analyze', ['--user', 'verify', installed.unit], { env: { ...process.env, HOME: home }, timeout: 30_000 });
  console.log('Packaged Node 24.22.1, SQLite, avatar resizing, HTTP assets, shutdown, database settings persistence, and systemd unit validation passed without a runtime PATH or compiler.');
} finally {
  await rm(work, { recursive: true, force: true });
}
