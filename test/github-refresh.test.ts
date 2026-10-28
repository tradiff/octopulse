import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { startApplication } from '../src/application.js';
import { Config } from '../src/config.js';
import { RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';
import type { RefreshStatus } from '../src/scheduler.js';

test('authorized refresh reaches GitHub immediately, collects new activity, preserves validators and respects rate backoff', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock('2026-10-23T12:00:00Z');
  let discoverNew = false; let rateLimited = false;
  let discoveryGate: Promise<void> | undefined;
  let discoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
  const requests: { path: string; validator: string | null }[] = [];
  const app = await startApplication(Config.parse({ github: { token: 'synthetic-refresh-token' } }), directory, clock,
    new RecordingDesktop(), new AbortController().signal, 0, async (input, init) => {
      const path = new URL(input).pathname;
      const validator = new Headers(init?.headers).get('If-None-Match'); requests.push({ path, validator });
      if (path === '/user') return Response.json({ login: 'alex' });
      if (path === '/user/teams') return Response.json([]);
      if (rateLimited) return Response.json({}, { status: 429, headers: { 'Retry-After': '120' } });
      if (path === '/search/issues') {
        if (discoveryGate) { discoveryStarted(); await discoveryGate; }
        return Response.json({ total_count: discoverNew ? 1 : 0, incomplete_results: false,
          items: discoverNew ? [{ id: 999, number: 7, repository_url: 'https://api.github.com/repos/acme/widget', pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/7' } }] : [] });
      }
      if (validator) return new Response(null, { status: 304, headers: { ETag: validator } });
      const headers = { ETag: '"github-saved-data"' };
      if (path === '/repos/acme/widget/pulls/7') return Response.json({ id: 101, number: 7, title: 'Discovered from GitHub',
        user: { login: 'alex' }, state: 'open', draft: false, merged_at: null, closed_at: null, updated_at: clock.now(),
        head: { sha: 'h1' }, base: { ref: 'main', repo: { full_name: 'acme/widget' } }, requested_reviewers: [], requested_teams: [] }, { headers });
      if (path.endsWith('/actions/runs')) return Response.json({ total_count: 0, workflow_runs: [] }, { headers });
      if (path.endsWith('/issues/7/comments')) return Response.json([{ id: 201, user: { login: 'bea' }, body: 'Saved activity from GitHub', created_at: clock.now() }], { headers });
      return Response.json([], { headers });
    });
  t.after(() => app.stop()); await app.initialize();
  const { actionToken } = await (await fetch(app.origin + '/api/me')).json() as { actionToken: string };
  const start = () => fetch(app.origin + '/api/refresh', { method: 'POST', signal: AbortSignal.timeout(3_000), headers: {
    Origin: app.origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': actionToken,
  }, body: '{}' });
  const result = async () => {
    await app.scheduler.idle();
    const status = await (await fetch(app.origin + '/api/refresh')).json() as RefreshStatus;
    assert.equal(status.phase, 'completed'); assert.equal(status.completed, status.total);
    return { discoveryFailed: status.discoveryFailed, failedPullRequests: status.failedPullRequests };
  };
  const refresh = async () => { assert.equal((await start()).status, 202); return result(); };
  requests.length = 0; discoverNew = true;
  let release!: () => void;
  discoveryGate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const accepted = await start(); assert.equal(accepted.status, 202);
  const initial = await accepted.json() as RefreshStatus;
  await started;
  assert.equal(initial.phase, 'discovering', 'The response closes while GitHub discovery is still blocked');
  assert.equal((await (await start()).json() as RefreshStatus).id, initial.id, 'Repeated starts share one job');
  assert.equal((await (await fetch(app.origin + '/api/refresh')).json() as RefreshStatus).id, initial.id);
  release(); discoveryGate = undefined;
  assert.deepEqual(await result(), { discoveryFailed: false, failedPullRequests: 0 });
  assert.equal(requests.filter(request => request.path === '/search/issues').length, 2);
  assert.equal(app.profile.store.pr('101')!.snapshot.title, 'Discovered from GitHub');
  assert.ok(app.profile.store.activities('101').some(activity => activity.event.body === 'Saved activity from GitHub'));
  requests.length = 0;
  assert.deepEqual(await refresh(), { discoveryFailed: false, failedPullRequests: 0 });
  assert.ok(requests.some(request => request.validator === '"github-saved-data"'), 'Manual checks retain GitHub conditional requests');
  requests.length = 0; rateLimited = true;
  assert.deepEqual(await refresh(), { discoveryFailed: true, failedPullRequests: 1 });
  assert.equal(requests.length, 1);
  assert.deepEqual(await refresh(), { discoveryFailed: true, failedPullRequests: 1 });
  assert.equal(requests.length, 1, 'Repeated manual refreshes do not bypass the GitHub retry deadline');
});
