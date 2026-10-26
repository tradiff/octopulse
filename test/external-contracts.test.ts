import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Config, duration, pullRequestUrl } from '../src/config.js';
import { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { Profile } from '../src/profile.js';
import { Monitor } from '../src/monitor.js';
import { Collector } from '../src/collector.js';
import { GitHub, githubSnapshot } from '../src/github.js';
import { SystemOne } from '../src/system-one.js';
import { Diagnostics } from '../src/diagnostics.js';
import { startRuntime } from '../src/runtime.js';
import { AvatarCache, DesktopAdapter, FreedesktopTransport } from '../src/desktop.js';
import type { DesktopMessage } from '../src/desktop.js';
import { requestJson } from '../src/http.js';
import type { Fetch } from '../src/http.js';
import { avatarPng, completeSources, RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';

const T = '2026-10-22T12:00:00.000Z';
const signal = () => new AbortController().signal;
const wirePr = {
  id: 101, number: 7, title: 'Synthetic PR', user: { login: 'alex', type: 'User', avatar_url: 'https://avatars.example/alex.png' },
  state: 'open', draft: false, merged_at: null, closed_at: null, updated_at: T, head: { sha: 'head' },
  base: { ref: 'main', repo: { full_name: 'acme/widget' } }, requested_reviewers: [], requested_teams: [], mergeable_state: 'clean',
};
const snapshot = githubSnapshot(wirePr, 7);
const comment = { id: 55, user: { login: 'bea', type: 'User' }, body: 'Please fix', created_at: T, updated_at: T };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const emptySearch = () => json({ total_count: 0, incomplete_results: false, items: [] });
const configInput = { github: { token: 'github-secret' } };

async function setup(t: TestContext) {
  const directory = await temporaryProfile();
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const clock = new VirtualClock(T);
  const monitor = new Monitor(store, clock, 'alex', [], T);
  monitor.track(snapshot, 'manual');
  await monitor.observe({ snapshot, sources: completeSources, events: [] });
  return { directory, store, clock, monitor };
}

test('settings defaults, duration aliases, URL roots, and secret-free validation errors', () => {
  const minimal = Config.parse(configInput);
  assert.deepEqual(minimal.timings, { tracked_poll_interval: 60_000, discovery_poll_interval: 300_000, grace_period: 604_800_000 });
  assert.equal(minimal.logging.retention, 14 * 86_400_000);
  assert.equal(minimal.history.raw_payload_retention, 30 * 86_400_000);
  for (const [value, expected] of [[' 1.5 MiNs ', 90_000], ['0.5 ms', 1], ['1 DAY', 86_400_000], ['1hour', 3_600_000], ['2secs', 2000]] as const) assert.equal(duration(value), expected);
  for (const value of ['0 ms', '0.49ms', '-1s', '1m 2s', '1 week', '1e3s', 'Infinity s', '999999999999999999999d']) assert.throws(() => duration(value));
  for (const root of ['https://provider.example', 'https://provider.example/v1/', 'http://provider.example///']) {
    const config = Config.parse({ ...configInput, system_one: { base_url: ` ${root} `, api_key: ' provider-secret ' } });
    assert.equal(config.system_one!.model, 'jev-latest');
    assert.equal(config.system_one!.base_url, root.startsWith('https') ? 'https://provider.example/v1/systemone' : 'http://provider.example/v1/systemone');
  }
  const store = new Store(':memory:');
  try {
    const settings = new Settings(store, undefined, {});
    for (const input of ['', { github: { token: 7 } }, { github: { token: 'github-secret', typo: true } },
      { ...configInput, unknown: { key: 'provider-secret' } }, { ...configInput, timings: { tracked_poll_interval: 3 } },
      { ...configInput, logging: { level: 'trace' } },
      { ...configInput, system_one: { base_url: 'https://provider-secret@example.com', api_key: 'provider-secret', model: 'model' } }]) {
      assert.throws(() => settings.update(input), error => error instanceof Error && !/github-secret|provider-secret/.test(error.message));
    }
    for (const suffix of ['?x=1', '#fragment', '?', '#']) assert.throws(() => settings.update({ ...configInput,
      system_one: { base_url: `https://host${suffix}`, api_key: 'key', model: 'model' } }));
  } finally { store.close(); }
});

test('manual URLs require exact GitHub HTTPS PR paths and positive safe numbers', () => {
  assert.deepEqual(pullRequestUrl(' https://github.com/acme/widget/pull/7/?diff=1#top '), { repository: 'acme/widget', number: 7 });
  for (const url of ['http://github.com/acme/widget/pull/7', 'https://github.com.evil/acme/widget/pull/7', 'https://user@github.com/acme/widget/pull/7',
    'https://github.com:444/acme/widget/pull/7', 'https://github.com/acme/widget/issues/7', 'https://github.com/acme/widget/pull/0',
    'https://github.com/acme/widget/pull/7/files', 'https://github.com/acme/widget/pull/99999999999999999999']) assert.throws(() => pullRequestUrl(url));
});

test('System One sends only body state, lowercase Choice wire schema and its own bearer credential', async () => {
  const config = Config.parse({ ...configInput, system_one: { base_url: 'https://provider.example/v1', api_key: 'provider-secret' } }).system_one!;
  let calls = 0;
  const provider = new SystemOne(config, async (url, init) => {
    calls++;
    assert.equal(url, 'https://provider.example/v1/systemone');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer provider-secret');
    const body = JSON.parse(String(init.body));
    assert.equal(body.state, 'Bot message');
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
    assert.equal(body.questions.notification.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.notification.criteria), ['notify', 'suppress']);
    return json({ answers: { notification: { type: 'choice', choice: 'suppress', probabilities: { notify: 0.49, suppress: 0.51 }, confidence: 0.01 } } });
  });
  assert.deepEqual(await provider.classify('Bot message', signal()), { type: 'Choice', choice: 'suppress', probabilities: { notify: 0.49, suppress: 0.51 }, confidence: 0.01 });
  assert.equal(calls, 1);
  for (const answer of [null, { type: 'Choice' }, { type: 'choice', choice: 'suppress', confidence: 1, probabilities: { notify: -1, suppress: 2 } }]) {
    const malformed = new SystemOne(config, async () => json({ answers: { notification: answer } }));
    assert.equal(await malformed.classify('message', signal()), null);
  }
});

test('real synthetic HTTP provider redirects are not followed or retried', async t => {
  const paths: string[] = [];
  const server = createServer((request, response) => { paths.push(request.url!); response.writeHead(302, { Location: '/credential-leak' }); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = new SystemOne({ base_url: `http://127.0.0.1:${address.port}/v1/systemone`, api_key: 'synthetic', model: 'jev-latest' });
  await assert.rejects(provider.classify('body', signal()), /System One request failed/);
  assert.deepEqual(paths, ['/v1/systemone']);
});

test('provider timeout covers headers and body and never retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let transportSignal: AbortSignal | null | undefined;
  const provider = new SystemOne({ base_url: 'https://example.com/v1/systemone', api_key: 'secret', model: 'jev-latest' }, async (_url, init) => {
    calls++; transportSignal = init.signal;
    return new Response(new ReadableStream({ start() {} }));
  });
  const pending = provider.classify('body', signal());
  const rejected = assert.rejects(pending, /System One request failed/);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(calls, 1); assert.equal(transportSignal?.aborted, true);
});

test('GitHub wire collector preserves source namespaces, reviewers, teams, commits, attempts and raw payloads', async t => {
  const { store, clock, monitor } = await setup(t);
  const requests: URL[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input); requests.push(url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer github-secret');
    if (url.pathname.endsWith('/pulls/7')) return json({ ...wirePr, requested_teams: [{ slug: 'Platform' }] }, 200, { etag: 'detail' });
    if (url.pathname.endsWith('/issues/7/comments')) return json([comment]);
    if (url.pathname.endsWith('/pulls/7/comments')) return json([{ ...comment, pull_request_review_id: 55, in_reply_to_id: 44 }]);
    if (url.pathname.endsWith('/reviews')) return json([
      { id: 55, user: comment.user, state: 'APPROVED', body: '', submitted_at: T },
      { id: 56, user: comment.user, state: 'PENDING', body: '', submitted_at: null },
      { id: 57, user: null, state: 'COMMENTED', body: 'Deleted reviewer', submitted_at: T },
    ]);
    if (url.pathname.endsWith('/timeline')) return json([
      { event: 'labeled' }, { event: 'review_requested', id: 66, actor: comment.user, requested_team: { slug: 'Platform' }, created_at: T },
      { event: 'committed', sha: 'revision', message: 'Commit title', committer: { login: 'bea', date: T }, author: { login: 'different', date: '2020-01-01T00:00:00Z' } },
    ]);
    if (url.pathname.endsWith('/actions/runs')) { assert.equal(url.searchParams.get('head_sha'), 'head'); return json({ total_count: 1, workflow_runs: [
      { id: 77, workflow_id: 88, event: 'push', run_number: 3, run_attempt: 2, head_sha: 'head', name: 'Build', updated_at: T, status: 'completed', conclusion: 'failure' },
    ] }); }
    assert.equal(url.pathname, '/repos/acme/widget/actions/runs/77/attempts/2/jobs');
    return json({ total_count: 1, jobs: [{ id: 99, run_id: 77, head_sha: 'head', name: 'Test', status: 'completed', conclusion: 'failure', completed_at: T }] });
  };
  const github = new GitHub('github-secret', clock, store, fetch);
  const collector = new Collector(store, clock, github);
  await monitor.poll('101', (pr, signal) => collector.collect(pr, signal));
  assert.deepEqual(store.activities('101').map(item => `${item.event.source}:${item.event.id}`), ['ci:head:1:failure', 'inline_comment:55', 'issue_comment:55', 'review:55', 'review:57', 'timeline:66', 'timeline:revision']);
  assert.equal(store.activities('101').find(item => item.event.id === '57')!.event.actor, null);
  assert.equal(store.pr('101')!.reviews.length, 1);
  assert.deepEqual(store.pr('101')!.snapshot.requestedTeams, ['acme/platform']);
  assert.equal(store.pr('101')!.ci.head!.selected[0]!.jobs[0]!.attempt, 2);
  assert.equal(store.activities('101').find(item => item.event.kind === 'commit')!.event.actor!.login, 'bea');
  assert.ok(store.rawInputs('101').every(item => item.processed));
  assert.ok(store.rawInputs('101').some(item => JSON.stringify(item.payload) === JSON.stringify(comment)));
  assert.equal(requests.length, 7);
});

test('Link pagination checks every page and rejects cross-origin or looping continuations', async t => {
  const { store, clock } = await setup(t);
  const request = { resource: 'comments' as const, page: 1, validator: null, since: null, head: null, runId: null, attempt: null };
  const url = 'https://api.github.com/repos/acme/widget/issues/7/comments?per_page=100&page=2';
  const github = new GitHub('secret', clock, store, async () => json([comment], 200, { link: `<${url}>; rel="next"` }));
  assert.equal(Reflect.get(await github.request(snapshot, request, signal()) as object, 'next'), 2);
  for (const next of [url.replace('api.github.com', 'evil.example'), url.replace('page=2', 'page=1')]) {
    const invalid = new GitHub('secret', clock, store, async () => json([], 200, { link: `<${next}>; rel="next"` }));
    await assert.rejects(invalid.request(snapshot, request, signal()), /Invalid GitHub comments/);
  }
});

test('numeric-repository timeline pagination collects later pages using the original repository URL', async t => {
  const { store, clock, monitor } = await setup(t);
  const requests: URL[] = [];
  const github = new GitHub('synthetic', clock, store, async input => {
    const url = new URL(input); requests.push(url);
    assert.ok(url.pathname.startsWith('/repos/acme/widget/'), 'Pagination never follows the supplied repository alias');
    if (url.pathname.endsWith('/pulls/7')) return json(wirePr);
    if (url.pathname.endsWith('/timeline')) {
      if (url.searchParams.get('page') === '1') return json([{ event: 'labeled' }], 200, {
        link: '<https://api.github.com/repositories/123/issues/7/timeline?per_page=100&page=2>; rel="next"',
      });
      return json([{ event: 'review_requested', id: 66, actor: comment.user, requested_reviewer: { login: 'cam' }, created_at: T }]);
    }
    if (url.pathname.endsWith('/actions/runs')) return json({ total_count: 0, workflow_runs: [] });
    return json([]);
  });
  const collector = new Collector(store, clock, github);
  await monitor.poll('101', (pr, signal) => collector.collect(pr, signal));
  assert.equal(store.pr('101')!.baselineComplete, true);
  assert.deepEqual(requests.filter(url => url.pathname.endsWith('/timeline')).map(url => url.searchParams.get('page')), ['1', '2']);
  assert.ok(store.activities('101').some(item => item.event.id === '66'));
  assert.equal(store.failedInputCount('101'), 0);
});

test('numeric-repository pagination preserves resource, query, origin and forward-page validation', async t => {
  const { store, clock } = await setup(t);
  const request = { resource: 'timeline' as const, page: 1, validator: null, since: T, head: null, runId: null, attempt: null };
  const next = new URL('https://api.github.com/repositories/123/issues/7/timeline');
  next.search = new URLSearchParams({ page: '2', since: T, per_page: '100' }).toString();
  const github = new GitHub('synthetic', clock, store, async () => json([], 200, { link: `<${next}>; rel="next"` }));
  assert.equal(Reflect.get(await github.request(snapshot, request, signal()) as object, 'next'), 2);
  const invalid = [
    next.href.replace('api.github.com', 'evil.example'),
    next.href.replace('https:', 'http:'),
    next.href.replace('/issues/7/', '/issues/8/'),
    next.href.replace('/timeline?', '/comments?'),
    next.href.replace('/repositories/123/', '/repos/other/repository/'),
    next.href.replace('/repositories/123/', '/repositories/not-a-number/'),
    next.href.replace('/repositories/123/', '/repositories/0/'),
    next.href.replace('per_page=100', 'per_page=1'),
    next.href.replace('page=2&', 'page=1&'),
    next.href.replace('page=2&', 'page=2.5&'),
    next.href.replace('page=2&', 'page=9007199254740992&'),
    next.href.replace('since=', 'unexpected='),
    next.href.replace('api.github.com', 'user:password@api.github.com'),
    next.href + '#fragment',
  ];
  for (const link of invalid) {
    const github = new GitHub('synthetic', clock, store, async () => json([], 200, { link: `<${link}>; rel="next"` }));
    await assert.rejects(github.request(snapshot, request, signal()), /Invalid GitHub timeline/, link);
  }
});

test('rate deadlines defer later requests without spinning; size failures never become complete empty responses', async t => {
  const { store, clock } = await setup(t);
  let calls = 0;
  const github = new GitHub('secret', clock, store, async () => { calls++; return calls === 1 ? json({}, 429, { 'retry-after': '60' }) : json({ login: 'alex' }); });
  await assert.rejects(github.identity(signal()), /HTTP 429/);
  await assert.rejects(github.identity(signal()), /deferred/);
  assert.equal(calls, 1);
  clock.set('2026-10-22T12:01:00Z'); assert.equal(await github.identity(signal()), 'alex');
  await assert.rejects(requestJson(async () => new Response('x', { headers: { 'content-length': String(16 * 1024 * 1024 + 1) } }), 'https://example.com', {}, signal(), 30_000), /size limit/);
  await assert.rejects(requestJson(async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)), 'https://example.com', {}, signal(), 30_000), /size limit/);
});

test('discovery fetches at most four PR details concurrently and deduplicates within and across searches', async t => {
  const { store, clock } = await setup(t);
  const item = (number: number) => ({ id: number, number, repository_url: 'https://api.github.com/repos/acme/widget',
    pull_request: { url: `https://api.github.com/repos/acme/widget/pulls/${number}` } });
  const items = [1, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(item);
  const github = new GitHub('synthetic', clock, store, async () => json({ total_count: items.length, incomplete_results: false, items }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let ready!: () => void;
  const firstBatch = new Promise<void>(resolve => { ready = resolve; });
  const visited: number[] = [];
  let active = 0, peak = 0;
  const discovering = github.discover('alex', async (_repository, number) => {
    visited.push(number); active++; peak = Math.max(peak, active);
    if (visited.length === 3) ready();
    await gate;
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
  }, signal());
  await firstBatch;
  assert.deepEqual(visited, [1, 2, 3], 'Duplicate coordinates do not start a second visit');
  release(); await discovering;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('failed discovery drains in-flight details before rejecting and does not start another batch', async t => {
  const { store, clock } = await setup(t);
  const items = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, number: index + 1,
    repository_url: 'https://api.github.com/repos/acme/widget', pull_request: { url: `https://api.github.com/repos/acme/widget/pulls/${index + 1}` } }));
  const github = new GitHub('synthetic', clock, store, async () => json({ total_count: items.length, incomplete_results: false, items }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let ready!: () => void;
  const firstBatch = new Promise<void>(resolve => { ready = resolve; });
  let started = 0, finished = 0, settled = false;
  const failure = new Error('Synthetic detail failure');
  const discovering = github.discover('alex', async (_repository, number) => {
    started++;
    if (number === 1) throw failure;
    if (started === 4) ready();
    await gate;
    finished++;
  }, signal());
  const rejected = assert.rejects(discovering, error => error === failure).then(() => { settled = true; });
  await firstBatch;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Store must remain open until the other visits finish');
  release(); await rejected;
  assert.equal(started, 4);
  assert.equal(finished, 3);
});

test('startup resolves GitHub identity, team failure warns, discovery deduplicates and preserves manual untrack', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(T);
  const config = Config.parse(configInput);
  const calls: string[] = [];
  const fetch: Fetch = async input => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname === '/user') return json({ login: 'ALEX' });
    if (url.pathname === '/user/teams') return json({}, 500);
    if (url.pathname === '/search/issues') return json({ total_count: 1, incomplete_results: false, items: [
      { id: 999, number: 7, repository_url: 'https://api.github.com/repos/acme/widget', pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/7' } },
    ] });
    assert.equal(url.pathname, '/repos/acme/widget/pulls/7'); return json(wirePr);
  };
  const runtime = await startRuntime(config, directory, clock, new RecordingDesktop(), signal(), fetch);
  assert.equal(runtime.login, 'alex'); assert.deepEqual(runtime.teams, []);
  assert.equal(calls.filter(path => path === '/repos/acme/widget/pulls/7').length, 1);
  assert.equal(runtime.profile.store.prs()[0]!.snapshot.id, '101');
  assert.equal(runtime.profile.store.metadata('discoveryComplete'), T);
  runtime.monitor.untrack('101');
  await runtime.stop(); await runtime.stop();
  const restarted = await startRuntime(config, directory, clock, new RecordingDesktop(), signal(), fetch);
  assert.equal(restarted.profile.store.pr('101')!.manualUntracked, true);
  assert.equal(restarted.logs.read('warn').length, 2);
  await restarted.stop();
  assert.equal(calls.filter(path => path === '/user').length, 2);
});

test('capped startup discovery fails after preserving successful PR details and releases ownership', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(startRuntime(Config.parse(configInput), directory, new VirtualClock(T), new RecordingDesktop(), signal(), async input => {
    const url = new URL(input);
    if (url.pathname === '/user') return json({ login: 'alex' });
    if (url.pathname === '/user/teams') return json([]);
    if (url.pathname === '/search/issues') return json({ total_count: 1001, incomplete_results: false, items: [
      { id: 999, number: 7, repository_url: 'https://api.github.com/repos/acme/widget', pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/7' } },
    ] });
    return json(wirePr);
  }), /startup failed/);
  const profile = new Profile(directory);
  assert.equal(profile.store.prs().length, 1); assert.equal(profile.store.metadata('discoveryComplete'), undefined);
  profile.close();
});

test('identity binding is case insensitive, restart-stable, and rejects an account switch', async t => {
  const { store } = await setup(t);
  assert.equal(store.bindIdentity('Alex', T), T);
  assert.equal(store.bindIdentity('aLEX', '2027-01-01T00:00:00Z'), T);
  assert.throws(() => store.bindIdentity('different', T), /fresh profile/);
  assert.equal(store.metadata('login'), 'alex');
});

test('diagnostics redact credentials and nested context, apply exact filters, ignore corruption, and prune daily files', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(T); const output: string[] = [];
  const logs = new Diagnostics(directory, clock, 'info', 2 * 86_400_000, ['github-secret', 'provider-secret'], line => output.push(line));
  logs.write('debug', 'omitted'); logs.write('info', 'github-secret', { error: new Error('provider-secret'), nested: ['github-secret'], 'provider-secret': true });
  logs.write('warn', 'warning'); logs.write('error', 'error');
  await appendFile(join(directory, '2026-10-22.jsonl'), '\ninvalid-json\n{"level":"warn"}\n');
  assert.deepEqual(logs.read().map(item => item.level), ['error', 'warn', 'info']);
  assert.deepEqual(logs.read('warn').map(item => item.message), ['warning']);
  assert.ok(output.every(line => !/github-secret|provider-secret/.test(line)));
  assert.doesNotMatch(await readFile(join(directory, '2026-10-22.jsonl'), 'utf8'), /github-secret|provider-secret/);
  for (let i = 0; i < 210; i++) logs.write('info', String(i));
  assert.equal(logs.read().length, 200); assert.equal(logs.read()[0]!.message, '209');
  await writeFile(join(directory, '2026-10-19.jsonl'), '{}\n');
  clock.set('2026-10-23T00:00:00Z'); logs.write('info', 'new day');
  assert.ok(!(await readdir(directory)).includes('2026-10-19.jsonl'));
  assert.equal((await stat(join(directory, '2026-10-23.jsonl'))).mode & 0o777, 0o600);
});

test('raw retention keeps unfinished and boundary payloads; schema version and identity survive reclaim', async t => {
  const { store, directory } = await setup(t);
  const old = store.rawInput('101', 'comments', { body: 'processed' }, '2026-09-22T11:59:59.999Z');
  const boundary = store.rawInput('101', 'comments', { body: 'boundary' }, '2026-09-22T12:00:00Z');
  const unfinished = store.rawInput('101', 'comments', { body: 'unfinished' }, '2020-01-01T00:00:00Z');
  store.completeRaw('101', [old, boundary]); store.bindIdentity('Alex', T);
  store.prune(T, 30 * 86_400_000); store.prune(T, 30 * 86_400_000); store.reclaim();
  assert.deepEqual(store.rawInputs('101').map(item => item.id), [boundary, unfinished]);
  assert.equal(store.metadata('login'), 'alex');
  const db = new Database(join(directory, 'state.sqlite'));
  assert.equal(db.pragma('user_version', { simple: true }), 1); db.close();
});

test('fresh-schema upgrades preserve existing records and reject newer unknown schemas without downgrading', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path); const monitor = new Monitor(store, new VirtualClock(T), 'alex', [], T);
  monitor.track(snapshot, 'manual'); monitor.untrack('101'); store.close();
  let db = new Database(path); db.exec('DROP TABLE metadata; DROP TABLE raw_inputs; PRAGMA user_version = 0'); db.close();
  store = new Store(path); assert.equal(store.pr('101')!.manualUntracked, true); store.bindIdentity('alex', T); store.close();
  db = new Database(path); db.pragma('user_version = 99'); db.close();
  assert.throws(() => new Store(path), /newer/);
  db = new Database(path); assert.equal(db.pragma('user_version', { simple: true }), 99); db.close();
});

test('desktop contract keeps sticky lifetime, inert markup, saved text and capability fallbacks', async t => {
  const { store, monitor } = await setup(t);
  await monitor.observe({ snapshot: { ...snapshot, title: '<script>unsafe</script>' }, sources: completeSources, events: [
    { source: 'issue_comment', id: 'live', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: '<b>fix & test</b>' },
  ] });
  const intent = store.notification(1).intent;
  const messages: DesktopMessage[] = [];
  for (const capabilities of [[], ['body-markup'], ['body-markup', 'body-images', 'actions', 'sound']]) {
    const desktop = new DesktopAdapter(store, 'alex', {
      async capabilities() { return capabilities; },
      async notify(message, destination) { messages.push(message); assert.equal(destination, intent.destination); return 42; },
    });
    assert.equal(await desktop.submit(intent, signal()), 'sent');
  }
  assert.equal(messages[0]!.body, intent.body);
  assert.ok(messages.every(message => message.expireTimeout === 0));
  assert.doesNotMatch(messages[1]!.body, /<script>/);
  assert.match(messages[1]!.body, /&lt;script&gt;/);
  assert.deepEqual(messages[2]!.actions, ['default', 'Open pull request']);
  assert.equal(messages[2]!.hints['sound-name'], 'octopulse-comment');
  assert.equal(store.notification(1).intent.body, intent.body);
});

test('fatal identity failure and successful empty discovery stay distinguishable', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(startRuntime(Config.parse(configInput), directory, new VirtualClock(T), new RecordingDesktop(), signal(), async () => json({}, 401)), /startup failed/);
  const runtime = await startRuntime(Config.parse(configInput), directory, new VirtualClock(T), new RecordingDesktop(), signal(), async url => {
    if (url.endsWith('/user')) return json({ login: 'alex' });
    if (url.includes('/user/teams')) return json([]);
    return emptySearch();
  });
  assert.equal(runtime.profile.store.metadata('discoveryComplete'), T);
  await runtime.stop();
});

test('log write failure reports to output without throwing or leaking context', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, '2026-10-22.jsonl'));
  const output: string[] = [];
  const logs = new Diagnostics(directory, new VirtualClock(T), 'debug', 1, ['secret'], line => output.push(line));
  assert.doesNotThrow(() => logs.write('error', 'secret'));
  assert.ok(output.includes('Octopulse diagnostic write failed'));
  assert.ok(output.every(line => !line.includes('secret')));
});

test('missing legacy review targets refresh per PR and survive a partially failed upgrade', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const store = new Store(path);
  const monitor = new Monitor(store, new VirtualClock(T), 'alex', [], T);
  monitor.track(snapshot, 'manual'); monitor.track({ ...snapshot, id: '102', number: 8 }, 'manual'); monitor.untrack('101');
  store.close();
  const db = new Database(path);
  db.exec("UPDATE pull_requests SET data = json_remove(data, '$.snapshot.requestedReviewers', '$.snapshot.requestedTeams'); PRAGMA user_version = 0"); db.close();
  let fail = true;
  const calls: number[] = [];
  const fetch: Fetch = async url => {
    if (url.endsWith('/user')) return json({ login: 'alex' });
    if (url.includes('/user/teams')) return json([]);
    if (url.includes('/search/issues')) return emptySearch();
    const number = Number(url.split('/').at(-1)); calls.push(number);
    if (number === 8 && fail) return json({}, 503);
    return json({ ...wirePr, id: number === 7 ? 101 : 102, number, requested_reviewers: [{ login: 'bea' }] });
  };
  await assert.rejects(startRuntime(Config.parse(configInput), directory, new VirtualClock(T), new RecordingDesktop(), signal(), fetch), /upgrade refresh/);
  const partial = new Profile(directory);
  assert.equal(partial.store.pr('101')!.manualUntracked, true);
  assert.deepEqual(partial.store.pr('101')!.snapshot.requestedReviewers, ['bea']);
  assert.deepEqual(JSON.parse(partial.store.metadata('reviewRefreshPending')!), ['102']); partial.close();
  fail = false;
  const runtime = await startRuntime(Config.parse(configInput), directory, new VirtualClock(T), new RecordingDesktop(), signal(), fetch);
  assert.deepEqual(calls, [7, 8, 8]);
  assert.equal(runtime.profile.store.metadata('reviewRefreshPending'), '[]');
  assert.equal(runtime.profile.store.metadata('reviewBaseline'), T);
  assert.equal(runtime.profile.store.notifications().length, 0);
  await runtime.stop();
});

test('upgrade failure rolls back schema changes and version before successful restart', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const db = new Database(path);
  db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TRIGGER fail_upgrade BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT, 'upgrade failure'); END");
  assert.throws(() => new Store(path), /upgrade failure/);
  assert.equal(db.pragma('user_version', { simple: true }), 0);
  assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'raw_inputs'").pluck().get(), 0);
  db.exec('DROP TRIGGER fail_upgrade'); db.close();
  const recovered = new Store(path); assert.equal(recovered.metadata('reviewRefreshPending'), '[]'); recovered.close();
});

test('wire failures retain actual malformed input, preserve raw work and do not advance validators', async t => {
  const { store, monitor, clock } = await setup(t);
  const corrupt = '{ malformed raw upstream content';
  const github = new GitHub('secret', clock, store, async url => url.endsWith('/pulls/7') ? json(wirePr, 200, { etag: 'new' }) : new Response(corrupt));
  const collector = new Collector(store, clock, github);
  await assert.rejects(monitor.poll('101', (pr, signal) => collector.collect(pr, signal)), /Invalid GitHub comments/);
  assert.ok(store.failedInputs('101').some(item => item.payload === corrupt));
  assert.deepEqual(store.pr('101')!.fetchState.pages, {});
  assert.ok(store.rawInputs('101').every(item => !item.processed));
  store.prune('2030-01-01T00:00:00Z', 1);
  assert.ok(store.failedInputs('101').some(item => item.payload === corrupt));
  assert.equal(store.rawInputs('101').length, 1);
});

test('wire collections detect incomplete totals and exact-size arrays continue to an empty page', async t => {
  const { store, monitor, clock } = await setup(t);
  const pages: number[] = [];
  let complete = false;
  const github = new GitHub('secret', clock, store, async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/pulls/7')) return json(wirePr);
    if (url.pathname.endsWith('/issues/7/comments')) {
      const page = Number(url.searchParams.get('page')); pages.push(page);
      return json(page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 })) : []);
    }
    if (url.pathname.endsWith('/actions/runs')) return json({ total_count: complete ? 0 : 1, workflow_runs: [] });
    return json([]);
  });
  const collector = new Collector(store, clock, github);
  await assert.rejects(monitor.poll('101', (pr, signal) => collector.collect(pr, signal)), /Incomplete paginated/);
  assert.equal(store.activities('101').length, 0);
  assert.deepEqual(pages, [1, 2]);
  complete = true;
  await monitor.poll('101', (pr, signal) => collector.collect(pr, signal));
  assert.equal(store.activities('101').length, 100);
  assert.equal(store.notifications().length, 1);
});

test('repository transfer refresh preserves stable identity and manual preference despite changed coordinates', async t => {
  const { monitor, store } = await setup(t);
  monitor.untrack('101');
  await monitor.lookup('101', 'discovery', async () => ({ ...snapshot, repository: 'new-owner/renamed', number: 42 }));
  assert.equal(store.prs().length, 1);
  assert.equal(store.pr('101')!.snapshot.number, 42);
  assert.equal(store.pr('101')!.snapshot.repository, 'new-owner/renamed');
  assert.equal(store.pr('101')!.manualUntracked, true);
});

test('runtime shutdown aborts a manual lookup before closing its profile', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const runtime = await startRuntime(Config.parse(configInput), directory, new VirtualClock(T), new RecordingDesktop(), signal(), async url => {
    if (url.endsWith('/user')) return json({ login: 'alex' });
    if (url.includes('/user/teams')) return json([]);
    if (url.includes('/search/issues')) return emptySearch();
    began(); return new Promise(() => {});
  });
  const tracking = assert.rejects(runtime.track('https://github.com/acme/widget/pull/7', signal()));
  await started; await runtime.stop(); await tracking;
  const reopened = new Profile(directory); assert.equal(reopened.store.prs().length, 0); reopened.close();
});

test('offline maintenance refuses a live profile, then reclaims privately without network credentials', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory);
  const settings = new Settings(profile.store, undefined, {});
  settings.update({ github: {}, history: { raw_payload_retention: '1 day' } });
  const now = new Date().toISOString();
  const monitor = new Monitor(profile.store, { now: () => now }, 'alex', [], now);
  monitor.track(snapshot, 'manual');
  profile.store.bindIdentity('alex', now);
  const old = profile.store.rawInput('101', 'comments', { body: 'old' }, new Date(Date.now() - 2 * 86_400_000).toISOString());
  const recent = profile.store.rawInput('101', 'comments', { body: 'recent' }, new Date(Date.now() - 3_600_000).toISOString());
  const unfinished = profile.store.rawInput('101', 'comments', { body: 'unfinished' }, new Date(Date.now() - 3 * 86_400_000).toISOString());
  profile.store.completeRaw('101', [old, recent]);
  const saved = profile.store.metadata('settings');
  const command = fileURLToPath(new URL('../src/maintenance.js', import.meta.url));
  const args = [command, '--profile', directory];
  const refused = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.doesNotMatch(refused.stderr, /github-secret/);
  profile.close();
  const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.equal((await stat(join(directory, 'state.sqlite'))).mode & 0o777, 0o600);
  const reopened = new Profile(directory);
  try {
    assert.deepEqual(reopened.store.rawInputs('101').map(item => item.id), [recent, unfinished]);
    assert.equal(reopened.store.metadata('settings'), saved);
    assert.equal(reopened.store.metadata('login'), 'alex');
  } finally { reopened.close(); }
});

test('avatar bounds reject active content, use a private cache, and retain it on a failed refresh', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(new Date().toISOString());
  let calls = 0;
  const cache = new AvatarCache(directory, clock, async (_url, init) => {
    calls++; assert.equal(init.headers, undefined); assert.equal(init.redirect, 'manual');
    return calls === 1 ? new Response(avatarPng) : json({}, 503);
  });
  const image = await cache.image('https://avatars.example/alex.png', signal()); assert.ok(image);
  assert.equal(await cache.image('https://avatars.example/alex.png', signal()), image); assert.equal(calls, 1);
  await utimes(fileURLToPath(image), new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(await cache.image('https://avatars.example/alex.png', signal()), image); assert.equal(calls, 2);
  assert.equal((await stat(fileURLToPath(image))).mode & 0o777, 0o600);
  const malicious = new AvatarCache(directory, clock, async () => new Response('<svg onload="evil()"/>'));
  assert.equal(await malicious.image('https://avatars.example/malicious.svg', signal()), null);
  assert.equal(await malicious.image('http://avatars.example/insecure.png', signal()), null);
  const oversized = new AvatarCache(directory, clock, async () => new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }));
  assert.equal(await oversized.image('https://avatars.example/huge.png', signal()), null);
});

test('GitHub follows bounded same-origin repository redirects but never sends credentials elsewhere', async t => {
  const { store, clock } = await setup(t);
  const calls: string[] = [];
  const github = new GitHub('secret', clock, store, async url => {
    calls.push(url);
    if (calls.length === 1) return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/123/pulls/7' } });
    return json({ ...wirePr, base: { ref: 'main', repo: { full_name: 'new-owner/renamed' } } });
  });
  assert.equal((await github.detail('acme/widget', 7, signal())).repository, 'new-owner/renamed');
  assert.equal(calls.length, 2);
  let unsafeCalls = 0;
  const unsafe = new GitHub('secret', clock, store, async () => {
    unsafeCalls++; return new Response(null, { status: 301, headers: { location: 'https://evil.example/steal' } });
  });
  await assert.rejects(unsafe.detail('acme/widget', 7, signal()));
  assert.equal(unsafeCalls, 1);
  let loops = 0;
  const looping = new GitHub('secret', clock, store, async url => { loops++; return new Response(null, { status: 301, headers: { location: url } }); });
  await assert.rejects(looping.detail('acme/widget', 7, signal()));
  assert.equal(loops, 4);
});

test('recurring desktop failure is logged and delivery recovers independently of GitHub failures', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new VirtualClock(T); let offline = false;
  const desktop = new RecordingDesktop(); desktop.results = ['transient', 'sent'];
  const runtime = await startRuntime(Config.parse(configInput), directory, clock, desktop, signal(), async url => {
    if (offline) return json({}, 503);
    if (url.endsWith('/user')) return json({ login: 'alex' });
    if (url.includes('/user/teams')) return json([]);
    return emptySearch();
  });
  runtime.monitor.track(snapshot, 'manual');
  await runtime.monitor.observe({ snapshot, events: [], sources: completeSources });
  await runtime.monitor.observe({ snapshot, sources: completeSources, events: [
    { source: 'issue_comment', id: 'c', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: 'Fix it' },
  ] });
  runtime.tick(); await runtime.scheduler.idle();
  assert.equal(runtime.profile.store.notification(1).status, 'failed');
  assert.ok(runtime.logs.read('error').some(entry => entry.message === 'Desktop submission failed'));
  offline = true; clock.set('2026-10-22T12:01:00Z'); runtime.tick(); await runtime.scheduler.idle();
  assert.equal(runtime.profile.store.notification(1).status, 'sent');
  assert.ok(runtime.logs.read('error').some(entry => entry.message === 'Background operation failed'));
  await runtime.stop();
});

test('missing CI ordering cannot finish bootstrap; repaired metadata completes a silent baseline', async t => {
  const { store, monitor, clock } = await setup(t);
  monitor.untrack('101'); monitor.track(snapshot, 'manual');
  let repaired = false;
  const github = new GitHub('secret', clock, store, async url => {
    if (url.endsWith('/pulls/7')) return json(wirePr);
    if (url.includes('/actions/runs?')) return json({ total_count: 1, workflow_runs: [{
      id: 77, workflow_id: 88, event: 'push', ...(repaired ? { run_number: 3 } : {}), run_attempt: 1,
      head_sha: 'head', name: 'Build', updated_at: T, status: 'completed', conclusion: 'failure',
    }] });
    if (url.includes('/jobs?')) return json({ total_count: 0, jobs: [] });
    return json([]);
  });
  const collector = new Collector(store, clock, github);
  await monitor.poll('101', (pr, signal) => collector.collect(pr, signal));
  assert.equal(store.pr('101')!.baselineComplete, false);
  assert.equal(store.pr('101')!.ci.head!.uncertain, true);
  assert.ok(store.rawInputs('101').every(input => !input.processed));
  repaired = true;
  await monitor.poll('101', (pr, signal) => collector.collect(pr, signal));
  assert.equal(store.pr('101')!.baselineComplete, true);
  assert.equal(store.pr('101')!.ci.head!.outcome, 'failure');
  assert.equal(store.notifications().length, 0);
  assert.equal(store.activities('101')[0]!.decision, 'baseline');
});

test('freedesktop protocol maps Notify arguments and variants, opens only default actions, and never auto-closes sticky alerts', async t => {
  const { store, monitor } = await setup(t);
  await monitor.observe({ snapshot, sources: completeSources, events: [
    { source: 'issue_comment', id: 'c', kind: 'comment', occurredAt: T, actor: { login: 'bea' }, body: 'Fix' },
  ] });
  const calls: { member: string; signature: string; body: unknown[] }[] = [];
  const opened: string[] = [];
  const transport = new FreedesktopTransport({ async call(request) {
    calls.push(request);
    assert.equal(request.destination, 'org.freedesktop.Notifications');
    assert.equal(request.path, '/org/freedesktop/Notifications');
    assert.equal(request.interface, 'org.freedesktop.Notifications');
    return request.member === 'GetCapabilities' ? [['body-markup', 'actions', 'sound']] : [42];
  } }, async url => { opened.push(url); });
  const desktop = new DesktopAdapter(store, 'alex', transport);
  assert.equal(await desktop.submit(store.notification(1).intent, signal()), 'sent');
  const notify = calls[1]!;
  assert.equal(notify.signature, 'susssasa{sv}i');
  assert.deepEqual(notify.body.slice(0, 4), ['Octopulse', 0, 'git-open', '']);
  assert.deepEqual(notify.body[6], { 'desktop-entry': { signature: 's', value: 'octopulse' }, 'sound-name': { signature: 's', value: 'octopulse-comment' } });
  assert.equal(notify.body[7], 0);
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.timers.tick(86_400_000);
  assert.deepEqual(calls.map(call => call.member), ['GetCapabilities', 'Notify']);
  await transport.actionInvoked(42, 'unknown'); assert.deepEqual(opened, []);
  await transport.actionInvoked(42, 'default'); assert.deepEqual(opened, ['https://github.com/acme/widget/pull/7']);
  transport.notificationClosed(42); await transport.actionInvoked(42, 'default'); assert.equal(opened.length, 1);
});
