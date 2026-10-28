import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Event, Snapshot, Workflow } from '../src/model.js';
import type { Classifier } from '../src/model.js';
import type { PageRequest } from '../src/collector.js';
import { Collector } from '../src/collector.js';
import { evaluateCi, ciSummary } from '../src/ci.js';
import { Monitor } from '../src/monitor.js';
import { Delivery } from '../src/delivery.js';
import { Scheduler } from '../src/scheduler.js';
import { Profile } from '../src/profile.js';
import { completeSources, RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';

const T = '2026-10-22T12:00:00.000Z';
const A = Snapshot.parse({ id: 'A', repository: 'acme/widget', number: 7, title: 'CI', author: 'alex', head: 'h1' });
const comment = Event.parse({ source: 'issue_comment', id: 'c', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: 'Please fix' });
const batch = (snapshot = A, events: Event[] = [], workflows: Workflow[] = []) => ({ snapshot, events, workflows, sources: completeSources, reviews: [] });
const run = (overrides: Partial<Workflow> = {}): Workflow => Workflow.parse({
  id: 'r1', workflowId: 'build', trigger: 'push', runNumber: 1, attempt: 1,
  head: 'h1', name: 'Build', updatedAt: T, status: 'completed', conclusion: 'success', jobsComplete: true, jobs: [], ...overrides,
});
const page = (items: unknown[], next: number | null = null, validator: string | null = null) => ({ status: 200, items, next, validator });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(t: TestContext, classifier?: Classifier) {
  const directory = await temporaryProfile();
  const profile = new Profile(directory);
  t.after(async () => { profile.close(); await rm(directory, { recursive: true, force: true }); });
  const store = profile.store;
  const clock = new VirtualClock(T);
  const monitor = new Monitor(store, clock, 'alex', ['acme/platform'], '2026-10-21T12:00:00Z', classifier);
  monitor.track(A, 'manual');
  await monitor.observe(batch());
  const desktop = new RecordingDesktop();
  const delivery = new Delivery(store, clock, desktop);
  return { directory, store, monitor, clock, desktop, delivery };
}

test('CI conclusion truth table distinguishes neutral, terminal and unknown', () => {
  const cases = [
    ['failure', 'failure', 'failing'], ['timed_out', 'failure', 'failing'], ['action_required', 'failure', 'failing'],
    ['startup_failure', 'failure', 'failing'], ['success', 'success', 'passing'], ['neutral', null, 'skipped'],
    ['skipped', null, 'skipped'], ['cancelled', null, 'terminal'], ['stale', null, 'terminal'], ['future_result', null, 'unknown'],
  ] as const;
  for (const [conclusion, outcome, state] of cases) {
    const workflow = run({ conclusion, jobs: [{ id: 'j', name: 'Test', runId: 'r1', attempt: 1, head: 'h1', status: 'completed', conclusion }] });
    const evaluated = evaluateCi('h1', undefined, [workflow], T);
    assert.equal(evaluated.state.outcome, outcome, conclusion);
    assert.equal(ciSummary(evaluated.state).counts[state], 1, conclusion);
  }
  for (const conclusion of ['neutral', 'skipped']) {
    const result = evaluateCi('h1', undefined, [run(), run({ id: 'r2', workflowId: 'test', conclusion })], T);
    assert.equal(result.state.outcome, 'success');
  }
  assert.equal(evaluateCi('h1', undefined, [run({ status: 'queued', conclusion: 'failure' })], T).state.outcome, null);
  assert.equal(evaluateCi('h1', undefined, [run({ conclusion: 'cancelled' }), run({ id: 'r2', workflowId: 'other' })], T).state.outcome, null);
});

test('workflow selection uses run/attempt order and stable identity, independent of response order', () => {
  const runs = [
    run({ id: 'old', runNumber: 1, conclusion: 'failure', updatedAt: '2026-10-23T12:00:00Z' }),
    run({ id: 'new', runNumber: 2, attempt: 1, conclusion: 'failure' }),
    run({ id: 'new', runNumber: 2, attempt: 2, conclusion: 'success' }),
  ];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const result = evaluateCi('h1', undefined, order.map(index => runs[index]!), T);
    assert.equal(result.state.outcome, 'success');
    assert.deepEqual(result.state.selected.map(run => [run.id, run.attempt]), [['new', 2]]);
  }
  const distinct = evaluateCi('h1', undefined, [run(), run({ id: 'r2', workflowId: 'different', name: 'Build', conclusion: 'failure' })], T);
  assert.equal(distinct.state.outcome, 'failure');
  assert.equal(distinct.state.selected.length, 2);
  const triggers = evaluateCi('h1', undefined, [run(), run({ id: 'r2', trigger: 'pull_request', conclusion: 'failure' })], T);
  assert.equal(triggers.state.selected.length, 2);
});

test('missing or contradictory ordering preserves the established result with uncertainty', () => {
  const old = evaluateCi('h1', undefined, [run({ conclusion: 'failure' })], T).state;
  for (const incoming of [
    run({ id: 'r2', workflowId: null }), run({ id: 'r2', attempt: null }), run({ id: 'r2', runNumber: null }),
    run({ id: 'r2', trigger: null }), run({ id: 'r2' }), run({ workflowId: 'changed-identity' }), run(),
  ]) {
    const result = evaluateCi('h1', old, [incoming], T);
    assert.equal(result.state.uncertain, true);
    assert.equal(result.state.outcome, 'failure');
    assert.equal(result.state.selected[0]!.conclusion, 'failure');
    assert.equal(result.event, null);
  }
  const recovered = evaluateCi('h1', { ...old, uncertain: true }, [run({ id: 'r2', runNumber: 2 })], T);
  assert.equal(recovered.state.uncertain, false);
  assert.equal(recovered.state.outcome, 'success');
  assert.equal(evaluateCi('h2', undefined, old.runs, T).state.outcome, null);
});

test('shared source associations survive both sequential orders and concurrent polls', async t => {
  for (const mode of ['forward', 'reverse', 'parallel']) {
    await t.test(mode, async child => {
      const { monitor, store } = await setup(child);
      const second = { ...A, id: 'B', number: 8 };
      monitor.track(second, 'manual');
      await monitor.observe(batch(second));
      const commit = Event.parse({ source: 'timeline', id: 'sha', kind: 'commit', occurredAt: T });
      const work = [A, second].map(snapshot => () => monitor.observe(batch(snapshot, [commit], [run({ conclusion: 'failure' })])));
      if (mode === 'parallel') await Promise.all(work.map(call => call()));
      else for (const call of mode === 'reverse' ? work.reverse() : work) await call();
      for (const snapshot of [A, second]) {
        assert.equal(store.activities(snapshot.id).length, 2);
        assert.equal(store.notifications().filter(item => item.data.intent.prId === snapshot.id).length, 1);
      }
    });
  }
});

test('collector follows every source page, including full-page empty continuation and current jobs', async t => {
  const { store, monitor, clock } = await setup(t);
  const requests: PageRequest[] = [];
  const comments = Array.from({ length: 101 }, (_, index) => ({ ...comment, id: `c${index}` }));
  const inline = comments.map(event => ({ ...event, source: 'inline_comment', kind: 'inline_comment' }));
  const reviews = comments.map((event, index) => ({
    review: { id: `r${index}`, reviewer: { login: 'bea' }, state: 'commented', submittedAt: T },
    event: { ...event, source: 'review', kind: 'review' },
  }));
  reviews.push({ review: { id: 'pending', reviewer: { login: 'bea' }, state: 'pending', submittedAt: T }, event: { ...comment, source: 'review', kind: 'review' } });
  const workflows = Array.from({ length: 101 }, (_, index) => run({ id: `run${index}`, workflowId: `flow${index}` }));
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    requests.push(request);
    if (request.resource === 'detail') return page([A]);
    const items = request.resource === 'comments' ? comments : request.resource === 'inlineComments' ? inline
      : request.resource === 'reviews' ? reviews : request.resource === 'timeline' ? comments.map(event => ({ ...event, source: 'timeline', kind: 'commit' }))
      : request.resource === 'workflows' ? workflows : Array.from({ length: request.runId === 'run0' ? 100 : 1 }, (_, index) => ({
        id: `job${index}`, name: 'Test', runId: request.runId, attempt: request.attempt, head: request.head, status: 'completed', conclusion: 'success',
      }));
    const slice = items.slice((request.page - 1) * 100, request.page * 100);
    return page(slice, slice.length === 100 ? request.page + 1 : null);
  } });
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  for (const resource of ['comments', 'inlineComments', 'reviews', 'timeline', 'workflows']) {
    assert.deepEqual(requests.filter(request => request.resource === resource).map(request => request.page), [1, 2]);
  }
  assert.deepEqual(requests.filter(request => request.resource === 'jobs' && request.runId === 'run0').map(request => request.page), [1, 2]);
  assert.equal(store.activities('A').length, 101 * 4 + 1);
  assert.equal(store.pr('A')!.reviews.length, 101);
  assert.equal(ciSummary(store.pr('A')!.ci.h1).counts.passing, 200);
});

test('failed partial collection preserves data but never advances validators or either progress marker', async t => {
  const { store, monitor, clock } = await setup(t);
  let fail = true;
  const requests: PageRequest[] = [];
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    requests.push(request);
    if (request.resource === 'detail') return page([A], null, 'detail-next');
    if (request.resource === 'comments') return page([{ ...comment, updatedAt: '2026-10-22T11:59:00Z' }], null, 'comments-next');
    if (request.resource === 'inlineComments') {
      if (fail) throw new Error('offline');
      return page([{ ...comment, id: 'inline', source: 'inline_comment', kind: 'inline_comment', updatedAt: '2026-10-22T11:58:00Z' }]);
    }
    return page([]);
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)), /offline/);
  assert.deepEqual(store.pr('A')!.fetchState, { pages: {}, progress: { comments: null, inlineComments: null } });
  assert.equal(store.staged('A').filter(batch => !batch.data.processed).length, 1);
  fail = false;
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  assert.deepEqual(store.pr('A')!.fetchState.progress, { comments: '2026-10-22T11:59:00Z', inlineComments: '2026-10-22T11:58:00Z' });
  assert.equal(store.activities('A').length, 2);
  requests.length = 0;
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  assert.equal(requests.find(request => request.resource === 'comments')!.since, '2026-10-22T11:59:00Z');
  assert.equal(requests.find(request => request.resource === 'inlineComments')!.since, '2026-10-22T11:58:00Z');
  assert.equal(store.notifications().length, 1);
});

test('partial jobs are refetched after failure; a saved partial set is never a complete cache', async t => {
  const { store, monitor, clock } = await setup(t);
  let fail = true;
  const jobPages: number[] = [];
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    if (request.resource === 'detail') return page([A]);
    if (request.resource === 'workflows') return page([run({ conclusion: 'failure' })]);
    if (request.resource === 'jobs') {
      jobPages.push(request.page);
      if (request.page === 2 && fail) throw new Error('second job page failed');
      return page([{ id: `j${request.page}`, name: 'Test', runId: 'r1', attempt: 1, head: 'h1', status: 'completed', conclusion: 'failure' }], request.page === 1 ? 2 : null);
    }
    return page([]);
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)), /second job page/);
  assert.equal(store.notifications().length, 0);
  fail = false;
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  assert.deepEqual(jobPages, [1, 2, 1, 2]);
  assert.equal(ciSummary(store.pr('A')!.ci.h1).counts.failing, 2);
  assert.equal(store.notifications().length, 1);
});

test('validation failures retain their external inputs and do not create false empty success', async t => {
  const { store, monitor, clock } = await setup(t);
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    if (request.resource === 'detail') return page([A]);
    return page([{ broken: 'missing identity and time' }]);
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)));
  assert.equal(store.failedInputCount('A'), 1);
  assert.deepEqual(store.pr('A')!.fetchState.pages, {});
  clock.set('2030-01-01T00:00:00Z');
  store.prune(clock.now(), 1);
  assert.equal(store.failedInputCount('A'), 1);
  assert.equal(store.staged('A').filter(batch => !batch.data.processed).length, 1);
});

test('transaction failure after outbox insertion rolls back decisions and recovers from unchanged upstream', async t => {
  const { directory, store, monitor } = await setup(t);
  const db = new Database(join(directory, 'state.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_delivery AFTER INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
    await assert.rejects(monitor.observe(batch(A, [comment])), /injected persistence failure/);
    assert.equal(store.activities('A').length, 0);
    assert.equal(store.notifications().length, 0);
    assert.equal(store.staged('A').filter(batch => !batch.data.processed).length, 1);
    db.exec('DROP TRIGGER fail_delivery');
    await monitor.observe({ ...batch(), sources: Object.fromEntries(Object.keys(completeSources).map(source => [source, 'unchanged'])) });
    assert.equal(store.activities('A').length, 1);
    assert.equal(store.notifications().length, 1);
    assert.equal(store.staged('A').filter(batch => !batch.data.processed).length, 0);
  } finally { db.close(); }
});

test('untrack/retrack invalidates in-flight classification and silently recovers retained activity', async t => {
  const classified = deferred<unknown>();
  const started = deferred<void>();
  const { store, monitor } = await setup(t, { async classify() { started.resolve(); return classified.promise; } });
  const work = monitor.observe(batch(A, [{ ...comment, actor: { login: 'checks[bot]', bot: true } }]));
  await started.promise;
  monitor.untrack('A');
  monitor.track(A, 'manual');
  classified.resolve({ type: 'Choice', choice: 'notify', probabilities: { notify: 1, suppress: 0 }, confidence: 1 });
  await work;
  assert.equal(store.notifications().length, 0);
  await monitor.observe(batch());
  assert.equal(store.activities('A')[0]!.decision, 'baseline');
  assert.equal(store.staged('A').filter(batch => !batch.data.processed).length, 0);
});

test('stale in-flight detail cannot overwrite newer discovery head or manual preference', async t => {
  const { monitor, store } = await setup(t);
  const fetch = deferred<unknown>();
  const started = deferred<void>();
  const work = monitor.poll('A', async () => { started.resolve(); return fetch.promise; });
  await started.promise;
  monitor.track({ ...A, head: 'h2', updatedAt: '2026-10-22T12:01:00Z' }, 'discovery');
  fetch.resolve(batch(A, [comment], [run({ conclusion: 'failure' })]));
  await work;
  assert.equal(store.pr('A')!.snapshot.head, 'h2');
  assert.equal(store.notifications().length, 0);
  await monitor.observe(batch({ ...A, head: 'h2', updatedAt: '2026-10-22T12:01:00Z' }));
  assert.equal(store.pr('A')!.snapshot.head, 'h2');
  assert.equal(store.pr('A')!.ci.h2!.outcome, null);
  assert.equal(store.activities('A')[0]!.event.id, 'c');
});

test('closure uses external merge time, strict grace expiry and unchanged origin on automatic reopening', async t => {
  const { monitor, store, clock } = await setup(t);
  monitor.track({ ...A, state: 'merged', closedAt: '2026-10-21T12:00:00Z', mergedAt: '2026-10-20T12:00:00Z' }, 'discovery');
  monitor.reconcile();
  assert.equal(store.pr('A')!.graceUntil, '2026-10-27T12:00:00.000Z');
  clock.set('2026-10-27T11:59:59.999Z');
  assert.deepEqual(monitor.select('grace'), ['A']);
  clock.set('2026-10-27T12:00:00Z');
  assert.deepEqual(monitor.select('grace'), []);
  monitor.track(A, 'discovery');
  assert.equal(store.pr('A')!.tracked, true);
  assert.equal(store.pr('A')!.origin, 'manual');
  assert.equal(store.pr('A')!.baselineComplete, true);
  monitor.untrack('A');
  monitor.track(A, 'discovery');
  assert.deepEqual(monitor.select('active'), []);
});

test('grace expiry does not cancel a prepared delivery retry', async t => {
  const { monitor, store, clock, delivery, desktop } = await setup(t);
  await monitor.observe(batch(A, [comment]));
  desktop.results = ['transient', 'sent'];
  await delivery.runDue();
  monitor.track({ ...A, state: 'closed', closedAt: '2026-10-15T12:00:30Z' }, 'discovery');
  monitor.reconcile();
  clock.set('2026-10-22T12:01:00Z');
  assert.deepEqual(monitor.select('grace'), []);
  await delivery.runDue();
  assert.equal(store.notification(1).status, 'sent');
  assert.equal(store.notification(1).attempts, 2);
});

test('sweeps cap concurrency at four, skip active overlap and isolate a PR failure', async t => {
  const { monitor, clock, delivery } = await setup(t);
  for (let i = 1; i < 9; i++) monitor.track({ ...A, id: `P${i}`, number: i + 10 }, 'manual');
  const calls: string[] = [];
  const active = new Map<string, ReturnType<typeof deferred<void>>>();
  let maximum = 0;
  const errors: string[] = [];
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async poll(pr) {
      calls.push(pr.snapshot.id);
      const wait = deferred<void>();
      active.set(pr.snapshot.id, wait);
      maximum = Math.max(maximum, active.size);
      try { await wait.promise; return batch(pr.snapshot); }
      finally { active.delete(pr.snapshot.id); }
    },
    async discover() {}, report(_error, scope) { errors.push(scope); },
  });
  clock.set('2026-10-22T12:01:00Z'); scheduler.tick(); await setImmediate();
  assert.equal(active.size, 4);
  clock.set('2026-10-22T12:02:00Z'); scheduler.tick(); await setImmediate();
  assert.equal(calls.length, 4);
  let failed = false;
  while (active.size || calls.length < 9) {
    for (const wait of [...active.values()]) {
      if (!failed) { wait.reject(new Error('offline')); failed = true; } else wait.resolve();
    }
    await setImmediate();
  }
  await scheduler.idle();
  assert.equal(maximum, 4);
  assert.equal(new Set(calls).size, 9);
  assert.equal(calls.length, 9);
  assert.equal(errors.length, 1);
  await scheduler.stop();
});

test('grace waits one second during active work; retry and success schedule from completion', async t => {
  const { monitor, clock, delivery } = await setup(t);
  monitor.track({ ...A, id: 'B', number: 8, state: 'closed', closedAt: T }, 'manual');
  const active = deferred<void>();
  const grace = deferred<void>();
  let graceCalls = 0;
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async poll(pr) {
      if (pr.snapshot.id === 'A') await active.promise;
      else { graceCalls++; if (graceCalls === 1) throw new Error('offline'); await grace.promise; }
      return batch(pr.snapshot);
    }, async discover() {}, report() {},
  }, 900_000);
  clock.set('2026-10-22T12:15:00Z'); scheduler.tick(); await setImmediate();
  assert.equal(graceCalls, 0);
  assert.equal(scheduler.deadlines().grace, '2026-10-22T12:15:01.000Z');
  clock.set('2026-10-22T12:15:01Z'); scheduler.tick();
  assert.equal(scheduler.deadlines().grace, '2026-10-22T12:15:02.000Z');
  active.resolve(); await scheduler.idle();
  clock.set('2026-10-22T12:15:02Z'); scheduler.tick(); await scheduler.idle();
  assert.equal(scheduler.deadlines().grace, '2026-10-22T12:16:02.000Z');
  clock.set('2026-10-22T12:16:02Z'); scheduler.tick(); await setImmediate();
  clock.set('2026-10-22T12:16:30Z'); grace.resolve(); await scheduler.idle();
  assert.equal(scheduler.deadlines().grace, '2026-10-22T12:31:30.000Z');
  await scheduler.stop();
});

test('discovery can overlap polling but never overlaps itself, and shutdown cancels owned work', async t => {
  const { monitor, store, clock } = await setup(t);
  await monitor.observe(batch(A, [comment]));
  let desktopStarted = false;
  const delivery = new Delivery(store, clock, { async submit() { desktopStarted = true; return new Promise(() => {}); } });
  let discoveries = 0;
  let polls = 0;
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async poll() { polls++; return new Promise(() => {}); },
    async discover() { discoveries++; return new Promise(() => {}); }, report() {},
  });
  clock.set('2026-10-22T12:05:00Z'); scheduler.tick(); await setImmediate();
  assert.equal(polls, 1); assert.equal(discoveries, 1); assert.equal(desktopStarted, true);
  clock.set('2026-10-22T12:10:00Z'); scheduler.tick(); await setImmediate();
  assert.equal(polls, 1); assert.equal(discoveries, 1);
  await scheduler.stop(); await scheduler.stop();
  assert.equal(store.notification(1).reason, 'ambiguous');
  assert.equal(store.notification(1).attempts, 1);
  clock.set('2026-10-22T13:00:00Z'); scheduler.tick(); await scheduler.idle();
  assert.equal(polls, 1); assert.equal(discoveries, 1);
});

test('manual refresh discovers and checks all eligible PRs immediately with bounded concurrency and partial results', async t => {
  const { monitor, store, clock, delivery } = await setup(t);
  for (let i = 1; i <= 7; i++) monitor.track({ ...A, id: `P${i}`, number: i + 10 }, 'manual');
  monitor.untrack('P7');
  monitor.track({ ...A, id: 'grace', number: 40, state: 'closed', closedAt: T }, 'manual');
  const gate = deferred<void>();
  const calls: string[] = []; const errors: string[] = [];
  let active = 0; let maximum = 0; let discoveries = 0;
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async discover() { discoveries++; monitor.track({ ...A, id: 'new', number: 41 }, 'discovery'); },
    async poll(pr) {
      calls.push(pr.snapshot.id); maximum = Math.max(maximum, ++active);
      try {
        await gate.promise;
        if (pr.snapshot.id === 'P2') throw new Error('Synthetic GitHub failure');
        return batch({ ...pr.snapshot, title: `Updated ${pr.snapshot.id}` });
      } finally { active--; }
    }, report(_error, scope) { errors.push(scope); },
  });
  const refresh = scheduler.refresh();
  assert.equal(scheduler.refreshStatus?.phase, 'discovering');
  assert.equal(scheduler.refresh(), refresh, 'Concurrent refresh requests share the same work');
  await setImmediate(); assert.equal(calls.length, 4);
  assert.equal(scheduler.refreshStatus?.phase, 'checking');
  assert.equal(scheduler.refreshStatus?.total, 9); assert.equal(scheduler.refreshStatus?.completed, 0);
  clock.set('2026-10-22T12:15:00Z'); scheduler.tick(); await setImmediate();
  assert.equal(calls.length, 4, 'Scheduled ticks cannot start duplicate sweeps during a manual refresh');
  gate.resolve();
  assert.deepEqual(await refresh, { discoveryFailed: false, failedPullRequests: 1 });
  assert.equal(discoveries, 1); assert.equal(maximum, 4);
  assert.deepEqual(new Set(calls), new Set(['A', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'grace', 'new']));
  assert.equal(calls.length, 9); assert.deepEqual(errors, ['P2']);
  assert.equal(scheduler.refreshStatus?.completed, 9); assert.equal(scheduler.refreshStatus?.phase, 'completed');
  assert.equal(store.pr('A')!.snapshot.title, 'Updated A');
  assert.equal(store.pr('grace')!.snapshot.title, 'Updated grace');
  assert.equal(scheduler.deadlines().active, '2026-10-22T12:16:00.000Z');
  await scheduler.stop();
});

test('manual refresh joins scheduled discovery and polling, then checks newly discovered PRs once', async t => {
  const { monitor, clock, delivery } = await setup(t);
  const discovery = deferred<void>(); const poll = deferred<void>();
  let discoveries = 0; const calls: string[] = [];
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async discover() { discoveries++; await discovery.promise; monitor.track({ ...A, id: 'new', number: 8 }, 'discovery'); },
    async poll(pr) { calls.push(pr.snapshot.id); if (pr.snapshot.id === 'A') await poll.promise; return batch(pr.snapshot); }, report() {},
  });
  clock.set('2026-10-22T12:05:00Z'); scheduler.tick(); await setImmediate();
  const refresh = scheduler.refresh(); await setImmediate();
  assert.equal(discoveries, 1); assert.deepEqual(calls, ['A']);
  poll.resolve(); discovery.resolve();
  assert.deepEqual(await refresh, { discoveryFailed: false, failedPullRequests: 0 });
  assert.deepEqual(calls, ['A', 'new']); assert.equal(discoveries, 1);
  assert.equal(scheduler.refreshStatus?.total, 2); assert.equal(scheduler.refreshStatus?.completed, 2);
  await scheduler.stop();
});

test('manual refresh retains polling successes after discovery failure and drains on shutdown', async t => {
  const { monitor, store, clock, delivery } = await setup(t);
  let hang = false;
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async discover() { if (hang) await new Promise(() => {}); throw new Error('Synthetic discovery outage'); },
    async poll(pr) { return batch({ ...pr.snapshot, title: 'Polled during discovery outage' }); }, report() {},
  });
  assert.deepEqual(await scheduler.refresh(), { discoveryFailed: true, failedPullRequests: 0 });
  assert.equal(store.pr('A')!.snapshot.title, 'Polled during discovery outage');
  hang = true;
  const refresh = scheduler.refresh(); const rejected = assert.rejects(refresh, /abort/i);
  await setImmediate(); await scheduler.stop(); await rejected;
  assert.equal(scheduler.refreshStatus?.phase, 'failed');
  await assert.rejects(scheduler.refresh(), /stopped/);
});

test('refresh progress counts finished checks rather than started requests and starts fresh for each job', async t => {
  const { monitor, clock, delivery } = await setup(t);
  monitor.track({ ...A, id: 'B', number: 8 }, 'manual');
  const gates = new Map([['A', deferred<void>()], ['B', deferred<void>()]]);
  const scheduler = new Scheduler(monitor, delivery, clock, {
    async discover() {}, async poll(pr) { await gates.get(pr.snapshot.id)!.promise; return batch(pr.snapshot); }, report() {},
  });
  const initial = scheduler.startRefresh();
  assert.equal(initial.phase, 'discovering');
  await setImmediate();
  assert.equal(scheduler.refreshStatus?.completed, 0); assert.equal(scheduler.refreshStatus?.total, 2);
  gates.get('A')!.resolve(); await setImmediate();
  assert.equal(scheduler.refreshStatus?.completed, 1); assert.equal(scheduler.refreshStatus?.phase, 'checking');
  gates.get('B')!.reject(new Error('Synthetic failure')); await scheduler.idle();
  assert.equal(scheduler.refreshStatus?.completed, 2); assert.equal(scheduler.refreshStatus?.failedPullRequests, 1);
  const next = scheduler.startRefresh();
  assert.notEqual(next.id, initial.id); assert.equal(next.completed, 0); assert.equal(next.failedPullRequests, 0);
  await scheduler.idle(); await scheduler.stop();
});

test('profile ownership is exclusive across processes and released by abrupt exit', async t => {
  const directory = await temporaryProfile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory);
  const worker = fileURLToPath(new URL('./ownership-worker.js', import.meta.url));
  assert.equal(spawnSync(process.execPath, [worker, directory]).status, 74);
  profile.close();
  assert.equal(spawnSync(process.execPath, [worker, directory, 'crash']).status, 73);
  const reopened = new Profile(directory);
  reopened.close();
});

test('malformed job ownership is retained without poisoning a later valid retry', async t => {
  const { store, monitor, clock } = await setup(t);
  let invalid = true;
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    if (request.resource === 'detail') return page([A]);
    if (request.resource === 'workflows') return page([run({ conclusion: 'failure' })]);
    if (request.resource === 'jobs') return page([{ id: 'j', name: 'Test', runId: invalid ? 'wrong-run' : 'r1', attempt: 1, head: 'h1', status: 'completed', conclusion: 'failure' }]);
    return page([]);
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)), /does not belong/);
  assert.equal(store.failedInputCount('A'), 1);
  assert.equal(store.staged('A').filter(batch => !batch.data.processed).length, 1);
  invalid = false;
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  assert.equal(ciSummary(store.pr('A')!.ci.h1).counts.failing, 1);
  assert.equal(store.notifications().length, 1);
});

test('discovery head changes invalidate stale detail validators and use head-specific workflow caches', async t => {
  const { monitor, store, clock } = await setup(t);
  let detail = A;
  const requests: PageRequest[] = [];
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    requests.push(request);
    if (request.resource === 'detail') return page([detail], null, `detail-${detail.head}`);
    return page([], null, 'cached');
  } });
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  detail = { ...A, head: 'h2' };
  monitor.track(detail, 'discovery');
  requests.length = 0;
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  assert.equal(requests.find(request => request.resource === 'detail')!.validator, null);
  const workflows = requests.find(request => request.resource === 'workflows')!;
  assert.equal(workflows.head, 'h2');
  assert.equal(workflows.validator, null);
  assert.equal(store.pr('A')!.snapshot.head, 'h2');
});

test('untrack during a desktop submission cancels its future retries without a false success', async t => {
  const { monitor, store, clock } = await setup(t);
  await monitor.observe(batch(A, [comment]));
  const started = deferred<void>();
  const result = deferred<'transient'>();
  let submissions = 0;
  const delivery = new Delivery(store, clock, { async submit() { submissions++; started.resolve(); return result.promise; } });
  const work = delivery.runDue();
  await started.promise;
  monitor.untrack('A');
  result.resolve('transient');
  await work;
  clock.set('2026-10-22T13:00:00Z');
  await delivery.runDue();
  assert.equal(submissions, 1);
  assert.equal(store.notification(1).status, 'failed');
  assert.equal(store.notification(1).reason, 'untracked');
  assert.equal(store.notification(1).nextAttemptAt, null);
});

test('process crashes during classification and after preparation resume without losing decisions', async t => {
  for (const phase of ['classification', 'prepared']) {
    await t.test(phase, async child => {
      const directory = await temporaryProfile();
      child.after(() => rm(directory, { recursive: true, force: true }));
      const initial = new Profile(directory);
      const clock = new VirtualClock(T);
      const monitor = new Monitor(initial.store, clock, 'alex', [], '2026-10-21T12:00:00Z');
      monitor.track(A, 'manual');
      await monitor.observe(batch());
      initial.close();
      const worker = fileURLToPath(new URL('./processing-worker.js', import.meta.url));
      const crash = spawnSync(process.execPath, [worker, directory, phase], { encoding: 'utf8' });
      assert.equal(crash.status, phase === 'classification' ? 75 : 76, crash.stderr);
      const recovered = new Profile(directory);
      try {
        assert.equal(recovered.store.notifications().length, phase === 'classification' ? 0 : 1);
        const monitor = new Monitor(recovered.store, clock, 'alex', [], '2026-10-21T12:00:00Z');
        await monitor.observe({ ...batch(), sources: Object.fromEntries(Object.keys(completeSources).map(source => [source, 'unchanged'])) });
        const desktop = new RecordingDesktop();
        const delivery = new Delivery(recovered.store, clock, desktop);
        delivery.recover(); await delivery.runDue(); await delivery.runDue();
        assert.equal(recovered.store.activities('A').length, 1);
        assert.equal(recovered.store.notifications().length, 1);
        assert.equal(recovered.store.notification(1).status, 'sent');
        assert.equal(desktop.submissions.length, 1);
      } finally { recovered.close(); }
    });
  }
});

test('per-PR lookups cannot resurrect an untracked PR or overwrite a newer poll', async t => {
  const { store, monitor } = await setup(t);
  const lookup = deferred<unknown>();
  const started = deferred<void>();
  const pending = monitor.lookup('A', 'manual', async () => { started.resolve(); return lookup.promise; });
  await started.promise;
  monitor.untrack('A');
  lookup.resolve({ ...A, title: 'Stale manual lookup' });
  await pending;
  assert.equal(store.pr('A')!.manualUntracked, true);
  assert.equal(store.pr('A')!.snapshot.title, A.title);
  monitor.track(A, 'manual');
  const order: string[] = [];
  const poll = deferred<unknown>();
  const polling = monitor.poll('A', async () => { order.push('poll'); return poll.promise; });
  const discovering = monitor.lookup('A', 'discovery', async () => { order.push('discovery'); return { ...A, head: 'h2' }; });
  await setImmediate();
  assert.deepEqual(order, ['poll']);
  poll.resolve(batch());
  await Promise.all([polling, discovering]);
  assert.deepEqual(order, ['poll', 'discovery']);
  assert.equal(store.pr('A')!.snapshot.head, 'h2');
});

test('late inline content hides an ordinary wrapper without rewriting delivered history', async t => {
  const { monitor, store, delivery } = await setup(t);
  await monitor.observe(batch(A, [Event.parse({ ...comment, source: 'review', kind: 'review', id: 'wrapper', body: '' })]));
  await delivery.runDue();
  const original = store.notification(1).intent.body;
  await monitor.observe(batch(A, [Event.parse({ ...comment, source: 'inline_comment', kind: 'inline_comment', id: 'inline', reviewId: 'wrapper' })]));
  assert.equal(store.activities('A')[0]!.visible, false);
  assert.equal(store.notification(1).status, 'sent');
  assert.equal(store.notification(1).intent.body, original);
  assert.equal(store.notifications().length, 2);
});

test('completed first-page activity remains recoverable when later pagination fails and upstream omits it on retry', async t => {
  const { store, monitor, clock } = await setup(t);
  let failed = false;
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    if (request.resource === 'detail') return page([A]);
    if (request.resource === 'comments') {
      if (request.page === 2) { failed = true; throw new Error('page failed'); }
      return failed ? page([]) : page([comment], 2);
    }
    return page([]);
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)), /page failed/);
  assert.equal(store.activities('A').length, 0);
  await monitor.poll('A', (pr, signal) => collector.collect(pr, signal));
  assert.equal(store.activities('A')[0]!.event.id, 'c');
  assert.equal(store.notifications().length, 1);
});
