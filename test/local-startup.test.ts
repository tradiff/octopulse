import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { startApplication } from '../src/application.js';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { Snapshot } from '../src/model.js';
import { Profile } from '../src/profile.js';
import { completeSources, RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';

const T = '2026-10-23T12:00:00.000Z';
const config = parseConfig('[github]\ntoken="synthetic-local-startup"');
const emptySearch = () => Response.json({ total_count: 0, incomplete_results: false, items: [] });

test('saved PRs, activity, notification history, identity and teams serve while GitHub identity is blocked', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(T);
  const profile = new Profile(directory);
  profile.store.bindIdentity('alex', T);
  profile.store.setMetadata('teams', JSON.stringify(['acme/platform']));
  profile.store.setMetadata('discoveryComplete', T);
  const monitor = new Monitor(profile.store, clock, 'alex', ['acme/platform'], T);
  const snapshot = Snapshot.parse({ id: '101', number: 7, repository: 'acme/widget', title: 'Saved PR', author: 'bea', requestedReviewers: ['alex'] });
  monitor.track(snapshot, 'manual');
  await monitor.observe({ snapshot, sources: completeSources, events: [{ source: 'issue_comment', id: 'hello', kind: 'comment',
    actor: { login: 'bea' }, body: 'Saved comment', occurredAt: T }] });
  await monitor.stop(); profile.close();
  const requests: string[] = [];
  const desktop = new RecordingDesktop();
  const app = await startApplication(config, directory, clock, desktop, new AbortController().signal, 0, async url => {
    requests.push(url);
    return new Promise<Response>(() => {});
  });
  t.after(() => app.stop());
  assert.deepEqual(await (await fetch(app.origin + '/health')).json(), { status: 'ok' });
  assert.equal((await fetch(app.origin + '/')).status, 200);
  const me = await (await fetch(app.origin + '/api/me')).json() as { login: string; teams: string[]; actionToken: string };
  assert.equal(me.login, 'alex'); assert.deepEqual(me.teams, ['acme/platform']);
  const prs = await (await fetch(app.origin + '/api/pull-request-timeline')).text();
  assert.ok(prs.includes('Saved PR')); assert.ok(prs.includes('Saved comment'));
  const history = await (await fetch(app.origin + '/api/notification-history')).json() as { total: number };
  assert.ok(history.total > 0);
  assert.equal((await fetch(app.origin + '/api/logs')).status, 200);
  app.tick();
  assert.deepEqual(desktop.submissions, []);
  await assert.rejects(app.track('https://github.com/acme/widget/pull/8', new AbortController().signal), /not ready/);
  await assert.rejects(app.delivery.resend(1), /not ready/);
  assert.deepEqual(requests, ['https://api.github.com/user']);
  const untrack = await fetch(app.origin + '/api/tracked-pull-requests/101', { method: 'DELETE',
    headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken }, body: '{}' });
  assert.equal(untrack.status, 200);
  assert.equal(app.profile.store.pr('101')!.manualUntracked, true);
  await app.stop();
  const reopened = new Profile(directory); reopened.close();
});

test('fresh local health is listening before the first GitHub request, then background initialization completes', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let healthBeforeIdentity = false;
  const app = await startApplication(config, directory, new VirtualClock(T), new RecordingDesktop(), new AbortController().signal, port, async url => {
    if (url.endsWith('/user')) {
      healthBeforeIdentity = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
      await gate;
      return Response.json({ login: 'alex' });
    }
    if (url.includes('/user/teams')) return Response.json([{ slug: 'platform', organization: { login: 'acme' } }]);
    return emptySearch();
  });
  t.after(() => app.stop());
  const me = await (await fetch(app.origin + '/api/me')).json() as { login: string };
  assert.equal(me.login, '');
  const page = await (await fetch(app.origin + '/api/pull-request-timeline')).json() as { items: unknown[] };
  assert.deepEqual(page.items, []);
  release(); await app.initialize();
  assert.equal(healthBeforeIdentity, true);
  assert.equal(app.login, 'alex'); assert.deepEqual(app.teams, ['acme/platform']);
  assert.equal(app.profile.store.metadata('teams'), JSON.stringify(app.teams));
  assert.equal(app.profile.store.metadata('discoveryComplete'), T);
});

test('identity failure leaves saved data available and background initialization can retry without restarting', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory); profile.store.bindIdentity('alex', T); profile.close();
  let login = 'different';
  const clock = new VirtualClock(T);
  const requests: string[] = [];
  const app = await startApplication(config, directory, clock, new RecordingDesktop(), new AbortController().signal, 0, async url => {
    requests.push(url);
    if (url.endsWith('/user')) return Response.json({ login });
    if (url.includes('/user/teams')) return Response.json([]);
    return emptySearch();
  });
  t.after(() => app.stop());
  await assert.rejects(app.initialize(), /identity binding/);
  assert.equal((await fetch(app.origin + '/')).status, 200);
  const me = await (await fetch(app.origin + '/api/me')).json() as { login: string };
  assert.equal(me.login, 'alex');
  assert.deepEqual(requests, ['https://api.github.com/user']);
  login = 'alex'; clock.set('2026-10-23T12:05:00.000Z');
  app.tick(); await app.initialize();
  assert.equal(app.profile.store.metadata('discoveryComplete'), clock.now());
  assert.equal((await fetch(app.origin + '/health')).status, 200);
});

test('shutdown drains local request handlers before closing their profile', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory); profile.store.bindIdentity('alex', T); profile.close();
  const app = await startApplication(config, directory, new VirtualClock(T), new RecordingDesktop(), new AbortController().signal, 0,
    async () => new Promise<Response>(() => {}));
  t.after(() => app.stop());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let started!: () => void;
  const handlerStarted = new Promise<void>(resolve => { started = resolve; });
  let readAfterCancellation = false;
  app.delivery.resend = async () => {
    started(); await gate;
    readAfterCancellation = app.profile.store.metadata('login') === 'alex';
  };
  const me = await (await fetch(app.origin + '/api/me')).json() as { actionToken: string };
  const pending = fetch(app.origin + '/api/notification-records/1/resend', { method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken }, body: '{}' }).catch(() => undefined);
  await handlerStarted;
  let stopped = false;
  const stopping = app.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(app.profile.store.metadata('login'), 'alex');
  release(); await stopping; await pending;
  assert.equal(readAfterCancellation, true);
  const reopened = new Profile(directory); reopened.close();
});
