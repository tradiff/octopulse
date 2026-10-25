import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { Snapshot, Workflow } from '../src/model.js';
import { evaluateCi } from '../src/ci.js';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { Collector } from '../src/collector.js';
import { completeSources, temporaryProfile, VirtualClock } from './fixture.js';

test('the complete malformed response survives restart and retention, not just its diagnostic count', async t => {
  const directory = await temporaryProfile();
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const clock = new VirtualClock('2026-10-22T12:00:00Z');
  const snapshot = Snapshot.parse({ id: 'A', repository: 'acme/widget', number: 7, title: 'Invalid input', author: 'alex' });
  const monitor = new Monitor(store, clock, 'alex', [], '2026-10-21T12:00:00Z');
  monitor.track(snapshot, 'manual');
  await monitor.observe({ snapshot, sources: completeSources, events: [] });
  const response = { status: 200, validator: 'failed-page', next: null, items: [
    { id: 'missing-time', body: 'Content needed for repair', metadata: { original: ['retain', 42, null] } },
  ] };
  const collector = new Collector(store, clock, { async request(_snapshot, request) {
    return request.resource === 'detail' ? { status: 200, validator: 'detail', next: null, items: [snapshot] } : response;
  } });
  await assert.rejects(monitor.poll('A', (pr, signal) => collector.collect(pr, signal)));
  store.close();
  store = new Store(path);
  store.prune('2030-01-01T00:00:00Z', 1);
  const failures = store.failedInputs('A');
  assert.equal(failures.length, 1);
  const saved = z.object({ lastResponse: z.unknown(), pages: z.record(z.string(), z.object({ items: z.array(z.unknown()) })) }).parse(failures[0]!.payload);
  assert.deepEqual(saved.lastResponse, response);
  assert.ok(Object.values(saved.pages).some(page => JSON.stringify(page.items) === JSON.stringify(response.items)));
});

test('unresolved CI ordering remains uncertain across empty refreshes until the same run is repaired', () => {
  const failure = Workflow.parse({ id: 'r1', workflowId: 'build', trigger: 'push', runNumber: 1, attempt: 1,
    head: 'h1', name: 'Build', updatedAt: '2026-10-22T12:00:00Z', status: 'completed', conclusion: 'failure', jobs: [], jobsComplete: true });
  const established = evaluateCi('h1', undefined, [failure], '2026-10-22T12:00:00Z').state;
  const uncertain = evaluateCi('h1', established, [{ ...failure, id: 'r2', runNumber: null, conclusion: 'success' }], '2026-10-22T12:01:00Z').state;
  assert.equal(uncertain.uncertain, true);
  const unchanged = evaluateCi('h1', uncertain, [], '2026-10-22T12:02:00Z');
  assert.equal(unchanged.state.uncertain, true);
  assert.equal(unchanged.state.outcome, 'failure');
  const repaired = evaluateCi('h1', unchanged.state, [{ ...failure, id: 'r2', runNumber: 2, conclusion: 'success' }], '2026-10-22T12:03:00Z');
  assert.equal(repaired.state.uncertain, false);
  assert.equal(repaired.state.outcome, 'success');
  assert.equal(repaired.event?.kind, 'ci_success');
});
