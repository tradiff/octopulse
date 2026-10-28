import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Profile } from '../src/profile.js';
import { Snapshot, Event } from '../src/model.js';
import { Monitor } from '../src/monitor.js';
import { Delivery } from '../src/delivery.js';
import { Diagnostics } from '../src/diagnostics.js';
import { pullRequestUrl } from '../src/config.js';
import { listenLocal } from '../src/server.js';
import { VirtualClock, RecordingDesktop, completeSources, temporaryProfile } from './fixture.js';
import { reviewComment } from './comment-fixture.js';
import { Settings } from '../src/settings.js';
import type { RefreshStatus } from '../src/scheduler.js';

export async function webFixture(richComments = false, environment: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'fixture-environment-token' }) {
  const directory = await temporaryProfile();
  const profile = new Profile(directory); const store = profile.store;
  const clock = new VirtualClock('2026-10-22T12:00:00Z');
  const monitor = new Monitor(store, clock, 'alex', ['acme/platform'], '2026-10-21T00:00:00Z');
  const desktop = new RecordingDesktop(); const delivery = new Delivery(store, clock, desktop);
  const logs = new Diagnostics(join(directory, 'logs'), clock, 'debug', 14 * 86400000, ['fixture-secret'], () => {});
  const snapshots = [
    Snapshot.parse({ id: 'A', repository: 'acme/widget', number: 7, title: 'Make workflow retries reliable', author: 'alex', head: 'h1', mergeStatus: 'clean' }),
    Snapshot.parse({ id: 'B', repository: 'acme/widget', number: 8, title: 'Improve review request routing', author: 'bea', draft: true, requestedReviewers: ['ALEX'], mergeStatus: 'dirty' }),
    Snapshot.parse({ id: 'C', repository: 'acme/service', number: 12, title: 'Reduce background polling overhead', author: 'cam', requestedTeams: ['acme/platform'], mergeStatus: 'blocked' }),
    Snapshot.parse({ id: 'D', repository: 'acme/service', number: 13, title: 'Document configuration defaults', author: 'dan' }),
    Snapshot.parse({ id: 'E', repository: 'acme/widget', number: 4, title: 'Earlier merged change', author: 'alex', state: 'merged', mergedAt: '2026-10-01T00:00:00Z' }),
  ];
  for (const snapshot of snapshots) { monitor.track(snapshot, 'manual'); await monitor.observe({ snapshot, events: [], sources: completeSources }); }
  const first = snapshots[0]!;
  await monitor.observe({ snapshot: first, sources: completeSources, events: [
    Event.parse({ source: 'issue_comment', id: 'hello', kind: 'comment', actor: { login: 'bea' }, occurredAt: clock.now(), body: richComments ? reviewComment : '**Looks good.** Could you add a timeout regression?' }),
    Event.parse({ source: 'issue_comment', id: 'self', kind: 'comment', actor: { login: 'alex' }, occurredAt: clock.now(), body: 'Added the test.' }),
    Event.parse({ source: 'review', id: 'approval', kind: 'approval', actor: { login: 'cam' }, occurredAt: clock.now(), body: 'Approved' }),
  ], reviews: [{ id: 'approval', reviewer: { login: 'cam', bot: false }, state: 'approved', submittedAt: clock.now() }], workflows: [{
    id: 'run1', workflowId: 'build', trigger: 'pull_request', runNumber: 1, attempt: 1, head: 'h1', name: 'Build', updatedAt: clock.now(),
    status: 'in_progress', conclusion: null, jobsComplete: true, jobs: [{ id: 'j1', name: 'Linux tests', runId: 'run1', attempt: 1, head: 'h1', status: 'in_progress', conclusion: null }],
  }] });
  monitor.reconcile();
  const original = store.notifications().find(item => item.data.intent.prId === 'A')!.data;
  for (let i = 0; i < 53; i++) store.insertNotification({ ...original, createdAt: new Date(Date.parse(clock.now()) + i * 1000).toISOString() });
  await delivery.runDue();
  logs.write('info', 'Synthetic discovery complete', { count: snapshots.length }); logs.write('warn', 'Synthetic provider timeout', { recovered: true });
  let tracks = 0;
  const settings = new Settings(store, undefined, environment);
  let refreshStatus: RefreshStatus | null = null;
  const app = {
    store, monitor, delivery, logs, login: 'alex', teams: ['acme/platform'],
    settings, async updateSettings(body: unknown) { settings.update(body); },
    get refreshStatus() { return refreshStatus; },
    refresh() {
      refreshStatus = { id: 'fixture-refresh', phase: 'completed', completed: 0, total: 0, discoveryFailed: false, failedPullRequests: 0 };
      return refreshStatus;
    },
    async track(input: string, signal: AbortSignal) {
      signal.throwIfAborted(); tracks++;
      const target = pullRequestUrl(input);
      if (target.repository === 'denied/repo') throw new Error('fixture-secret');
      const existing = store.prs().find(pr => pr.snapshot.repository === target.repository && pr.snapshot.number === target.number);
      monitor.track(existing?.snapshot ?? Snapshot.parse({ id: `manual-${tracks}`, ...target, title: 'Manually tracked synthetic PR', author: 'alex' }), 'manual');
    },
  };
  const local = await listenLocal(app, 0);
  return { ...app, local, clock, desktop, directory, trackCount: () => tracks,
    async close() { await local.stop(); await monitor.stop(); await delivery.stop(); profile.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
