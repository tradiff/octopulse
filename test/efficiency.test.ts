import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Collector } from '../src/collector.js';
import { Delivery } from '../src/delivery.js';
import { AvatarCache, DesktopAdapter } from '../src/desktop.js';
import type { DesktopMessage } from '../src/desktop.js';
import { Monitor } from '../src/monitor.js';
import { Notification, Snapshot } from '../src/model.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { parseConfig } from '../src/config.js';
import { startRuntime } from '../src/runtime.js';
import { startApplication } from '../src/application.js';
import { avatarPng, completeSources, RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';

const T = '2026-10-22T12:00:00.000Z';
const snapshot = Snapshot.parse({ id: 'A', repository: 'acme/widget', number: 7, title: 'Synthetic PR', author: 'alex', head: 'head' });
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const emptySearch = () => json({ total_count: 0, incomplete_results: false, items: [] });
const notification = (prId = 'A') => Notification.parse({
  intent: { prId, kind: 'immediate', events: [], title: 'Synthetic notification', body: 'Body', destination: 'https://github.com/acme/widget/pull/7', expiryMs: 0, sound: null },
  createdAt: T, preparedAt: T, status: 'pending', deliveredAt: null, attempts: 0, nextAttemptAt: T, runningAt: null, automatic: true, reason: null,
});

async function setup(t: TestContext) {
  const directory = await temporaryProfile();
  const path = join(directory, 'state.sqlite');
  const store = new Store(path);
  const clock = new VirtualClock(T);
  const monitor = new Monitor(store, clock, 'alex', [], T);
  monitor.track(snapshot, 'manual');
  t.after(async () => { await monitor.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, store, clock, monitor };
}

test('60 unchanged polls with 100 CI jobs add no observation rows or serialized payload', async t => {
  const { store, path, clock, monitor } = await setup(t);
  const jobs = Array.from({ length: 100 }, (_, i) => ({ id: String(i), runId: 'run', attempt: 1, head: 'head', name: `Job ${i}`, status: 'completed', conclusion: 'success' }));
  let jobRequests = 0;
  const collector = new Collector(store, clock, { async request(_pr, request) {
    if (request.validator) return { status: 304 };
    if (request.resource === 'jobs') jobRequests++;
    return { status: 200, next: null, validator: request.resource, items: request.resource === 'detail' ? [snapshot]
      : request.resource === 'workflows' ? [{ id: 'run', workflowId: 'build', trigger: 'push', runNumber: 1, attempt: 1,
        head: 'head', name: 'Build', updatedAt: T, status: 'completed', conclusion: 'success' }]
      : request.resource === 'jobs' ? jobs : [] };
  } });
  const poll = () => monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  await poll();
  const db = new Database(path); t.after(() => db.close());
  const size = () => db.prepare('SELECT count(*) count, sum(length(data)) bytes FROM observations').get();
  const before = size();
  for (let i = 0; i < 60; i++) await poll();
  t.diagnostic(JSON.stringify({ before, after: size() }));
  assert.deepEqual(size(), before);
  assert.equal(jobRequests, 1);
  assert.equal(store.pr('A')!.baselineComplete, true);
  assert.equal(store.pr('A')!.ci.head!.selected[0]!.jobs.length, 100);
  assert.equal(store.notifications().length, 0);
});

test('idle delivery work does not read or parse 10,000 sent notifications', async t => {
  const { store, path, clock } = await setup(t);
  const sent = { ...notification(), status: 'sent' as const, deliveredAt: T, nextAttemptAt: null };
  store.transaction(() => { for (let i = 0; i < 10_000; i++) store.insertNotification(sent); });
  const read = t.mock.method(store, 'notification');
  const history = t.mock.method(store, 'notifications');
  const ids = t.mock.method(store, 'notificationIds');
  const delivery = new Delivery(store, clock, new RecordingDesktop());
  const started = performance.now();
  delivery.recover();
  await delivery.runDue();
  t.diagnostic(JSON.stringify({ sentRecords: 10_000, recordReads: read.mock.callCount(), elapsedMs: performance.now() - started }));
  assert.equal(read.mock.callCount(), 0);
  assert.equal(history.mock.callCount(), 0);
  assert.equal(ids.mock.callCount(), 0);
  const prepare = Database.prototype.prepare;
  const queries: string[] = [];
  const trace = t.mock.method(Database.prototype, 'prepare', function(this: Database.Database, sql: string) {
    queries.push(sql); return prepare.call(this, sql);
  });
  await delivery.runDue();
  trace.mock.restore();
  const dueQuery = queries.find(sql => /SELECT id FROM notifications/.test(sql));
  assert.ok(dueQuery);
  const db = new Database(path); t.after(() => db.close());
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + dueQuery).all(clock.now(), 4) as { detail: string }[];
  assert.ok(plan.some(row => /SEARCH notifications USING.*notifications_delivery_due/.test(row.detail)), JSON.stringify(plan));
  assert.ok(plan.every(row => !/SCAN notifications|TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
});

test('an unchanged collection still commits previously interrupted decisions exactly once', async t => {
  const { store, clock, monitor, path } = await setup(t);
  const collector = new Collector(store, clock, { async request(_pr, request) {
    return request.validator ? { status: 304 }
      : { status: 200, next: null, validator: 'cached', items: request.resource === 'detail' ? [snapshot] : [] };
  } });
  const poll = () => monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  await poll();
  const db = new Database(path); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'interrupted decision'); END");
  await assert.rejects(monitor.observe({ snapshot, sources: completeSources, events: [
    { source: 'issue_comment', id: 'recover', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: 'Recover me' },
  ] }), /interrupted decision/);
  assert.equal(store.staged('A', 1).length, 1);
  db.exec('DROP TRIGGER fail_decision');
  await poll(); await poll();
  assert.equal(store.staged('A', 1).length, 0);
  assert.equal(store.activities('A').filter(item => item.event.id === 'recover').length, 1);
  assert.equal(store.notifications().length, 1);
  assert.equal(store.notification(1).intent.body.includes('Recover me'), true);
});

test('a failed later workflow page retains earlier workflow observations for recovery', async t => {
  const { store, monitor, clock } = await setup(t);
  const collector = new Collector(store, clock, { async request(_pr, request) {
    if (request.resource === 'workflows' && request.page === 2) throw new Error('Later page unavailable');
    return { status: 200, validator: 'page', next: request.resource === 'workflows' ? 2 : null,
      items: request.resource === 'detail' ? [snapshot] : request.resource === 'workflows'
        ? [{ id: 'first-run', workflowId: 'build', trigger: 'push', runNumber: 1, attempt: 1,
          head: 'head', name: 'Build', updatedAt: T, status: 'completed', conclusion: 'success' }] : [] };
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)), /Later page/);
  assert.equal(store.pr('A')!.baselineComplete, false);
  assert.deepEqual(store.pr('A')!.fetchState.pages, {});
  assert.deepEqual(store.staged('A', 1).flatMap(batch => batch.data.observation.workflows?.map(run => run.id) ?? []), ['first-run']);
});

test('indexed delivery handles exact deadlines, offset timestamps, expiration, and cancellation', async t => {
  const { store, clock } = await setup(t);
  const desktop = new RecordingDesktop();
  const due = store.insertNotification({ ...notification(), nextAttemptAt: '2026-10-22T14:00:00+02:00' });
  const future = store.insertNotification({ ...notification(), nextAttemptAt: '2026-10-22T12:00:00.001Z' });
  const expired = store.insertNotification({ ...notification(), preparedAt: '2026-10-21T14:00:00+02:00', nextAttemptAt: '2026-10-23T12:00:00Z' });
  const stranded = store.insertNotification({ ...notification(), preparedAt: '2026-10-21T12:00:00Z', nextAttemptAt: null });
  const canceled = store.insertNotification({ ...notification(), automatic: false, reason: 'untracked' });
  const delivery = new Delivery(store, clock, desktop);
  await delivery.runDue();
  assert.equal(store.notification(due).status, 'sent');
  assert.equal(store.notification(future).attempts, 0);
  for (const id of [expired, stranded]) {
    assert.equal(store.notification(id).reason, 'expired');
    assert.equal(store.notification(id).automatic, false);
    assert.equal(store.attempts(id).length, 0);
  }
  assert.equal(store.notification(canceled).reason, 'untracked');
  assert.equal(desktop.submissions.length, 1);
  clock.set('2026-10-22T12:00:00.001Z'); await delivery.runDue();
  assert.equal(store.notification(future).status, 'sent');
});

test('scheduler delivers newly prepared unrelated notifications while an earlier submission is blocked', async t => {
  const { store, clock, monitor } = await setup(t);
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const calls: string[] = [];
  let active = 0; let peak = 0;
  const delivery = new Delivery(store, clock, { async submit(intent) {
    calls.push(intent.prId); active++; peak = Math.max(peak, active);
    if (intent.prId === 'A') { began(); return new Promise(() => {}); }
    await turn(); active--; return 'sent';
  } });
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async poll() { throw new Error('Poll is not due'); }, async discover() { throw new Error('Discovery is not due'); },
    report(error) { throw error; },
  });
  t.after(() => scheduler.stop());
  store.insertNotification(notification()); scheduler.tick(); await started;
  for (let i = 0; i < 8; i++) {
    const id = `other-${i}`; monitor.track({ ...snapshot, id, number: i + 10 }, 'manual'); store.insertNotification(notification(id));
  }
  scheduler.tick();
  for (let i = 0; i < 30; i++) await turn();
  assert.equal(store.notifications().filter(row => row.data.status === 'sent').length, 8);
  assert.ok(peak <= 4, `peak submissions: ${peak}`);
  assert.deepEqual(calls, ['A', ...Array.from({ length: 8 }, (_, i) => `other-${i}`)]);
});

test('avatar requests share in-flight work and suppress repeated failed lookups', async t => {
  const { directory, clock } = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const cache = new AvatarCache(join(directory, 'avatars'), clock, async () => { calls++; await gate; return json({}, 503); });
  const a = cache.image('https://avatars.example/shared.png', signal());
  const b = cache.image('https://avatars.example/shared.png', signal());
  await delay(30); release();
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  await cache.image('https://avatars.example/shared.png', signal());
  assert.equal(calls, 1);
  clock.set('2026-10-22T12:01:01Z');
  await cache.image('https://avatars.example/shared.png', signal());
  assert.equal(calls, 2);
});

test('manual resends share the automatic concurrency bound, coalesce, and cancel queued work on stop', async t => {
  const { store, clock } = await setup(t);
  let active = 0;
  const delivery = new Delivery(store, clock, { async submit() { active++; return new Promise(() => {}); } });
  t.after(() => delivery.stop());
  const ids = Array.from({ length: 8 }, () => store.insertNotification(notification()));
  const automatic = delivery.runDue();
  const resends = ids.flatMap(id => [delivery.resend(id), delivery.resend(id)]);
  await turn();
  assert.equal(active, 4);
  assert.equal(store.notifications().reduce((sum, row) => sum + row.data.attempts, 0), 4);
  await delivery.stop(); await automatic; await Promise.all(resends);
  assert.equal(store.notifications().filter(row => row.data.reason === 'ambiguous').length, 4);
  assert.equal(store.notifications().filter(row => row.data.attempts === 0).length, 4);
});

test('canceling one avatar waiter does not cancel another notification sharing its image', async t => {
  const { directory, clock } = await setup(t);
  let release!: () => void; let begin!: () => void; let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { begin = resolve; });
  let upstream: AbortSignal | null | undefined;
  const cache = new AvatarCache(join(directory, 'avatars'), clock, async (_url, init) => {
    calls++; upstream = init.signal; begin(); await gate;
    return new Response(avatarPng);
  });
  const canceled = new AbortController();
  const first = cache.image('https://avatars.example/shared.png', canceled.signal);
  const second = cache.image('https://avatars.example/shared.png', signal());
  await started; canceled.abort();
  assert.equal(await first, null); assert.equal(upstream?.aborted, false);
  release(); assert.match((await second)!, /^file:/); assert.equal(calls, 1);
});

test('optional avatar loading is bounded and cannot hold text delivery behind slow images', async t => {
  const { directory, clock, store, monitor } = await setup(t);
  await monitor.observe({ snapshot, sources: completeSources, events: [] });
  const current = { ...snapshot, authorAvatar: 'https://avatars.example/0.png' };
  await monitor.observe({ snapshot: current, sources: completeSources, events: Array.from({ length: 12 }, (_, i) => ({
    source: 'issue_comment', id: String(i), kind: 'comment', occurredAt: T,
    actor: { login: `person-${i}`, avatar: `https://avatars.example/${i}.png` }, body: `Comment ${i}`,
  })) });
  const requests: string[] = []; let active = 0; let peak = 0;
  const cache = new AvatarCache(join(directory, 'avatars'), clock, async (url, init) => {
    requests.push(url); active++; peak = Math.max(peak, active);
    init.signal!.addEventListener('abort', () => { active--; }, { once: true });
    return new Promise(() => {});
  });
  let body = '';
  const adapter = new DesktopAdapter(store, 'alex', {
    async capabilities() { return ['body-markup', 'body-images']; },
    async notify(message) { body = message.body; return 1; },
  }, cache);
  const controller = new AbortController(); t.after(() => controller.abort());
  const result = adapter.submit(store.notification(1).intent, controller.signal);
  const timeout = new AbortController();
  const outcome = await Promise.race([result, delay(1000, 'timed out', { signal: timeout.signal })]);
  timeout.abort();
  assert.equal(outcome, 'sent');
  assert.match(body, /Comment 11/);
  assert.ok(peak <= 4, `peak avatar requests: ${peak}`);
  assert.equal(peak, 4);
  assert.equal(new Set(requests).size, requests.length);
  controller.abort();
  await turn(); assert.equal(active, 0);
});

test('desktop renders the current PR title once with rich and plain capability fallbacks', async t => {
  const { store, monitor } = await setup(t);
  await monitor.observe({ snapshot, sources: completeSources, events: [] });
  await monitor.observe({ snapshot, sources: completeSources, events: [{
    source: 'issue_comment', id: 'comment', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: 'Please check this change',
  }] });
  const saved = store.notification(1).intent;
  for (const title of [snapshot.title, 'Updated title']) {
    await monitor.observe({ snapshot: { ...snapshot, title, draft: true }, sources: completeSources, events: [] });
    for (const capabilities of [[], ['body-markup']]) {
      let sent!: DesktopMessage;
      const adapter = new DesktopAdapter(store, 'alex', {
        async capabilities() { return capabilities; }, async notify(message) { sent = message; return 1; },
      });
      assert.equal(await adapter.submit(saved, signal()), 'sent');
      assert.equal(`${sent.summary}\n${sent.body}`.split(title).length - 1, 1);
      if (capabilities.includes('body-markup')) {
        assert.equal(sent.summary, '');
        assert.equal(sent.body, `[acme/widget] ${title} (draft)<br/>&#160;<br/><b>bea</b>: 💬 Please check this change`);
      } else assert.equal(sent.body, saved.body);
      assert.equal(store.notification(1).intent.title, saved.title);
    }
  }
});

test('cold author and actor avatars survive a download longer than 150 ms', async t => {
  const { directory, clock, store, monitor } = await setup(t);
  await monitor.observe({ snapshot, sources: completeSources, events: [] });
  await monitor.observe({ snapshot: { ...snapshot, authorAvatar: 'https://avatars.example/author.png' }, sources: completeSources, events: [{
    source: 'issue_comment', id: 'comment', kind: 'comment', occurredAt: T,
    actor: { login: 'bea', avatar: 'https://avatars.example/actor.png' }, body: 'Please check this change',
  }] });
  const cache = new AvatarCache(join(directory, 'avatars'), clock, async (_url, init) => {
    await delay(250, undefined, { signal: init.signal! });
    return new Response(avatarPng);
  });
  let body = '';
  const adapter = new DesktopAdapter(store, 'alex', {
    async capabilities() { return ['body-markup', 'body-images']; }, async notify(message) { body = message.body; return 1; },
  }, cache);
  assert.equal(await adapter.submit(store.notification(1).intent, signal()), 'sent');
  assert.equal((body.match(/<img src="file:/g) ?? []).length, 2);
});

test('avatars slower than the notification budget finish caching for the next delivery', async t => {
  const { directory, clock, store, monitor } = await setup(t);
  await monitor.observe({ snapshot, sources: completeSources, events: [] });
  const url = 'https://avatars.example/author.png';
  await monitor.observe({ snapshot: { ...snapshot, authorAvatar: url }, sources: completeSources, events: [{
    source: 'issue_comment', id: 'comment', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: 'Please check this change',
  }] });
  let release!: () => void; let calls = 0; let upstream: AbortSignal | null | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const cache = new AvatarCache(join(directory, 'avatars'), clock, async (_url, init) => {
    calls++; upstream = init.signal; await gate; init.signal!.throwIfAborted();
    return new Response(avatarPng);
  });
  let body = '';
  const adapter = new DesktopAdapter(store, 'alex', {
    async capabilities() { return ['body-markup', 'body-images']; }, async notify(message) { body = message.body; return 1; },
  }, cache);
  assert.equal(await adapter.submit(store.notification(1).intent, signal()), 'sent');
  assert.doesNotMatch(body, /<img/);
  assert.equal(upstream?.aborted, false);
  release();
  assert.match((await cache.image(url, signal()))!, /^file:/);
  assert.equal(await adapter.submit(store.notification(1).intent, signal()), 'sent');
  assert.match(body, /<img src="file:/);
  assert.equal(calls, 1);
});

test('initialized restart serves saved state and recovers delivery during a discovery outage', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(T);
  const config = parseConfig('[github]\ntoken="synthetic-secret"\n');
  let offline = false;
  const fetch = async (url: string) => {
    if (url.endsWith('/user')) return json({ login: 'alex' });
    if (url.includes('/user/teams')) return json([]);
    if (offline) return json({}, 503);
    if (url.includes('/search/issues')) return emptySearch();
    if (url.endsWith('/pulls/7')) return json({ id: 101, number: 7, title: snapshot.title, user: { login: 'alex' }, state: 'open', draft: false,
      merged_at: null, closed_at: null, updated_at: T, head: { sha: 'head' }, base: { ref: 'main', repo: { full_name: 'acme/widget' } },
      requested_reviewers: [], requested_teams: [] });
    if (url.includes('/actions/runs')) return json({ total_count: 0, workflow_runs: [] });
    return json([]);
  };
  const first = await startRuntime(config, directory, clock, new RecordingDesktop(), signal(), fetch);
  first.monitor.track({ ...snapshot, id: '101' }, 'manual');
  first.profile.store.insertNotification(notification('101'));
  const interrupted = first.profile.store.insertNotification({ ...notification('101'), attempts: 1, runningAt: T, nextAttemptAt: null });
  first.profile.store.insertAttempt(interrupted, { startedAt: T, finishedAt: null, result: 'running' });
  await first.stop(); offline = true;
  const desktop = new RecordingDesktop();
  const restarted = await startApplication(config, directory, clock, desktop, signal(), 0, fetch);
  t.after(() => restarted.stop());
  await restarted.initialize();
  assert.equal((await globalThis.fetch(restarted.origin + '/')).status, 200);
  assert.equal(restarted.profile.store.pr('101')!.snapshot.title, snapshot.title);
  restarted.tick(); await restarted.scheduler.idle();
  assert.equal(desktop.submissions.length, 1);
  assert.equal(restarted.profile.store.attempts(interrupted)[0]!.data.result, 'ambiguous');
  assert.ok(restarted.logs.read('warn').some(entry => /discovery/i.test(entry.message)));
  clock.set('2026-10-22T12:01:00Z'); restarted.tick(); await restarted.scheduler.idle();
  assert.equal(restarted.profile.store.notification(interrupted).status, 'sent');
  offline = false; clock.set('2026-10-22T12:05:00Z'); restarted.tick(); await restarted.scheduler.idle();
  assert.equal(restarted.profile.store.metadata('discoveryComplete'), clock.now());
  assert.ok(restarted.logs.read('info').some(entry => /discovery recovered/i.test(entry.message)));
  assert.equal(restarted.profile.store.metadata('discoveryStatus'), 'ready');
});

test('degraded startup never bypasses first initialization, identity, or non-transient discovery failures', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(T);
  const config = parseConfig('[github]\ntoken="synthetic-secret"\n');
  const start = (identity: () => Promise<Response>, discovery: () => Promise<Response>, options = config) => startRuntime(options, directory, clock,
    new RecordingDesktop(), signal(), async url => url.endsWith('/user') ? identity() : url.includes('/user/teams') ? json([]) : discovery());
  const alex = async () => json({ login: 'alex' });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(start(alex, async () => json({}, 503)), /during discovery/);
  const initialized = await start(alex, async () => emptySearch()); await initialized.stop();
  await assert.rejects(start(async () => json({}, 401), async () => emptySearch()), /during identity/);
  await assert.rejects(start(async () => { throw new TypeError('Network unavailable'); }, async () => emptySearch()), /during identity/);
  await assert.rejects(start(async () => json({ login: 'different' }), async () => emptySearch()), /identity binding/);
  await assert.rejects(start(alex, async () => emptySearch(), { ...config, github: { ...config.github, login: 'different' } }), /identity binding/);
  for (const response of [() => json({}, 401), () => json({}, 403), () => json({}),
    () => json({ total_count: 0, incomplete_results: true, items: [] }),
    () => new Response(null, { status: 302, headers: { location: 'https://[' } })]) {
    await assert.rejects(start(alex, async () => response()), /during discovery/);
  }
  for (const discovery of [async () => { throw new TypeError('Network unavailable'); },
    async () => new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
    async () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792670460' } })]) {
    const degraded = await start(alex, discovery);
    assert.equal(degraded.profile.store.metadata('discoveryStatus'), 'degraded');
    await degraded.stop();
  }
});
