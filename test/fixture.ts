import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Event, Instant, Review, Snapshot, Sources, Workflow, eventKey } from '../src/model.js';
import type { Classifier, Clock, Desktop, Intent } from '../src/model.js';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { Delivery } from '../src/delivery.js';
import { ciSummary } from '../src/ci.js';
import { Scheduler } from '../src/scheduler.js';
import { Collector } from '../src/collector.js';
import { readable } from '../src/presentation.js';
import { notificationHistory, pullRequests } from '../src/views.js';

export const completeSources = {
  comments: 'complete', reviews: 'complete', inlineComments: 'complete',
  timeline: 'complete', workflows: 'complete', jobs: 'complete',
} as const;
export const avatarPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIklEQVQ4jWNQmLbqPzUww6hB/0fDaNVoOlo1mkWmDadiBABeigBqVE3ylwAAAABJRU5ErkJggg==', 'base64');
const patch = z.strictObject({
  title: z.string().optional(), state: z.enum(['open', 'closed', 'merged']).optional(),
  draft: z.boolean().optional(), requestedReviewers: z.array(z.string()).optional(), requestedTeams: z.array(z.string()).optional(),
  head: z.string().nullable().optional(), updatedAt: Instant.nullable().optional(),
  closedAt: Instant.nullable().optional(), mergedAt: Instant.nullable().optional(),
});
const ObservedStep = z.strictObject({ action: z.literal('observe'), pr: z.string(), snapshot: patch.default({}),
  sources: Sources.default(completeSources), events: z.array(Event).default([]), reviews: z.array(Review).default([]),
  workflows: z.array(Workflow).optional() });
const Step = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('track'), pr: z.string(), origin: z.enum(['manual', 'discovery']).default('manual'), snapshot: patch.default({}) }),
  z.strictObject({ action: z.literal('untrack'), pr: z.string() }),
  ObservedStep,
  z.strictObject({ action: z.literal('observeTogether'), observations: z.array(ObservedStep) }),
  z.strictObject({ action: z.literal('clock'), at: Instant }),
  z.strictObject({ action: z.literal('restart') }),
  z.strictObject({ action: z.literal('deliver') }),
  z.strictObject({ action: z.literal('resend'), notification: z.number().int().positive(), simultaneous: z.number().int().positive().default(1) }),
  z.strictObject({ action: z.literal('provider'), responses: z.array(z.unknown()) }),
  z.strictObject({ action: z.literal('desktop'), results: z.array(z.enum(['sent', 'transient', 'permanent'])) }),
  z.strictObject({ action: z.literal('expect'), state: z.record(z.string(), z.unknown()) }),
  z.strictObject({ action: z.literal('prune'), retentionMs: z.number().positive() }),
  z.strictObject({ action: z.literal('reconcile') }),
  z.strictObject({ action: z.literal('text'), body: z.string() }),
  z.strictObject({ action: z.literal('identity'), login: z.string() }),
  z.strictObject({ action: z.literal('reclaim') }),
  z.strictObject({ action: z.literal('view'), page: z.enum(['pulls', 'history']), query: z.string().default('') }),
  z.strictObject({ action: z.literal('startScheduler'), activeMs: z.number().positive().default(60_000), discoveryMs: z.number().positive().default(300_000) }),
  z.strictObject({ action: z.literal('tick'), fail: z.array(z.string()).default([]) }),
  z.strictObject({ action: z.literal('stop') }),
  z.strictObject({ action: z.literal('fetch'), pr: z.string(), responses: z.array(z.strictObject({ request: z.record(z.string(), z.unknown()), response: z.unknown() })), error: z.string().optional() }),
]);
export const Fixture = z.strictObject({
  version: z.literal(1), id: z.string().min(1), requirements: z.array(z.string()).min(1),
  time: Instant, user: z.string().default('alex'), teams: z.array(z.string()).default(['acme/platform']),
  reviewCutoff: Instant.default('2026-10-21T12:00:00Z'),
  classifier: z.boolean().default(false),
  pullRequests: z.record(z.string(), Snapshot),
  steps: z.array(Step).min(1),
}).refine(fixture => fixture.steps.some(step => step.action === 'expect'), 'A fixture must assert observable results');
export type Fixture = z.infer<typeof Fixture>;

export class VirtualClock implements Clock {
  constructor(private instant: string) { this.set(instant); }
  now(): string { return this.instant; }
  set(at: string): void { this.instant = new Date(Instant.parse(at)).toISOString(); }
}

export class RecordingDesktop implements Desktop {
  readonly submissions: Intent[] = [];
  results: ('sent' | 'transient' | 'permanent')[] = [];
  async submit(intent: Intent): Promise<'sent' | 'transient' | 'permanent'> {
    this.submissions.push(structuredClone(intent));
    return this.results.shift() ?? 'sent';
  }
}

class RecordingClassifier implements Classifier {
  readonly calls: string[] = [];
  responses: unknown[] = [];
  async classify(body: string): Promise<unknown> {
    this.calls.push(body);
    if (!this.responses.length) throw new Error('No synthetic provider answer supplied');
    const response = this.responses.shift();
    if (response && typeof response === 'object' && 'error' in response) throw new Error('Synthetic provider failure');
    return response;
  }
}

export async function temporaryProfile(): Promise<string> {
  const base = join(tmpdir(), 'opencode');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'octopulse-replay-'));
}

// Objects assert named logical fields; arrays assert exact length and order.
export function match(actual: unknown, expected: unknown, path = 'state'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    assert.equal(actual.length, expected.length, `${path} length`);
    expected.forEach((value, index) => match(actual[index], value, `${path}[${index}]`));
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${path} must be an object`);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `${path}.${key} does not exist`);
      match(Reflect.get(actual, key), value, `${path}.${key}`);
    }
  } else assert.deepEqual(actual, expected, path);
}

export async function replay(input: unknown): Promise<{
  fixture: string; requirements: string[]; fixedTime: string; driverVersion: number;
  status: 'pass' | 'fail'; error?: string; checkpoints: number; finalState: unknown;
}> {
  const fixture = Fixture.parse(input);
  const directory = await temporaryProfile();
  const path = join(directory, 'state.sqlite');
  const clock = new VirtualClock(fixture.time);
  const desktop = new RecordingDesktop();
  const classifier = new RecordingClassifier();
  let store = new Store(path);
  let monitor = new Monitor(store, clock, fixture.user, fixture.teams, fixture.reviewCutoff, fixture.classifier ? classifier : undefined);
  let delivery = new Delivery(store, clock, desktop);
  let scheduler: Scheduler | undefined;
  let scheduleSettings: { activeMs: number; discoveryMs: number } | undefined;
  const polls: { prId: string; at: string }[] = [];
  const discoveries: string[] = [];
  const errors: string[] = [];
  const requests: unknown[] = [];
  const texts: string[] = [];
  const views: unknown[] = [];
  let failures: string[] = [];
  const snapshots = structuredClone(fixture.pullRequests);
  let checkpoints = 0;
  let stepIndex = 0;
  function startScheduler(activeMs: number, discoveryMs: number): void {
    scheduleSettings = { activeMs, discoveryMs };
    scheduler = new Scheduler(monitor, delivery, clock, {
      async poll(pr) {
        polls.push({ prId: pr.snapshot.id, at: clock.now() });
        const failure = failures.indexOf(pr.snapshot.id);
        if (failure !== -1) { failures.splice(failure, 1); throw new Error('Synthetic poll failure'); }
        return { snapshot: pr.snapshot, sources: completeSources, events: [], reviews: pr.reviews };
      },
      async discover() { discoveries.push(clock.now()); },
      report(_error, scope) { errors.push(scope); },
    }, activeMs, discoveryMs);
  }
  async function observe(step: z.infer<typeof ObservedStep>): Promise<void> {
    const snapshot = snapshots[step.pr];
    assert.ok(snapshot, `Unknown fixture PR ${step.pr}`);
    const current = Snapshot.parse({ ...snapshot, ...step.snapshot });
    snapshots[step.pr] = current;
    await monitor.observe({ snapshot: current, sources: step.sources, events: step.events, reviews: step.reviews,
      ...(step.workflows ? { workflows: step.workflows } : {}) });
  }
  function logicalState(): unknown {
    return {
      prs: Object.fromEntries(store.prs().map(pr => [pr.snapshot.id, {
        tracked: pr.tracked, manualUntracked: pr.manualUntracked, baselineComplete: pr.baselineComplete,
        graceUntil: pr.graceUntil, origin: pr.origin, head: pr.snapshot.head,
        ci: ciSummary(pr.snapshot.head ? pr.ci[pr.snapshot.head] : undefined),
        progress: pr.fetchState.progress, failedInputs: store.failedInputCount(pr.snapshot.id),
        ...monitor.responsibility(pr),
        activities: store.activities(pr.snapshot.id).map(activity => ({
          key: eventKey(activity.event), kind: activity.event.kind, body: activity.event.body,
          actorType: activity.actorType, decision: activity.decision, delivery: activity.delivery,
          classification: activity.classification, visible: activity.visible,
        })),
        pendingObservations: store.staged(pr.snapshot.id).filter(batch => !batch.data.processed).length,
        rawEvents: store.staged(pr.snapshot.id).flatMap(batch => batch.data.observation.events.map(eventKey)),
      }])),
      notifications: store.notifications().map(({ id, data }) => ({
        ...data.intent, status: data.status, attempts: data.attempts, nextAttemptAt: data.nextAttemptAt,
        preparedAt: data.preparedAt, deliveredAt: data.deliveredAt, reason: data.reason, automatic: data.automatic,
        attemptResults: store.attempts(id).map(attempt => attempt.data.result),
      })),
      notificationCounts: Object.fromEntries(store.prs().map(pr => [pr.snapshot.id,
        store.notifications().filter(item => item.data.intent.prId === pr.snapshot.id).length])),
      submissions: desktop.submissions,
      providerCalls: classifier.calls,
      texts, views, identity: store.metadata('login') ?? null, reviewBaseline: store.metadata('reviewBaseline') ?? null,
      polls, discoveries, errors, requests, schedule: scheduler?.deadlines() ?? null,
    };
  }
  try {
    for (const step of fixture.steps) {
      stepIndex++;
      switch (step.action) {
        case 'track': {
          const snapshot = snapshots[step.pr];
          assert.ok(snapshot, `Unknown fixture PR ${step.pr}`);
          const current = Snapshot.parse({ ...snapshot, ...step.snapshot });
          snapshots[step.pr] = current;
          monitor.track(current, step.origin);
          break;
        }
        case 'observe': await observe(step); break;
        case 'observeTogether': await Promise.all(step.observations.map(observe)); break;
        case 'untrack': monitor.untrack(step.pr); break;
        case 'clock': clock.set(step.at); break;
        case 'restart':
          await scheduler?.stop();
          store.close();
          store = new Store(path);
          monitor = new Monitor(store, clock, fixture.user, fixture.teams, fixture.reviewCutoff, fixture.classifier ? classifier : undefined);
          delivery = new Delivery(store, clock, desktop);
          delivery.recover();
          if (scheduleSettings) startScheduler(scheduleSettings.activeMs, scheduleSettings.discoveryMs);
          break;
        case 'deliver': await delivery.runDue(); break;
        case 'resend': {
          const id = store.notifications()[step.notification - 1]?.id;
          assert.ok(id, 'Unknown fixture notification');
          await Promise.all(Array.from({ length: step.simultaneous }, () => delivery.resend(id)));
          break;
        }
        case 'provider': classifier.responses.push(...step.responses); break;
        case 'desktop': desktop.results.push(...step.results); break;
        case 'expect': match(logicalState(), step.state); checkpoints++; break;
        case 'prune': store.prune(clock.now(), step.retentionMs); break;
        case 'reconcile': monitor.reconcile(); break;
        case 'text': texts.push(readable(step.body)); break;
        case 'identity': store.bindIdentity(step.login, clock.now()); break;
        case 'reclaim': store.reclaim(); break;
        case 'view': views.push(step.page === 'pulls' ? pullRequests(store, monitor, new URLSearchParams(step.query)) : notificationHistory(store, new URLSearchParams(step.query))); break;
        case 'startScheduler': assert.ok(!scheduler, 'Scheduler already started'); startScheduler(step.activeMs, step.discoveryMs); break;
        case 'tick': assert.ok(scheduler, 'Scheduler not started'); failures.push(...step.fail); scheduler.tick(); await scheduler.idle(); break;
        case 'stop': await scheduler?.stop(); break;
        case 'fetch': {
          const remaining = [...step.responses];
          const collector = new Collector(store, clock, { async request(_pr, request) {
            requests.push({ prId: step.pr, ...request });
            const supplied = remaining.shift();
            assert.ok(supplied, `Unexpected request: ${JSON.stringify(request)}`);
            match(request, supplied.request, 'request');
            if (supplied.response && typeof supplied.response === 'object' && 'error' in supplied.response) throw new Error(String(supplied.response.error));
            return supplied.response;
          } });
          const fetch = monitor.poll(step.pr, (pr, signal) => collector.collect(pr, signal));
          if (step.error) await assert.rejects(fetch, new RegExp(step.error)); else await fetch;
          assert.equal(remaining.length, 0, 'Unused synthetic page responses');
          break;
        }
      }
    }
    return { fixture: fixture.id, requirements: fixture.requirements, fixedTime: fixture.time, driverVersion: 1,
      status: 'pass', checkpoints, finalState: logicalState() };
  } catch (error) {
    return { fixture: fixture.id, requirements: fixture.requirements, fixedTime: fixture.time, driverVersion: 1,
      status: 'fail', error: `Step ${stepIndex}: ${error instanceof Error ? error.message : String(error)}`,
      checkpoints, finalState: logicalState() };
  } finally {
    await scheduler?.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
