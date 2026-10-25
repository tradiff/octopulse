import { canonical } from './model.js';
import type { Actor, PullRequest } from './model.js';
import { ciSummary } from './ci.js';
import { readable } from './presentation.js';
import { commentHtml } from './comment.js';
import { Monitor } from './monitor.js';
import { ActivityCursor, Store } from './store.js';
import { filters } from './filters.js';

function project(pr: PullRequest, store: Store, monitor: Monitor) {
  const activity = store.activitySummary(pr.snapshot.id);
  const responsibility = monitor.responsibility(pr);
  const people = new Map<string, Actor>();
  const bots = new Set<string>();
  for (const person of activity.people) if (person.bot) bots.add(canonical(person.actor.login));
  for (const actor of [...activity.people.map(person => person.actor), ...pr.reviews.map(item => item.reviewer), ...pr.snapshot.requestedActors]) {
    const key = canonical(actor.login);
    people.set(key, actor);
    if (actor.bot || /\[bot\]$/i.test(key)) bots.add(key);
  }
  const groups: Record<'approvers' | 'commenters' | 'decliners' | 'requested', { login: string; avatar: string | null }[]> = {
    approvers: [], commenters: [], decliners: [], requested: [],
  };
  const reviewers = new Map(Object.entries(responsibility.reviewers));
  for (const person of activity.people) if (person.commenter) {
    const login = canonical(person.actor.login);
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
    activityCount: activity.count, latestAt: activity.latestAt ?? pr.recordedAt ?? pr.snapshot.updatedAt,
  };
}
export type PrView = ReturnType<typeof project>;

export function pullRequests(store: Store, monitor: Monitor, query: URLSearchParams) {
  const page = store.pullRequestPage(query, monitor.user, monitor.teams);
  return { ...page, items: page.items.map(pr => project(pr, store, monitor)), filters: filters(query), repositories: store.repositories() };
}
export type PrPage = ReturnType<typeof pullRequests>;

export function pullRequestActivity(store: Store, pr: PullRequest, cursor: ReturnType<typeof ActivityCursor.parse> | null) {
  const page = store.activityPage(pr.snapshot.id, cursor);
  return { ...page, items: page.items.map(item => ({ ...item, bodyHtml: commentHtml(item.event.body, pr.snapshot.repository),
    event: { ...item.event, body: readable(item.event.body) } })) };
}
export type ActivityPage = ReturnType<typeof pullRequestActivity>;

export function notificationHistory(store: Store, query: URLSearchParams) {
  const filter = filters(query, true);
  const page = store.notificationPage(query);
  return {
    ...page, filters: filter, repositories: store.repositories(),
    items: page.items.map(({ id, data, snapshot, tracked, decisions }) => {
      return { id, intent: data.intent, createdAt: data.createdAt, deliveredAt: data.deliveredAt, status: data.status, reason: data.reason,
        pr: { snapshot, state: snapshot.state === 'open' && snapshot.draft ? 'draft' : snapshot.state, tracked }, decisions };
    }),
  };
}
export type HistoryPage = ReturnType<typeof notificationHistory>;
