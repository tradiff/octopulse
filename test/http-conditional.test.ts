import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { listenLocal } from '../src/server.js';
import type { LocalApplication } from '../src/server.js';
import { webFixture } from './web-fixture.js';

test('conditional polling returns bodyless 304s without projecting stored pages or reading log contents', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const get = (path: string, etag?: string) => fetch(fixture.local.origin + path, { headers: etag ? { 'If-None-Match': etag } : {} });
  const tags = new Map<string, string>();
  for (const path of ['/api/pull-request-timeline', '/api/notification-history', '/api/logs', '/api/me', '/api/monitoring']) {
    const initial = await get(path);
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    const etag = initial.headers.get('etag')!; assert.match(etag, /^W\/"[\w-]+"$/);
    tags.set(path, etag);
    await initial.text();
    for (const validator of [etag, etag.slice(2), `"not-current", ${etag}`, '*']) {
      const response = await get(path, validator);
      assert.equal(response.status, 304);
      assert.equal(response.headers.get('etag'), etag);
      assert.equal(await response.text(), '');
    }
    assert.equal((await get(path, '"not-current"')).status, 200);
    assert.equal((await get(path + '?repo=missing/repo', etag)).status, 200, 'Validators are scoped to the complete URL');
  }
  t.mock.method(fixture.store, 'pullRequestPage', () => { throw new Error('PR projection should be skipped'); });
  t.mock.method(fixture.store, 'notificationPage', () => { throw new Error('History projection should be skipped'); });
  t.mock.method(fixture.logs, 'read', () => { throw new Error('Log contents should not be read'); });
  for (const path of ['/api/pull-request-timeline', '/api/notification-history', '/api/logs']) {
    assert.equal((await get(path, tags.get(path))).status, 304);
  }
  t.mock.restoreAll();
  const restarted = await listenLocal(fixture, 0); t.after(() => restarted.stop());
  assert.equal((await fetch(restarted.origin + '/api/pull-request-timeline', { headers: { 'If-None-Match': tags.get('/api/pull-request-timeline')! } })).status, 200,
    'A new server never reuses validators from a previous instance');
  assert.equal((await get('/api/settings')).headers.get('etag'), null, 'Settings are not conditionally cached');
});

test('database changes, identity and monitoring state invalidate conditional views', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const app: LocalApplication = { ...fixture, monitoring: { state: 'ready', since: fixture.clock.now() } };
  const local = await listenLocal(app, 0); t.after(() => local.stop());
  const tags = new Map<string, string>();
  const get = async (path: string) => {
    const previous = tags.get(path);
    const response = await fetch(local.origin + path, { headers: previous ? { 'If-None-Match': previous } : {} });
    if (response.status === 200) tags.set(path, response.headers.get('etag')!);
    return response;
  };
  for (const path of ['/api/pull-request-timeline', '/api/notification-history', '/api/me', '/api/monitoring']) {
    assert.equal((await get(path)).status, 200);
  }
  const original = fixture.store.pr('A')!;
  fixture.store.savePr({ ...original, snapshot: { ...original.snapshot, title: 'Changed in database' } });
  for (const path of ['/api/pull-request-timeline', '/api/notification-history']) {
    const response = await get(path); assert.equal(response.status, 200); assert.match(await response.text(), /Changed in database/);
    assert.equal((await get(path)).status, 304);
  }
  const activity = fixture.store.activities('A')[0]!;
  fixture.store.saveActivity('A', { ...activity, event: { ...activity.event, id: 'new-activity' } });
  assert.equal((await get('/api/pull-request-timeline')).status, 200, 'Activity updates invalidate PR summaries');
  fixture.monitor.teams.push('acme/new-team');
  assert.equal((await get('/api/pull-request-timeline')).status, 200, 'Queue membership is part of the validator');
  app.teams.push('acme/new-team');
  assert.equal((await get('/api/me')).status, 200);
  app.monitoring = { state: 'authentication_failed', since: fixture.clock.now() };
  for (const path of ['/api/me', '/api/monitoring']) {
    const response = await get(path); assert.equal(response.status, 200); assert.match(await response.text(), /authentication_failed/);
  }
  const external = new Database(join(fixture.directory, 'state.sqlite')); t.after(() => external.close());
  external.prepare('UPDATE pull_requests SET data = ? WHERE id = ?').run(JSON.stringify(original), 'A');
  assert.equal((await get('/api/pull-request-timeline')).status, 200, 'Writes through another connection invalidate views');
  fixture.monitor.untrack('A');
  assert.equal((await get('/api/pull-request-timeline')).status, 200);
  assert.equal((await get('/api/notification-history')).status, 200);
});

test('log validators detect writes, external edits and retention deletions', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const url = fixture.local.origin + '/api/logs';
  let etag = (await fetch(url)).headers.get('etag')!;
  const changed = async () => {
    const response = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(response.status, 200); assert.notEqual(response.headers.get('etag'), etag);
    etag = response.headers.get('etag')!;
    return response;
  };
  fixture.logs.write('info', 'A new diagnostic');
  assert.match(await (await changed()).text(), /A new diagnostic/);
  const path = join(fixture.directory, 'logs', '2026-10-22.jsonl');
  await writeFile(path, JSON.stringify({ at: fixture.clock.now(), level: 'info', message: 'External edit' }) + '\n');
  assert.match(await (await changed()).text(), /External edit/);
  await unlink(path);
  assert.deepEqual(await (await changed()).json(), { items: [] });
});
