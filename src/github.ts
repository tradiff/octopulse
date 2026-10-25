import { z } from 'zod';
import { Actor, Event, Instant, Login, Review, Snapshot } from './model.js';
import type { Clock } from './model.js';
import type { PageClient, PageRequest } from './collector.js';
import { requestJson } from './http.js';
import type { Fetch } from './http.js';
import { Store } from './store.js';

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
const User = z.object({ login: Login, type: z.string().optional(), avatar_url: z.url().nullable().optional() });
const Team = z.object({ slug: Login, organization: z.object({ login: Login }).nullish() });
const Detail = z.object({
  id: Id, number: z.number().int().positive(), title: z.string(), user: User,
  state: z.enum(['open', 'closed']), draft: z.boolean(), merged_at: Instant.nullable(), closed_at: Instant.nullable(), updated_at: Instant,
  head: z.object({ sha: z.string().min(1) }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  requested_reviewers: z.array(User), requested_teams: z.array(Team), mergeable_state: z.string().nullable().optional(),
});
function actor(value: unknown): z.infer<typeof Actor> | null {
  if (value === null || value === undefined) return null;
  const user = User.parse(value);
  return Actor.parse({ login: user.login, bot: user.type === 'Bot', ...(user.avatar_url ? { avatar: user.avatar_url } : {}) });
}
const teamKey = (value: unknown, repository: string): string => {
  const team = Team.parse(value);
  return `${team.organization?.login ?? repository.split('/')[0]}/${team.slug}`.toLowerCase();
};

export function githubSnapshot(input: unknown, number: number): Snapshot {
  const pr = Detail.parse(input);
  if (pr.number !== number) throw new Error('Mismatched GitHub pull request number');
  return Snapshot.parse({
    id: pr.id, repository: pr.base.repo.full_name, number: pr.number, title: pr.title, author: pr.user.login,
    state: pr.merged_at ? 'merged' : pr.state, draft: pr.draft,
    head: pr.head.sha, base: pr.base.ref, authorAvatar: pr.user.avatar_url ?? null, mergeStatus: pr.mergeable_state ?? null,
    updatedAt: pr.updated_at, closedAt: pr.closed_at, mergedAt: pr.merged_at,
    requestedReviewers: pr.requested_reviewers.map(user => user.login), requestedTeams: pr.requested_teams.map(team => teamKey(team, pr.base.repo.full_name)),
    requestedActors: pr.requested_reviewers.map(user => actor(user)),
  });
}

function normalize(resource: PageRequest['resource'], input: unknown, pr: Snapshot, request: PageRequest): unknown[] {
  if (resource === 'detail') return [githubSnapshot(input, pr.number)];
  if (resource === 'workflows') {
    const run = z.object({ id: Id, workflow_id: Id.nullish(), event: z.string().min(1).nullish(), run_number: z.number().int().positive().nullish(),
      run_attempt: z.number().int().positive().nullish(), head_sha: z.string().min(1), name: z.string(), updated_at: Instant,
      status: z.string().min(1), conclusion: z.string().nullable() }).parse(input);
    return [{ id: run.id, workflowId: run.workflow_id ?? null, trigger: run.event ?? null, runNumber: run.run_number ?? null,
      attempt: run.run_attempt ?? null, head: run.head_sha, name: run.name, updatedAt: run.updated_at, status: run.status, conclusion: run.conclusion }];
  }
  if (resource === 'jobs') {
    const job = z.object({ id: Id, run_id: Id, head_sha: z.string().min(1), run_attempt: z.number().int().positive().optional(),
      name: z.string(), status: z.string().min(1), conclusion: z.string().nullable() }).parse(input);
    return [{ id: job.id, runId: job.run_id, head: job.head_sha, attempt: job.run_attempt ?? request.attempt,
      name: job.name, status: job.status, conclusion: job.conclusion }];
  }
  if (resource === 'comments' || resource === 'inlineComments') {
    const comment = z.object({ id: Id, user: User.nullable(), body: z.string().nullable(), created_at: Instant, updated_at: Instant.optional(),
      pull_request_review_id: Id.optional(), in_reply_to_id: Id.optional() }).parse(input);
    return [Event.parse({ source: resource === 'comments' ? 'issue_comment' : 'inline_comment', id: comment.id,
      kind: resource === 'comments' ? 'comment' : 'inline_comment', body: comment.body ?? '', actor: actor(comment.user), occurredAt: comment.created_at,
      ...(comment.updated_at ? { updatedAt: comment.updated_at } : {}),
      ...(resource === 'inlineComments' ? { reviewId: comment.pull_request_review_id, threadRoot: comment.in_reply_to_id ?? comment.id } : {}),
    })];
  }
  if (resource === 'reviews') {
    const review = z.object({ id: Id, user: User.nullable(), state: z.string(), submitted_at: Instant.nullish(), body: z.string().nullable() }).parse(input);
    const state = Review.shape.state.parse(review.state.toLowerCase());
    if (state === 'pending' || !review.submitted_at) return [];
    return [{ review: review.user ? Review.parse({ id: review.id, reviewer: actor(review.user), state, submittedAt: review.submitted_at }) : null,
      event: Event.parse({ source: 'review', id: review.id, kind: state === 'approved' ? 'approval' : state === 'changes_requested' ? 'changes_requested' : 'review',
        occurredAt: review.submitted_at, actor: actor(review.user), body: review.body ?? '' }),
    }];
  }
  const value = z.object({ event: z.string() }).passthrough().parse(input);
  const kinds: Record<string, Event['kind']> = {
    closed: 'close', merged: 'merge', reopened: 'reopen', ready_for_review: 'ready_for_review',
    convert_to_draft: 'converted_to_draft', review_requested: 'review_requested', committed: 'commit',
  };
  const kind = kinds[value.event];
  if (!kind) return [];
  let occurredAt: unknown = value.created_at;
  let author: unknown = value.actor;
  let id: unknown = value.id;
  let body = '';
  if (kind === 'commit') {
    const commit = z.object({ sha: z.string().min(1), message: z.string().optional(),
      committer: z.object({ date: Instant.optional() }).passthrough().nullish(),
      author: z.object({ date: Instant.optional() }).passthrough().nullish(),
    }).parse(input);
    id = commit.sha;
    occurredAt ??= commit.committer?.date ?? commit.author?.date;
    author = User.safeParse(value.committer).success ? value.committer : User.safeParse(value.author).success ? value.author : null;
    body = commit.message ?? '';
  } else id = Id.parse(id);
  return [Event.parse({ source: 'timeline', id, kind, actor: actor(author), occurredAt, body,
    ...(kind === 'review_requested' ? {
      ...(value.requested_reviewer ? { targetUser: User.parse(value.requested_reviewer).login } : {}),
      ...(value.requested_team ? { targetTeam: teamKey(value.requested_team, pr.repository) } : {}),
    } : {}),
  })];
}

export class GitHubUnavailable extends Error {}

export class GitHub implements PageClient {
  private retryAt = 0;
  constructor(private readonly token: string, private readonly clock: Clock, private readonly store: Store, private readonly fetch: Fetch = globalThis.fetch) {}

  private async get(url: URL, signal: AbortSignal, validator: string | null = null) {
    if (Date.parse(this.clock.now()) < this.retryAt) throw new GitHubUnavailable(`GitHub deferred until ${new Date(this.retryAt).toISOString()}`);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30_000);
    const requestSignal = AbortSignal.any([signal, timeout.signal]);
    try {
      for (let redirects = 0; ; redirects++) {
        let response: Awaited<ReturnType<typeof requestJson>>;
        try {
          response = await requestJson(this.fetch, url.href, { method: 'GET', headers: {
            Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Octopulse', ...(validator ? { 'If-None-Match': validator } : {}),
          } }, requestSignal, 30_000);
        } catch (error) {
          if (error instanceof TypeError || requestSignal.aborted) throw new GitHubUnavailable('GitHub transport unavailable');
          throw error;
        }
        if ([301, 302, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || redirects >= 3) throw new Error('Invalid GitHub redirect');
          const target = new URL(location, url);
          if (target.origin !== 'https://api.github.com' || target.username || target.password || target.hash) throw new Error('Invalid GitHub redirect');
          url = target;
          validator = null;
          continue;
        }
        if (response.status === 403 || response.status === 429) {
          const retry = response.headers.get('retry-after');
          const reset = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
          const deadline = retry ? (/^\d+$/.test(retry) ? Date.parse(this.clock.now()) + Number(retry) * 1000 : Date.parse(retry)) : 0;
          for (const candidate of [reset, deadline]) if (Number.isFinite(candidate) && candidate <= 8_640_000_000_000_000) this.retryAt = Math.max(this.retryAt, candidate);
        }
        if (response.status >= 500 || response.status === 408 || response.status === 429
          || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
          throw new GitHubUnavailable(`GitHub HTTP ${response.status}`);
        }
        if (response.status !== 200 && response.status !== 304) throw new Error(`GitHub HTTP ${response.status}`);
        return { ...response, url };
      }
    } catch (error) {
      if (error instanceof GitHubUnavailable) throw error;
      if (error instanceof Error && /^GitHub HTTP \d+$/.test(error.message)) throw error;
      throw new Error('GitHub transport or JSON response failed');
    } finally { clearTimeout(timer); }
  }

  private next(headers: Headers, url: URL): number | null {
    const link = headers.get('link');
    if (!link) return null;
    for (const part of link.split(/,(?=\s*<)/)) {
      if (!/\brel="next"/.test(part)) continue;
      const match = /<([^>]+)>/.exec(part);
      if (!match) throw new Error('Malformed GitHub pagination');
      const next = new URL(match[1]!);
      const page = Number(next.searchParams.get('page'));
      const expected = new URL(url); expected.searchParams.delete('page');
      const actual = new URL(next); actual.searchParams.delete('page');
      // GitHub can use numeric repository aliases in Link headers; requests still use the original URL.
      const repository = /^\/repos\/[^/]+\/[^/]+(?=\/)/.exec(expected.pathname);
      if (repository) actual.pathname = actual.pathname.replace(/^\/repositories\/[1-9]\d*(?=\/)/, repository[0]);
      expected.searchParams.sort(); actual.searchParams.sort();
      if (actual.href !== expected.href || !Number.isSafeInteger(page) || page <= Number(url.searchParams.get('page') ?? 1)) throw new Error('Invalid GitHub pagination continuation');
      return page;
    }
    return null;
  }

  async request(pr: Snapshot, request: PageRequest, signal: AbortSignal): Promise<unknown> {
    const root = `/repos/${pr.repository}`;
    const paths = {
      detail: `${root}/pulls/${pr.number}`, comments: `${root}/issues/${pr.number}/comments`,
      inlineComments: `${root}/pulls/${pr.number}/comments`, reviews: `${root}/pulls/${pr.number}/reviews`,
      timeline: `${root}/issues/${pr.number}/timeline`, workflows: `${root}/actions/runs`,
      jobs: `${root}/actions/runs/${request.runId}/attempts/${request.attempt}/jobs`,
    };
    const url = new URL(paths[request.resource], 'https://api.github.com');
    if (request.resource !== 'detail') { url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(request.page)); }
    if (request.since) url.searchParams.set('since', request.since);
    if (request.resource === 'workflows') url.searchParams.set('head_sha', z.string().min(1).parse(request.head));
    const response = await this.get(url, signal, request.validator);
    if (response.status === 304) return { status: 304 };
    const rawIds: number[] = [];
    try {
      let items: unknown[];
      let total: number | undefined;
      if (request.resource === 'detail') items = [response.body];
      else if (request.resource === 'workflows') {
        const runs = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(z.unknown()) }).parse(response.body);
        items = runs.workflow_runs; total = runs.total_count;
        if (total > 1000) throw new Error('Capped workflow collection');
      } else if (request.resource === 'jobs') {
        const jobs = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(z.unknown()) }).parse(response.body);
        items = jobs.jobs; total = jobs.total_count;
      }
      else items = z.array(z.unknown()).parse(response.body);
      for (const item of items) {
        const raw = z.record(z.string(), z.unknown()).safeParse(item);
        const dates = z.object({ committer: z.object({ date: Instant.optional() }).nullish(), author: z.object({ date: Instant.optional() }).nullish() }).safeParse(item);
        const stamp = raw.success ? Instant.safeParse(request.resource === 'workflows' || request.resource === 'detail'
          ? raw.data.updated_at : raw.data.submitted_at ?? raw.data.created_at ?? raw.data.completed_at ?? raw.data.started_at
            ?? (dates.success ? dates.data.committer?.date ?? dates.data.author?.date : null)) : null;
        rawIds.push(this.store.rawInput(pr.id, request.resource, item, stamp?.success ? stamp.data : null));
      }
      const next = this.next(response.headers, response.url) ?? (request.resource !== 'detail' && total === undefined && items.length === 100 ? request.page + 1 : null);
      return { status: 200, validator: response.headers.get('etag'), next, rawIds, ...(total === undefined ? {} : { total }),
        items: items.flatMap(item => normalize(request.resource, item, pr, request)) };
    } catch {
      this.store.failedInput(pr.id, request.resource, response.body, this.clock.now());
      throw new Error(`Invalid GitHub ${request.resource} response`);
    }
  }

  async identity(signal: AbortSignal): Promise<string> {
    const response = await this.get(new URL('https://api.github.com/user'), signal);
    return User.parse(response.body).login;
  }

  async teams(signal: AbortSignal): Promise<string[]> {
    const teams: string[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const url = new URL(`https://api.github.com/user/teams?per_page=100&page=${page}`);
      const response = await this.get(url, signal);
      for (const team of z.array(Team.extend({ organization: z.object({ login: Login }) })).parse(response.body)) teams.push(teamKey(team, ''));
      page = this.next(response.headers, response.url);
    }
    return [...new Set(teams)];
  }

  async detail(repository: string, number: number, signal: AbortSignal): Promise<Snapshot> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid pull request coordinates');
    const response = await this.get(new URL(`https://api.github.com/repos/${repository}/pulls/${number}`), signal);
    return githubSnapshot(response.body, number);
  }

  async discover(login: string, visit: (repository: string, number: number) => Promise<void>, signal: AbortSignal): Promise<void> {
    const seen = new Set<string>();
    for (const qualifier of ['author', 'review-requested']) {
      let page: number | null = 1;
      let received = 0;
      let expected = 0;
      while (page !== null) {
        const url = new URL('https://api.github.com/search/issues');
        url.search = new URLSearchParams({ q: `is:pr is:open ${qualifier}:${login}`, per_page: '100', page: String(page) }).toString();
        const response = await this.get(url, signal);
        const result = z.object({ total_count: z.number().int().nonnegative(), incomplete_results: z.boolean(), items: z.array(z.object({
          id: Id, number: z.number().int().positive(), repository_url: z.string(), pull_request: z.object({ url: z.string() }),
        })) }).parse(response.body);
        expected = Math.max(expected, result.total_count);
        received += result.items.length;
        for (let offset = 0; offset < result.items.length; offset += 4) {
          signal.throwIfAborted();
          const details = await Promise.allSettled(result.items.slice(offset, offset + 4).map(async item => {
            const repository = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/.exec(item.repository_url)?.[1];
            if (!repository || item.pull_request.url !== `${item.repository_url}/pulls/${item.number}`) throw new Error('Invalid GitHub search coordinates');
            // Search issue IDs differ from pull request IDs; authoritative detail supplies PR identity.
            const key = `${repository}/${item.number}`;
            if (!seen.has(key)) { seen.add(key); await visit(repository, item.number); }
          }));
          for (const detail of details) if (detail.status === 'rejected') throw detail.reason;
        }
        if (result.incomplete_results || result.total_count > 1000) throw new Error('Incomplete or capped GitHub discovery');
        page = this.next(response.headers, response.url);
      }
      if (received < expected) throw new Error('Incomplete GitHub discovery pagination');
    }
  }
}
