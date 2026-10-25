import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Event, PullRequest, Snapshot, sourceNames } from '../src/model.js';
import type { Classifier, Desktop } from '../src/model.js';
import { Monitor } from '../src/monitor.js';
import { Store } from '../src/store.js';
import { Delivery } from '../src/delivery.js';
import { readable } from '../src/presentation.js';
import { completeSources, RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';

const T = '2026-10-22T12:00:00.000Z';
const A = Snapshot.parse({ id: 'A', repository: 'acme/widget', number: 7, title: 'Own PR', author: 'alex' });
const B = Snapshot.parse({ ...A, id: 'B', number: 8, author: 'bea' });
const comment = Event.parse({ source: 'issue_comment', id: 'c', kind: 'comment', occurredAt: T,
  actor: { login: 'bea' }, body: 'Please fix' });

async function setup(t: TestContext, classifier?: Classifier) {
  const directory = await temporaryProfile();
  const path = join(directory, 'state.sqlite');
  const clock = new VirtualClock(T);
  const store = new Store(path);
  t.after(async () => {
    // Some recovery tests close/reopen the connection explicitly.
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const monitor = new Monitor(store, clock, 'alex', ['acme/platform'], '2026-10-21T12:00:00Z', classifier);
  for (const snapshot of [A, B]) {
    monitor.track(snapshot, 'manual');
    await monitor.observe({ snapshot, sources: completeSources, events: [] });
  }
  const desktop = new RecordingDesktop();
  const delivery = new Delivery(store, clock, desktop);
  return { directory, path, clock, store, monitor, desktop, delivery };
}

const notify = { type: 'Choice', choice: 'notify', probabilities: { notify: 0.9, suppress: 0.1 }, confidence: 0.9 };
const classificationCases: { name: string; answer?: unknown; error?: boolean; absent?: boolean; decision: string; reason?: string }[] = [
  { name: 'notify', answer: notify, decision: 'eligible' },
  { name: 'low confidence suppress', answer: { ...notify, choice: 'suppress', confidence: 0.001 }, decision: 'classified_suppress' },
  { name: 'sum within tolerance', answer: { ...notify, probabilities: { notify: 0.9, suppress: 0.1005 } }, decision: 'eligible' },
  { name: 'no provider', absent: true, decision: 'eligible', reason: 'not_configured' },
  { name: 'transport failure', error: true, decision: 'eligible', reason: 'provider_failure' },
  { name: 'malformed JSON shape', answer: '{', decision: 'eligible', reason: 'invalid_answer' },
  { name: 'wrong type', answer: { ...notify, type: 'Text' }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'unknown choice', answer: { ...notify, choice: 'maybe' }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'missing confidence', answer: { type: 'Choice', choice: 'notify', probabilities: notify.probabilities }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'missing probability', answer: { ...notify, probabilities: { notify: 1 } }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'nonfinite probability', answer: { ...notify, probabilities: { notify: Infinity, suppress: 0 } }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'negative probability', answer: { ...notify, probabilities: { notify: -0.1, suppress: 1.1 } }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'sum outside tolerance', answer: { ...notify, probabilities: { notify: 0.9, suppress: 0.102 } }, decision: 'eligible', reason: 'invalid_answer' },
  { name: 'invalid confidence', answer: { ...notify, confidence: 1.1 }, decision: 'eligible', reason: 'invalid_answer' },
];

for (const variant of classificationCases) {
  test(`classification: ${variant.name}`, async t => {
    const calls: string[] = [];
    const classifier = variant.absent ? undefined : { async classify(body: string) {
      calls.push(body);
      if (variant.error) throw new Error('Provider request failed');
      return variant.answer;
    } };
    const { store, monitor } = await setup(t, classifier);
    const event = { ...comment, actor: { login: 'service', bot: true }, body: 'Action needed' };
    for (let i = 0; i < 2; i++) await monitor.observe({ snapshot: A, sources: completeSources, events: [event] });
    const activity = store.activities('A')[0]!;
    assert.equal(activity.decision, variant.decision);
    assert.deepEqual(calls, variant.absent ? [] : ['Action needed']);
    assert.equal(store.notifications().length, variant.decision === 'eligible' ? 1 : 0);
    if (variant.reason) assert.deepEqual(activity.classification, { type: 'fallback', reason: variant.reason });
  });
}

const actorCases = [
  { name: 'self', actor: { login: 'ALEx', bot: true }, category: 'self' },
  { name: 'human', actor: { login: 'bea', bot: false }, category: 'human_other' },
  { name: 'bot metadata', actor: { login: 'service', bot: true }, category: 'bot' },
  { name: 'bot suffix', actor: { login: 'checks[BOT]', bot: false }, category: 'bot' },
  { name: 'unknown', actor: null, category: 'human_other' },
] as const;

test('actor × ownership × activity decision matrix', async t => {
  const cases = [
    { kind: 'comment', source: 'issue_comment', attention: true, sound: 'comment' },
    { kind: 'inline_comment', source: 'inline_comment', attention: true, sound: 'comment' },
    { kind: 'review', source: 'review', attention: true, sound: 'comment' },
    { kind: 'approval', source: 'review', attention: true, sound: 'approval' },
    { kind: 'changes_requested', source: 'review', attention: true, sound: null },
    { kind: 'close', source: 'timeline', attention: false, sound: null },
    { kind: 'merge', source: 'timeline', attention: false, sound: null },
    { kind: 'reopen', source: 'timeline', attention: false, sound: null },
    { kind: 'ready_for_review', source: 'timeline', attention: false, sound: null },
    { kind: 'converted_to_draft', source: 'timeline', attention: false, sound: null },
    { kind: 'commit', source: 'timeline', attention: false, sound: null },
    { kind: 'ci_failure', source: 'ci', attention: false, sound: null },
    { kind: 'ci_success', source: 'ci', attention: false, sound: null },
  ] as const;
  const calls: string[] = [];
  const { store, monitor } = await setup(t, { async classify(body) { calls.push(body); return notify; } });
  for (const snapshot of [A, B]) {
    for (const actor of actorCases) {
      for (const item of cases) {
        const own = snapshot.id === 'A';
        const id = `${snapshot.id}/${actor.name}/${item.kind}`;
        const before = store.notifications().length;
        const beforeCalls = calls.length;
        const eligible = item.kind.startsWith('ci_') ? own
          : item.kind !== 'commit' && actor.category !== 'self' && !(item.attention && actor.category === 'bot' && !own);
        await monitor.observe({ snapshot, sources: completeSources, events: [{
          ...comment, id, kind: item.kind, source: item.source, actor: actor.actor,
        }] });
        assert.equal(store.notifications().length - before, Number(eligible), id);
        assert.equal(calls.length - beforeCalls, Number(item.attention && actor.category === 'bot' && own), `${id} classifier`);
        const activity = store.activities(snapshot.id).at(-1)!;
        assert.equal(activity.actorType, actor.category, id);
        assert.equal(activity.visible, true, id);
        if (eligible) {
          const intent = store.notifications().at(-1)!.data.intent;
          assert.equal(intent.kind, actor.category === 'human_other' && ['approval', 'changes_requested'].includes(item.kind) ? 'immediate' : 'bundled', id);
          assert.equal(intent.sound, own ? item.sound : null, id);
          assert.equal(intent.expiryMs, (own && item.attention) || item.kind === 'ready_for_review' ? 0 : 10000, id);
        } else assert.equal(activity.delivery, 'none', id);
      }
    }
  }
});

test('blank bot bodies bypass classifier; formal changes remain sticky without sound', async t => {
  const { store, monitor } = await setup(t, { async classify() { assert.fail('Blank content must bypass classification'); } });
  for (const [index, kind] of ['comment', 'approval', 'changes_requested'].entries()) {
    await monitor.observe({ snapshot: A, sources: completeSources, events: [{
      ...comment, id: String(index), source: kind === 'comment' ? 'issue_comment' : 'review', kind,
      actor: { login: 'checks[bot]' }, body: ' \n\t ',
    }] });
  }
  assert.deepEqual(store.notifications().map(({ data }) => [data.intent.expiryMs, data.intent.sound]), [[0, 'comment'], [0, 'approval'], [0, null]]);
});

test('current-review exception uses detail, ownership and manual tracking, never stale discovery reason', async t => {
  const { monitor, store } = await setup(t);
  for (const [id, author, state, requestedReviewers, requestedTeams] of [
    ['stale', 'bea', 'open', [], []],
    ['closed', 'bea', 'closed', ['alex'], []],
    ['merged', 'bea', 'merged', ['alex'], []],
    ['team', 'bea', 'open', [], ['acme/platform']],
    ['own', 'ALEx', 'open', ['alex'], []],
    ['manual', 'bea', 'open', ['aLeX'], []],
  ] as const) {
    monitor.track({ ...B, id, author, state, requestedReviewers, requestedTeams }, id === 'manual' ? 'manual' : 'discovery');
  }
  assert.deepEqual(store.notifications().map(item => item.data.intent.prId), ['manual']);
});

test('review projection survives unchanged responses and restores a masked decision', async t => {
  const { monitor, store } = await setup(t);
  const reviews = [
    { id: 'r1', reviewer: { login: 'Bea' }, state: 'approved', submittedAt: '2026-10-22T11:58:00Z' },
    { id: 'r2', reviewer: { login: 'BEA' }, state: 'changes_requested', submittedAt: '2026-10-22T11:59:00Z' },
    { id: 'r3', reviewer: { login: 'bea' }, state: 'pending', submittedAt: null },
  ];
  await monitor.observe({ snapshot: { ...A, requestedReviewers: ['bea'] }, sources: completeSources, events: [], reviews });
  assert.equal(monitor.responsibility(store.pr('A')!).reviewers.bea, 'requested');
  const unchanged = Object.fromEntries(sourceNames.map(source => [source, 'unchanged']));
  await monitor.observe({ snapshot: A, sources: unchanged, events: [] });
  assert.equal(monitor.responsibility(store.pr('A')!).reviewers.bea, 'changes_requested');
  await monitor.observe({ snapshot: A, sources: completeSources, events: [], reviews: [
    ...reviews, { id: 'r4', reviewer: { login: 'bea' }, state: 'dismissed', submittedAt: T },
  ] });
  assert.equal(monitor.responsibility(store.pr('A')!).reviewers.bea, 'dismissed');
});

test('queue partition requires organization-qualified team membership', async t => {
  const { monitor } = await setup(t);
  const snapshots = [A, { ...B, draft: true, requestedReviewers: ['Alex'] },
    { ...B, requestedTeams: ['acme/platform'] }, { ...B, requestedTeams: ['other/platform'] }, B,
    { ...B, state: 'closed' as const, requestedReviewers: ['alex'] }];
  const queues = snapshots.map(snapshot => monitor.responsibility(PullRequest.parse({
    snapshot, tracked: true, manualUntracked: false, generation: 1, baselineComplete: true,
    completeSources: [], reviewAlertAt: null, reviews: [],
  })).queue);
  assert.deepEqual(queues, ['my-prs', 'needs-my-review', 'needs-my-review', 'review-requests', 'review-requests', 'review-requests']);
});

test('invalid targets/times/source shapes fail atomically before staging or baseline completion', async t => {
  const { store, monitor } = await setup(t);
  const fresh = { ...B, id: 'fresh' };
  monitor.track(fresh, 'manual');
  const invalid = [
    { ...comment, source: 'timeline', kind: 'review_requested' },
    { ...comment, source: 'timeline', kind: 'review_requested', targetUser: ' ' },
    { ...comment, occurredAt: '2026-02-30T12:00:00Z' },
    { ...comment, occurredAt: '2026-10-22T12:00:00' },
    { ...comment, source: 'review' },
  ];
  for (const event of invalid) {
    await assert.rejects(monitor.observe({ snapshot: fresh, sources: completeSources, events: [comment, event] }));
    assert.equal(store.pr('fresh')!.baselineComplete, false);
    assert.deepEqual(store.activities('fresh'), []);
    assert.deepEqual(store.staged('fresh'), []);
  }
  await assert.rejects(monitor.observe({ snapshot: fresh, sources: { ...completeSources, comments: 'unchanged' }, events: [] }), /without a complete/);
});

test('formatted text is inert, readable and limited to 100 Unicode characters', async t => {
  assert.equal(readable('[![Quality Gate Failed](https://image.test)](https://link.test) [1 New issue](https://issue.test) <!-- hidden -->'), 'Quality Gate Failed 1 New issue');
  assert.equal(readable('```js\nalert(1)\n```'), '');
  const { monitor, store } = await setup(t);
  const long = '😀'.repeat(101);
  await monitor.observe({ snapshot: A, sources: completeSources, events: [{ ...comment, body: long }] });
  const body = store.notifications()[0]!.data.intent.body;
  assert.equal(body, `bea: 💬 commented: ${'😀'.repeat(97)}...`);
});

test('transient failure does not block another notification and never waits for dismissal', async t => {
  const { monitor, store, desktop, delivery } = await setup(t);
  for (const snapshot of [A, B]) await monitor.observe({ snapshot, sources: completeSources, events: [comment] });
  desktop.results = ['transient', 'sent'];
  await delivery.runDue();
  assert.deepEqual(store.notifications().map(item => item.data.status), ['failed', 'sent']);
  assert.equal(desktop.submissions.length, 2);
});

test('deadline is measured from failed completion and resend during submission is coalesced', async t => {
  const { monitor, store, clock } = await setup(t);
  await monitor.observe({ snapshot: A, sources: completeSources, events: [comment] });
  let finish!: (result: 'transient') => void;
  let started!: () => void;
  const submitted = new Promise<void>(resolve => { started = resolve; });
  let submissions = 0;
  const desktop: Desktop = { submit: async () => {
    submissions++;
    started();
    return new Promise(resolve => { finish = resolve; });
  } };
  const delivery = new Delivery(store, clock, desktop);
  const first = delivery.runDue();
  await submitted;
  const resends = [delivery.resend(1), delivery.resend(1)];
  clock.set('2026-10-22T12:00:20Z');
  finish('transient');
  await Promise.all([first, ...resends]);
  assert.equal(submissions, 1);
  assert.equal(store.notification(1).attempts, 1);
  assert.equal(store.notification(1).preparedAt, T);
  assert.equal(store.notification(1).nextAttemptAt, '2026-10-22T12:01:20.000Z');
});

test('crash after desktop acceptance consumes an attempt and permits one bounded duplicate', async t => {
  const { monitor, store, path, directory, clock, desktop } = await setup(t);
  await monitor.observe({ snapshot: A, sources: completeSources, events: [comment] });
  const log = join(directory, 'accepted.jsonl');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-worker.js', import.meta.url)), path, log, T], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  assert.equal(store.notification(1).attempts, 1);
  assert.equal(store.notification(1).runningAt, T);
  assert.equal(store.notification(1).deliveredAt, null);
  const restarted = new Store(path);
  try {
    const recovered = new Delivery(restarted, clock, desktop);
    recovered.recover();
    recovered.recover();
    assert.equal(restarted.notification(1).nextAttemptAt, '2026-10-22T12:01:00.000Z');
    assert.equal(restarted.notification(1).reason, 'ambiguous');
    await recovered.runDue();
    assert.equal(desktop.submissions.length, 0);
    clock.set('2026-10-22T12:01:00Z');
    await recovered.runDue();
    await recovered.runDue();
    assert.equal(desktop.submissions.length, 1);
    assert.equal(restarted.notification(1).status, 'sent');
    assert.equal(restarted.notification(1).attempts, 2);
    assert.deepEqual(restarted.attempts(1).map(attempt => attempt.data.result), ['ambiguous', 'sent']);
  } finally { restarted.close(); }
});

test('a pending notification recovers without any new GitHub observation', async t => {
  const { monitor, path, desktop, clock } = await setup(t);
  await monitor.observe({ snapshot: A, sources: completeSources, events: [comment] });
  const restarted = new Store(path);
  try {
    const delivery = new Delivery(restarted, clock, desktop);
    delivery.recover();
    await delivery.runDue();
    assert.equal(restarted.notification(1).status, 'sent');
    assert.equal(desktop.submissions.length, 1);
  } finally { restarted.close(); }
});

test('automatic submission starts just before, but never at, the 24-hour limit', async t => {
  const { monitor, clock, delivery, store, desktop } = await setup(t);
  await monitor.observe({ snapshot: A, sources: completeSources, events: [comment] });
  clock.set('2026-10-23T11:59:59.999Z');
  desktop.results = ['transient'];
  await delivery.runDue();
  assert.equal(store.notification(1).attempts, 1);
  clock.set('2026-10-23T12:00:00Z');
  await delivery.runDue();
  assert.equal(store.notification(1).reason, 'expired');
  assert.equal(desktop.submissions.length, 1);
});
