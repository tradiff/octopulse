import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { filters } from '../src/filters.js';
import { pullRequests, notificationHistory } from '../src/views.js';
import { listenLocal } from '../src/server.js';
import { Event } from '../src/model.js';
import { startApplication } from '../src/application.js';
import { parseConfig } from '../src/config.js';
import { Profile } from '../src/profile.js';
import { readFile, rm } from 'node:fs/promises';
import { webFixture } from './web-fixture.js';
import { completeSources, temporaryProfile, VirtualClock, RecordingDesktop } from './fixture.js';

test('filter defaults distinguish omitted, recognized empty and unknown values', () => {
  assert.deepEqual(filters(new URLSearchParams()), { tracking: ['tracked'], lifecycle: ['open'], repository: '', actors: [] });
  assert.deepEqual(filters(new URLSearchParams('unknown=x')).tracking, ['tracked']);
  for (const query of ['pr-state=all', 'pr-state=nonsense', 'repo=', 'actor-type=unknown']) {
    const value = filters(new URLSearchParams(query), true); assert.deepEqual(value.tracking, []); assert.deepEqual(value.lifecycle, []);
  }
  const many = filters(new URLSearchParams('pr-state=open&pr-state=merged&pr-state=inactive&repo=acme/widget&actor-type=bot'), true);
  assert.deepEqual(many.lifecycle, ['open', 'merged']); assert.deepEqual(many.tracking, ['inactive']); assert.deepEqual(many.actors, ['bot']);
});

test('PR projection partitions queues, groups reviewers, separates blocked teams and hides stale-head CI', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const { store, monitor } = fixture;
  const own = pullRequests(store, monitor, new URLSearchParams()).items.find(pr => pr.id === 'A')!;
  assert.equal(own.merge, 'No merge conflicts');
  assert.equal(own.ci.counts.pending, 1, 'Conflict-free mergeability does not imply finished CI');
  let page = pullRequests(store, monitor, new URLSearchParams());
  assert.deepEqual(page.counts, { 'my-prs': 1, 'needs-my-review': 2, 'review-requested': 1 });
  assert.equal(page.items.find(pr => pr.id === 'B')!.state, 'draft');
  const team = page.items.find(pr => pr.id === 'C')!;
  assert.equal(team.merge, 'Blocked by rules'); assert.deepEqual(team.pendingTeams, ['acme/platform']);
  assert.equal(page.items.find(pr => pr.id === 'A')!.ci.counts.pending, 1);
  monitor.untrack('B');
  page = pullRequests(store, monitor, new URLSearchParams('pr-state=all'));
  assert.equal(page.items.find(pr => pr.id === 'B')!.queue, 'needs-my-review');
  assert.equal(page.items.find(pr => pr.id === 'E')!.merge, null);
  const pr = store.pr('A')!;
  await monitor.observe({ snapshot: { ...pr.snapshot, head: 'h2', requestedReviewers: ['CAM', 'robot'], requestedActors: [{ login: 'robot', bot: true }] },
    sources: completeSources, events: [], reviews: pr.reviews, workflows: [] });
  const changed = pullRequests(store, monitor, new URLSearchParams()).items.find(pr => pr.id === 'A')!;
  assert.deepEqual(changed.groups.approvers, []); assert.deepEqual(changed.groups.requested.map(person => person.login.toLowerCase()), ['cam']);
  assert.deepEqual(changed.ci.workflows, []);
  assert.ok(changed.timeline.some(item => item.decision === 'self'));
  assert.ok(changed.groups.commenters.some(person => person.login === 'alex'));
});

test('history filters before counting, clamps pages, preserves bundles and uses current PR state', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const { store, monitor } = fixture;
  const page = notificationHistory(store, new URLSearchParams());
  assert.equal(page.items.length, 50); assert.equal(page.pages, 2); assert.ok(page.total > 50);
  assert.ok(page.items[0]!.id > page.items.at(-1)!.id);
  assert.equal(notificationHistory(store, new URLSearchParams('page=9999')).page, 2);
  for (const invalid of ['0', '-1', 'text', '1.2', 'Infinity']) assert.equal(notificationHistory(store, new URLSearchParams(`page=${invalid}`)).page, 1);
  const empty = notificationHistory(store, new URLSearchParams('repo=missing/repo&page=999'));
  assert.deepEqual([empty.page, empty.pages, empty.from, empty.to, empty.total], [1, 1, 0, 0, 0]);
  assert.equal(notificationHistory(store, new URLSearchParams('actor-type=self')).total, 0);
  const original = store.pr('A')!;
  await monitor.observe({ snapshot: original.snapshot, sources: completeSources, events: [
    Event.parse({ source: 'issue_comment', id: 'human', kind: 'comment', actor: { login: 'bea' }, occurredAt: fixture.clock.now(), body: 'Human paragraph' }),
    Event.parse({ source: 'timeline', id: 'bot', kind: 'reopen', actor: { login: 'automation', bot: true }, occurredAt: fixture.clock.now() }),
  ] });
  const bots = notificationHistory(store, new URLSearchParams('actor-type=bot'));
  assert.equal(bots.total, 1); assert.match(bots.items[0]!.intent.body, /Human paragraph/); assert.match(bots.items[0]!.intent.body, /automation/);
  monitor.track({ ...original.snapshot, title: 'Renamed current PR', state: 'closed', closedAt: fixture.clock.now() }, 'discovery'); monitor.reconcile();
  assert.equal(notificationHistory(store, new URLSearchParams()).items.some(record => record.intent.prId === 'A'), false);
  const inactive = notificationHistory(store, new URLSearchParams('pr-state=inactive&pr-state=closed'));
  assert.ok(inactive.total > 50); assert.equal(inactive.items[0]!.pr.snapshot.title, 'Renamed current PR');
  assert.notEqual(inactive.items[0]!.intent.title, 'Renamed current PR');
});

test('local routes, HEAD, mutation statuses, validation and same-origin protection', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const origin = fixture.local.origin;
  const me = await (await fetch(`${origin}/api/me`)).json() as { actionToken: string; login: string };
  assert.equal(me.login, 'alex');
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken };
  for (const path of ['/', '/notification-history', '/logs', '/health', '/icon.svg', '/favicon.svg']) {
    const get = await fetch(origin + path); assert.equal(get.status, 200);
    const head = await fetch(origin + path, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(get.headers.get('access-control-allow-origin'), null); assert.ok(get.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  }
  assert.deepEqual(await (await fetch(origin + '/health')).json(), { status: 'ok' });
  const icon = await fetch(origin + '/icon.svg');
  assert.match(icon.headers.get('content-type')!, /^image\/svg\+xml/);
  assert.equal(await icon.text(), await readFile(new URL('../../assets/octopulse-mark-blue.svg', import.meta.url), 'utf8'));
  const favicon = await fetch(origin + '/favicon.svg');
  assert.equal(favicon.status, 200);
  assert.equal(await favicon.text(), await readFile(new URL('../../assets/octopulse-mark-small-blue.svg', import.meta.url), 'utf8'));
  for (const state of ['open', 'draft', 'merged', 'closed']) {
    const icon = await fetch(`${origin}/git-${state}.svg`);
    assert.equal(icon.status, 200); assert.match(icon.headers.get('content-type')!, /^image\/svg\+xml/);
    assert.equal(await icon.text(), await readFile(new URL(`../../assets/git-${state}.svg`, import.meta.url), 'utf8'));
    const head = await fetch(`${origin}/git-${state}.svg`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const inline = await fetch(`${origin}/git-${state}-inline.svg`);
    assert.equal(inline.status, 200); assert.match(inline.headers.get('content-type')!, /^image\/svg\+xml/);
    assert.equal(await inline.text(), await readFile(new URL(`../../assets/git-${state}-inline.svg`, import.meta.url), 'utf8'));
  }
  assert.equal((await fetch(origin + '/no-route')).status, 404);
  assert.equal((await fetch(origin + '/api/me', { method: 'POST' })).status, 404);
  assert.equal((await fetch(origin + '/api/tracked-pull-requests', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/api/tracked-pull-requests', { method: 'POST', headers: { ...headers, 'X-Octopulse-Action': 'bad' }, body: '{}' })).status, 403);
  for (const body of ['invalid', '[]', '{}', '{"url":" "}', JSON.stringify({ url: 'x'.repeat(17000) }), JSON.stringify({ url: 'https://github.com/denied/repo/pull/7' })]) {
    const response = await fetch(origin + '/api/tracked-pull-requests', { method: 'POST', headers, body }); assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /fixture-secret/);
  }
  const existing = await fetch(origin + '/api/tracked-pull-requests', { method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/widget/pull/7' }) }); assert.equal(existing.status, 200);
  const added = await fetch(origin + '/api/tracked-pull-requests', { method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/widget/pull/100' }) }); assert.equal(added.status, 201);
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await fetch(origin + '/api/tracked-pull-requests/A', { method: 'DELETE', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(origin + '/api/tracked-pull-requests/missing', { method: 'DELETE', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(origin + '/api/notification-records/999999/resend', { method: 'POST', headers, body: '{}' })).status, 500);
  fixture.desktop.results = ['transient'];
  assert.equal((await fetch(origin + '/api/notification-records/1/resend', { method: 'POST', headers, body: '{}' })).status, 500);
  assert.equal((await fetch(origin + '/api/notification-records/1/resend', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await (await fetch(origin + '/api/inactive-pull-requests')).json() as { id: string }[]).some(pr => pr.id === 'A'), true);
  const before = fixture.trackCount(); await fetch(origin + '/api/pull-request-timeline'); await fetch(origin + '/api/notification-history'); assert.equal(fixture.trackCount(), before);
  const badHost = await new Promise<number>(resolve => { const req = request(origin + '/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
  assert.equal(badHost, 403);
});

test('occupied loopback port rejects startup and ordinary reads expose no caches or raw payloads', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  await assert.rejects(listenLocal(fixture, Number(new URL(fixture.local.origin).port)), /EADDRINUSE/);
  const response = await fetch(fixture.local.origin + '/api/pull-request-timeline');
  const text = await response.text(); assert.doesNotMatch(text, /fetchState|rawIds|validator|actionToken|fixture-secret/);
  const logs = await (await fetch(fixture.local.origin + '/api/logs?level=warn')).json() as { items: { level: string }[] };
  assert.deepEqual(logs.items.map(item => item.level), ['warn']);
});

test('local mutation size limit rejects an otherwise valid tracking request', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const origin = fixture.local.origin;
  const { actionToken } = await (await fetch(origin + '/api/me')).json() as { actionToken: string };
  const body = JSON.stringify({ url: 'https://github.com/acme/widget/pull/7' }) + ' '.repeat(16 * 1024);
  const response = await fetch(origin + '/api/tracked-pull-requests', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Octopulse-Action': actionToken }, body,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid or oversized JSON body' });
  assert.equal(fixture.trackCount(), 0);
});

test('application composition releases ownership on listen failure and shutdown', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = parseConfig('[github]\ntoken="synthetic"\nlogin="alex"');
  const clock = new VirtualClock('2026-10-22T12:00:00Z');
  const transport = async (url: string) => new Response(JSON.stringify(url.includes('/user/teams') ? [] : { total_count: 0, incomplete_results: false, items: [] }));
  await assert.rejects(startApplication(config, directory, clock, new RecordingDesktop(), new AbortController().signal, Number(new URL(fixture.local.origin).port), transport), /EADDRINUSE/);
  const released = new Profile(directory); released.close();
  const app = await startApplication(config, directory, clock, new RecordingDesktop(), new AbortController().signal, 0, transport);
  t.after(() => app.stop());
  await app.initialize();
  assert.equal(app.profile.store.metadata('discoveryComplete'), clock.now());
  assert.equal((await fetch(app.origin + '/health')).status, 200);
  await app.stop(); await app.stop();
  const reopened = new Profile(directory); reopened.close();
});
