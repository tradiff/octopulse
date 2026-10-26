import assert from 'node:assert/strict';
import { rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Settings } from '../src/settings.js';
import { Profile } from '../src/profile.js';
import { startApplication } from '../src/application.js';
import { temporaryProfile, VirtualClock, RecordingDesktop } from './fixture.js';

test('database settings round-trip all values and preserve secrets without exposing them', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  let profile = new Profile(directory); t.after(() => profile.close());
  let settings = new Settings(profile.store, undefined, { GITHUB_TOKEN: 'environment-secret' });
  settings.update({ github: { token: 'saved-secret' },
    system_one: { base_url: 'https://provider.example/v1', api_key: 'provider-secret', model: 'custom-model' },
    timings: { tracked_poll_interval: '30s' }, logging: { level: 'debug' } });
  const { token_source, environment_detected, token_preview } = settings.view().github;
  assert.deepEqual({ token_source, environment_detected, token_preview }, { token_source: 'database', environment_detected: true, token_preview: '********************ret' });
  assert.ok(!JSON.stringify(settings.view()).includes('secret'));
  assert.equal(settings.view().system_one!.api_key_preview, '********************ret');
  assert.ok(!profile.store.metadata('settings')!.includes('environment-secret'));
  const view = settings.view();
  const body = { ...view, github: {}, system_one: { base_url: view.system_one!.base_url, model: 'replacement' } };
  settings.update(body);
  assert.equal(settings.effective().system_one!.api_key, 'provider-secret');
  assert.equal(settings.effective().system_one!.base_url, 'https://provider.example/v1/systemone');
  assert.equal(settings.effective().github.token, 'saved-secret');
  assert.equal(settings.effective().timings.tracked_poll_interval, 30_000);
  const before = profile.store.metadata('settings');
  for (const invalid of [{ ...body, timings: { tracked_poll_interval: '0s' } }, { ...body, unknown: true },
    { ...body, system_one: { base_url: 'file:///secret', model: 'model' } }, { ...body, github: { token: '' } },
    { ...body, github: { token: settings.view().github.token_preview } },
    { ...body, system_one: { ...body.system_one, api_key: settings.view().system_one!.api_key_preview } }]) {
    assert.throws(() => settings.update(invalid)); assert.equal(profile.store.metadata('settings'), before);
  }
  profile.close(); profile = new Profile(directory);
  settings = new Settings(profile.store, undefined, {});
  assert.equal(settings.effective().system_one!.model, 'replacement');
  assert.equal(settings.effective().github.token, 'saved-secret');
});

test('System One keys can be replaced, preserved or cleared without losing provider configuration', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  let profile = new Profile(directory); t.after(() => profile.close());
  let settings = new Settings(profile.store, undefined, {});
  const provider = { base_url: 'https://provider.example', model: 'custom-model' };
  const update = (key: { api_key?: string | null }) => settings.update({ github: {}, system_one: { ...provider, ...key } });
  update({});
  assert.equal(settings.view().system_one!.api_key_preview, '');
  assert.equal(settings.effective().system_one, undefined);
  update({ api_key: 'provider-secret' });
  assert.equal(settings.effective().system_one!.api_key, 'provider-secret');
  update({});
  assert.equal(settings.effective().system_one!.api_key, 'provider-secret');
  update({ api_key: 'replacement-secret' });
  assert.equal(settings.effective().system_one!.api_key, 'replacement-secret');
  update({ api_key: null });
  assert.ok(!profile.store.metadata('settings')!.includes('replacement-secret'));
  assert.equal(settings.effective().system_one, undefined, 'Classification is unavailable without a key');
  assert.deepEqual(settings.view().system_one, { ...provider, api_key_preview: '' });
  profile.close(); profile = new Profile(directory); settings = new Settings(profile.store, undefined, {});
  assert.deepEqual(settings.view().system_one, { ...provider, api_key_preview: '' });
  assert.equal(settings.effective().system_one, undefined);
});

test('environment credential is ephemeral, override wins, clearing restores fallback and no token is allowed', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory); t.after(() => profile.close());
  let settings = new Settings(profile.store, undefined, { GITHUB_TOKEN: 'environment-secret' });
  const body = () => { const view = settings.view(); return { ...view, github: {}, system_one: null }; };
  assert.equal(settings.view().github.token_source, 'environment');
  assert.equal(settings.view().github.token_preview, '********************ret');
  assert.equal(settings.effective().github.token, 'environment-secret');
  assert.ok(!profile.store.metadata('settings')!.includes('environment-secret'));
  settings.update({ ...body(), github: { token: 'override-secret' } });
  assert.equal(settings.effective().github.token, 'override-secret');
  assert.equal(settings.view().github.token_source, 'database');
  settings.update({ ...body(), github: { token: null } });
  assert.equal(settings.effective().github.token, 'environment-secret');
  settings.update({ ...body(), github: { token: 'environment-secret' } });
  assert.ok(!profile.store.metadata('settings')!.includes('environment-secret'));
  settings = new Settings(profile.store, undefined, {});
  assert.equal(settings.effective().github.token, ''); assert.equal(settings.view().github.token_source, 'none');
  assert.equal(settings.view().github.environment_detected, false);
  assert.equal(settings.view().github.token_preview, '');
  settings.update({ ...body(), github: { token: 'abc' } });
  assert.equal(settings.view().github.token_preview, '********************');
  settings.update({ ...body(), github: { token: null } });
  assert.equal(settings.view().github.token_preview, '');
  assert.equal(settings.effective().github.token, '');
});

test('settings API authorizes mutations, starts unconfigured and applies credentials without restarting', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials: string[] = [];
  const app = await startApplication(undefined, directory, new VirtualClock('2026-10-25T12:00:00Z'), new RecordingDesktop(),
    new AbortController().signal, 0, async (url, options) => {
      credentials.push(new Headers(options?.headers).get('authorization')!);
      if (url.endsWith('/user')) return Response.json({ login: 'alex' });
      if (url.includes('/user/teams')) return Response.json([]);
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    });
  t.after(() => app.stop());
  assert.equal((await fetch(app.origin + '/settings')).status, 200);
  await app.initialize(); assert.deepEqual(credentials, []);
  const me = await (await fetch(app.origin + '/api/me')).json() as { actionToken: string };
  const body = { ...app.settings.view(), github: { token: 'override-secret' } };
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken };
  const put = (value: unknown, auth = headers) => fetch(app.origin + '/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify(value) });
  assert.equal((await put(body, { ...headers, Origin: 'https://attacker.example' })).status, 403);
  assert.equal(app.settings.view().github.token_source, 'none');
  const response = await put(body); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('override-secret'));
  await app.initialize(); assert.equal(app.login, 'alex'); assert.ok(credentials.every(value => value === 'Bearer override-secret'));
  credentials.length = 0;
  assert.equal((await put({ ...body, github: { token: 'replacement-secret' }, timings: { tracked_poll_interval: '2m' }, logging: { level: 'error' } })).status, 200);
  await app.initialize(); assert.ok(credentials.length > 0); assert.ok(credentials.every(value => value === 'Bearer replacement-secret'));
  assert.equal(app.settings.effective().timings.tracked_poll_interval, 120_000);
  const before = app.profile.store.metadata('settings');
  assert.equal((await put({ ...body, timings: { grace_period: 'bad' } })).status, 400);
  assert.equal(app.profile.store.metadata('settings'), before);
  await app.stop();
  const profile = new Profile(directory);
  const settings = new Settings(profile.store, undefined, { GITHUB_TOKEN: 'environment-secret' });
  assert.equal(settings.effective().github.token, 'replacement-secret'); profile.close();
});

test('runtime environment token is used in requests but absent from profile files and API', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: string[] = [];
  const app = await startApplication(undefined, directory, new VirtualClock('2026-10-25T12:00:00Z'), new RecordingDesktop(),
    new AbortController().signal, 0, async (url, options) => {
      requests.push(url);
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ephemeral-environment-secret');
      if (url.endsWith('/user')) return Response.json({ login: 'alex' });
      if (url.includes('/user/teams')) return Response.json([]);
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    }, { GITHUB_TOKEN: 'ephemeral-environment-secret' });
  t.after(() => app.stop()); await app.initialize();
  assert.ok(requests.includes('https://api.github.com/user'), 'Environment credentials must initialize GitHub identity');
  const response = await (await fetch(app.origin + '/api/settings')).text();
  assert.ok(response.includes('environment')); assert.ok(!response.includes('ephemeral-environment-secret'));
  app.logs.write('error', 'Test redaction', { secret: 'ephemeral-environment-secret' });
  await app.stop();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.ok(!(await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from('ephemeral-environment-secret')), entry.name);
  }
});
