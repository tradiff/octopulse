import { canonical, compareEvents, eventKey } from './model.js';
import type { Actor, PullRequest } from './model.js';
import { ciSummary } from './ci.js';
import { readable } from './presentation.js';
import { commentHtml } from './comment.js';
import { Monitor } from './monitor.js';
import { Store } from './store.js';
import { filters } from './filters.js';

function matches(pr: PullRequest, filter: ReturnType<typeof filters>): boolean {
  return (!filter.repository || pr.snapshot.repository === filter.repository)
    && (!filter.tracking.length || filter.tracking.includes(pr.tracked ? 'tracked' : 'inactive'))
    && (!filter.lifecycle.length || filter.lifecycle.includes(pr.snapshot.state));
}

function project(pr: PullRequest, store: Store, monitor: Monitor) {
  const activities = store.activities(pr.snapshot.id);
  const visible = activities.filter(item => item.visible).sort((a, b) => compareEvents(b.event, a.event));
  const responsibility = monitor.responsibility(pr);
  const people = new Map<string, Actor>();
  const bots = new Set<string>();
  for (const actor of [...activities.flatMap(item => item.event.actor ? [item.event.actor] : []), ...pr.reviews.map(item => item.reviewer), ...pr.snapshot.requestedActors]) {
    const key = canonical(actor.login);
    people.set(key, actor);
    if (actor.bot || /\[bot\]$/i.test(key)) bots.add(key);
  }
  const groups: Record<'approvers' | 'commenters' | 'decliners' | 'requested', { login: string; avatar: string | null }[]> = {
    approvers: [], commenters: [], decliners: [], requested: [],
  };
  const reviewers = new Map(Object.entries(responsibility.reviewers));
  for (const item of activities) if (item.event.actor && ['comment', 'inline_comment', 'review'].includes(item.event.kind)) {
    const login = canonical(item.event.actor.login);
    if (!reviewers.has(login)) reviewers.set(login, 'commented');
  }
  for (const [login, state] of [...reviewers].sort(([a], [b]) => a.localeCompare(b))) {
    if (bots.has(login) || /\[bot\]$/i.test(login)) continue;
    const key = state === 'requested' ? 'requested' : state === 'approved' ? 'approvers' : state === 'changes_requested' ? 'decliners' : 'commenters';
    groups[key].push({ login: people.get(login)?.login ?? login, avatar: people.get(login)?.avatar ?? null });
  }
  const mergeLabels: Record<string, string> = { clean: 'No merge conflicts', blocked: 'Blocked by rules', behind: 'Behind base branch', dirty: 'Merge conflicts',
    unstable: 'Merge checks failing or pending', has_hooks: 'Waiting on required hooks', unknown: 'Still being calculated', draft: 'Draft PR' };
  const ci = ciSummary(pr.snapshot.head ? pr.ci[pr.snapshot.head] : undefined);
  const priority = ['failing', 'pending', 'passing', 'skipped', 'terminal', 'unknown'];
  ci.workflows.sort((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state) || a.id.localeCompare(b.id));
  return {
    id: pr.snapshot.id, snapshot: pr.snapshot, tracked: pr.tracked, manualUntracked: pr.manualUntracked,
    graceUntil: pr.graceUntil, baselineComplete: pr.baselineComplete, recordedAt: pr.recordedAt,
    destination: `https://github.com/${pr.snapshot.repository}/pull/${pr.snapshot.number}`,
    state: pr.snapshot.state === 'open' && pr.snapshot.draft ? 'draft' : pr.snapshot.state,
    queue: responsibility.queue, groups, ci,
    merge: pr.snapshot.state === 'open' && pr.snapshot.mergeStatus ? mergeLabels[pr.snapshot.mergeStatus] ?? `GitHub status: ${pr.snapshot.mergeStatus}` : null,
    pendingTeams: pr.snapshot.state === 'open' ? pr.snapshot.requestedTeams : [],
    activityCount: visible.length, latestAt: visible[0]?.event.occurredAt ?? pr.recordedAt ?? pr.snapshot.updatedAt,
    timeline: visible.map(item => ({ ...item, bodyHtml: commentHtml(item.event.body, pr.snapshot.repository),
      event: { ...item.event, body: readable(item.event.body) } })),
  };
}
export type PrView = ReturnType<typeof project>;

export function pullRequests(store: Store, monitor: Monitor, query: URLSearchParams) {
  const all = store.prs();
  const filter = filters(query);
  const order = new Map(store.prCreationOrder().map((id, index) => [id, index]));
  const items = all.filter(pr => matches(pr, filter)).map(pr => project(pr, store, monitor)).sort((a, b) =>
    Date.parse(b.latestAt ?? '1970-01-01T00:00:00Z') - Date.parse(a.latestAt ?? '1970-01-01T00:00:00Z') || order.get(a.id)! - order.get(b.id)!);
  return { items, filters: filter, repositories: [...new Set(all.map(pr => pr.snapshot.repository))].sort(),
    counts: { 'my-prs': items.filter(pr => pr.queue === 'my-prs').length, 'needs-my-review': items.filter(pr => pr.queue === 'needs-my-review').length,
      'review-requested': items.filter(pr => pr.queue === 'review-requests').length } };
}
export type PrPage = ReturnType<typeof pullRequests>;

export function notificationHistory(store: Store, query: URLSearchParams) {
  const all = store.prs();
  const prs = new Map(all.map(pr => [pr.snapshot.id, pr]));
  const filter = filters(query, true);
  const activity = new Map(all.map(pr => [pr.snapshot.id, new Map(store.activities(pr.snapshot.id).map(item => [eventKey(item.event), item]))]));
  const records = store.notifications().filter(({ data }) => {
    const pr = prs.get(data.intent.prId);
    return pr && matches(pr, filter) && (!filter.actors.length || data.intent.events.some(key => {
      const actor = activity.get(pr.snapshot.id)?.get(key)?.actorType;
      return actor && filter.actors.includes(actor);
    }));
  }).sort((a, b) => Date.parse(b.data.createdAt) - Date.parse(a.data.createdAt) || b.id - a.id);
  const pages = Math.max(1, Math.ceil(records.length / 50));
  const requested = Number(query.get('page') ?? 1);
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  const start = (page - 1) * 50;
  const headers = new Map<string, Pick<PrView, 'snapshot' | 'state' | 'tracked'>>();
  return {
    filters: filter, repositories: [...new Set(all.map(pr => pr.snapshot.repository))].sort(), page, pages, total: records.length,
    from: records.length ? start + 1 : 0, to: Math.min(start + 50, records.length),
    items: records.slice(start, start + 50).map(({ id, data }) => {
      const prId = data.intent.prId;
      let header = headers.get(prId);
      if (!header) {
        const pr = prs.get(prId)!;
        header = { snapshot: pr.snapshot, state: pr.snapshot.state === 'open' && pr.snapshot.draft ? 'draft' : pr.snapshot.state, tracked: pr.tracked };
        headers.set(prId, header);
      }
      return { id, intent: data.intent, createdAt: data.createdAt, deliveredAt: data.deliveredAt, status: data.status, reason: data.reason,
        pr: header,
        decisions: data.intent.events.flatMap(key => { const item = activity.get(prId)?.get(key); return item ? [item.decision] : []; }) };
    }),
  };
}
export type HistoryPage = ReturnType<typeof notificationHistory>;
