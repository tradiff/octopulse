import { filters } from './filters.js';
import type { ActivityPage, HistoryPage, PrPage, PrView } from './views.js';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const content = element<HTMLElement>('content');
const controls = element<HTMLElement>('filters');
const tabs = element<HTMLElement>('tabs');
const status = element<HTMLElement>('status');
const errorBox = element<HTMLElement>('error');
const dialog = element<HTMLDialogElement>('track-dialog');
const form = element<HTMLFormElement>('track-form');
let identity: { login: string; teams: string[]; actionToken: string } | null = null;
let sequence = 0;
let controller: AbortController | undefined;
let dialogEpoch = 0;
let renderedView: string | undefined;
let showingPrevious = false;
const expanded = new Set<string>();
const activityControllers = new Set<AbortController>();

function clearContent(): void {
  for (const request of activityControllers) request.abort();
  activityControllers.clear(); content.replaceChildren();
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function button(text: string, action: () => void, selected?: boolean): HTMLButtonElement {
  const result = node('button', text); result.type = 'button'; result.addEventListener('click', action);
  if (selected !== undefined) result.setAttribute('aria-pressed', String(selected));
  return result;
}
function link(text: string, url: string): HTMLAnchorElement {
  const result = node('a', text); result.href = url; result.rel = 'noreferrer'; return result;
}
function avatar(login: string, url: string | null): HTMLElement {
  const result = node('span', login.slice(0, 1).toUpperCase(), 'avatar'); result.title = login; result.setAttribute('role', 'img'); result.setAttribute('aria-label', login);
  try {
    if (url && new URL(url).protocol === 'https:') {
      const image = node('img'); image.src = url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { result.textContent = login.slice(0, 1).toUpperCase(); });
      result.replaceChildren(image);
    }
  } catch { return result; }
  return result;
}
function time(input: string | null, precise = false): HTMLElement {
  if (!input) return node('span', 'No activity yet');
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(input) ? input : `${input}Z`);
  if (!Number.isFinite(date.getTime())) return node('span', 'Unknown time');
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const magnitude = Math.abs(seconds);
  const [amount, unit] = magnitude < 60 ? [magnitude, 's'] : magnitude < 3600 ? [Math.floor(magnitude / 60), 'm']
    : magnitude < 86400 ? [Math.floor(magnitude / 3600), 'h'] : [Math.floor(magnitude / 86400), 'd'];
  const result = node('time', precise ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
    : seconds < 0 ? `in ${amount}${unit}` : `${amount}${unit} ago`);
  result.dateTime = date.toISOString(); result.title = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(date);
  return result;
}
function fail(error: unknown): void {
  errorBox.hidden = false;
  errorBox.querySelector('span')!.textContent = error instanceof Error ? error.message : 'Operation failed';
}
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Local request failed');
  return body;
}
function closeDialog(): void {
  dialogEpoch++; dialog.close(); form.reset(); element('track-error').textContent = '';
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!; delete submit.dataset.busy;
  updateMutationButtons();
}
function updateMutationButtons(): void {
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-requires-identity]')) control.disabled = !identity || control.dataset.busy === 'true';
}
function navigate(url: URL): void {
  if (url.pathname !== '/') closeDialog();
  history.pushState(null, '', url); void load();
}
function changeQuery(change: (query: URLSearchParams) => void, resetPage = false): void {
  const url = new URL(showingPrevious && renderedView ? renderedView : location.href);
  if (url.pathname !== '/logs' && !url.searchParams.has('pr-state')) {
    const selected = filters(url.searchParams, url.pathname === '/notification-history');
    const states = [...selected.tracking, ...selected.lifecycle];
    (states.length ? states : ['all']).forEach(value => url.searchParams.append('pr-state', value));
  }
  change(url.searchParams); if (resetPage) url.searchParams.delete('page'); navigate(url);
}
function filterControls(repositories: string[], isHistory: boolean): void {
  const restoreRepositoryFocus = document.activeElement?.id === 'repository-filter';
  controls.replaceChildren();
  const filter = filters(new URLSearchParams(location.search), isHistory);
  for (const [title, options, selected] of [
    ['Tracking', ['tracked', 'inactive'], filter.tracking], ['State', ['open', 'merged', 'closed'], filter.lifecycle],
    ...(isHistory ? [['Actor', ['self', 'human_other', 'bot'], filter.actors]] : []),
  ] as [string, string[], string[]][]) {
    const group = node('fieldset'); group.append(node('legend', title));
    const choices = node('div', undefined, 'filter-options');
    for (const value of options) {
      const control = button(value === 'human_other' ? 'Other human' : value[0]!.toUpperCase() + value.slice(1), () => {
      changeQuery(query => {
        const current = filters(query, isHistory);
        if (title === 'Actor') {
          const next = current.actors.includes(value) ? current.actors.filter(item => item !== value) : [...current.actors, value];
          query.delete('actor-type'); next.forEach(item => query.append('actor-type', item));
          if (!query.has('pr-state') && !query.has('repo') && !next.length) query.set('pr-state', 'all');
        } else {
          const all = [...current.tracking, ...current.lifecycle];
          const next = all.includes(value) ? all.filter(item => item !== value) : [...all, value];
          query.delete('pr-state'); (next.length ? next : ['all']).forEach(item => query.append('pr-state', item));
        }
      }, true);
      }, selected.includes(value));
      control.dataset.focusKey = `filter:${title}:${value}`; choices.append(control);
    }
    group.append(choices);
    controls.append(group);
  }
  const repositoryFilter = node('div', undefined, 'repository-filter');
  const label = node('label', 'Repository'); label.htmlFor = 'repository-filter';
  const picker = node('div', undefined, 'repository-picker');
  const input = node('input'); input.id = 'repository-filter'; input.type = 'search'; input.autocomplete = 'off';
  input.dataset.focusKey = 'repository';
  input.placeholder = 'All repositories'; input.value = filter.repository;
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'repository-options'); input.setAttribute('aria-expanded', 'false');
  const list = node('div', undefined, 'repository-options'); list.id = 'repository-options'; list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Repositories'); list.hidden = true;
  const options = [{ value: '', label: 'All repositories' }, ...[...new Set([...repositories, ...(filter.repository ? [filter.repository] : [])])].map(repo => ({ value: repo, label: repo }))];
  let matches = options;
  let active = -1;
  const close = () => {
    list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    input.value = filter.repository;
  };
  const activate = (index: number) => {
    list.children.item(active)?.setAttribute('aria-selected', 'false');
    active = index;
    const option = list.children.item(active);
    if (option) { option.setAttribute('aria-selected', 'true'); input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = (value: string) => {
    close(); input.value = value;
    changeQuery(query => { query.set('repo', value); }, true);
  };
  const show = (query = '') => {
    const search = query.trim().toLowerCase();
    matches = options.filter(option => option.label.toLowerCase().includes(search));
    list.replaceChildren(); list.hidden = false; input.setAttribute('aria-expanded', 'true');
    for (const [index, option] of matches.entries()) {
      const item = button(option.label, () => choose(option.value)); item.id = `repository-option-${index}`;
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false'); item.tabIndex = -1;
      item.addEventListener('pointerdown', event => event.preventDefault());
      list.append(item);
    }
    if (!matches.length) { const empty = node('p', 'No matching repositories'); empty.setAttribute('role', 'status'); list.append(empty); }
    activate(search ? (matches.length ? 0 : -1) : matches.findIndex(option => option.value === filter.repository));
  };
  input.addEventListener('focus', () => { show(); input.select(); });
  input.addEventListener('click', () => { if (list.hidden) show(); });
  input.addEventListener('input', () => show(input.value));
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) { show(); activate(event.key === 'ArrowDown' ? 0 : matches.length - 1); }
      else if (matches.length) activate((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault(); const option = matches[active]; if (option) choose(option.value);
    } else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  picker.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node) || !picker.contains(event.relatedTarget)) close(); });
  picker.append(input, list); repositoryFilter.append(label, picker); controls.append(repositoryFilter);
  const clear = button('Clear filters', () => changeQuery(query => { query.delete('pr-state'); query.set('pr-state', 'all'); query.delete('repo'); query.delete('actor-type'); }, true));
  clear.className = 'clear-filters'; clear.dataset.focusKey = 'clear-filters'; controls.append(clear);
  if (restoreRepositoryFocus) { input.focus(); close(); }
}
async function mutation(path: string, method: string, body: unknown): Promise<unknown> {
  if (!identity) throw new Error('Identity is unavailable. Retry loading before acting.');
  return api(path, { method, headers: { 'Content-Type': 'application/json', 'X-Octopulse-Action': identity.actionToken }, body: JSON.stringify(body) });
}
function actionButton(text: string, action: () => Promise<unknown>): HTMLButtonElement {
  const result = button(text, () => {
    result.dataset.busy = 'true'; result.disabled = true; status.textContent = 'Applying local action…';
    void action().then(() => load()).catch(error => { status.textContent = 'Action failed.'; fail(error); }).finally(() => { delete result.dataset.busy; updateMutationButtons(); });
  });
  result.dataset.requiresIdentity = '';
  result.disabled = !identity; return result;
}
function prSummary(pr: Pick<PrView, 'snapshot' | 'state' | 'tracked'>, activityCount?: number): HTMLElement {
  const result = node('div', undefined, 'pr-summary');
  const main = node('div', undefined, 'row-main');
  const repository = node('div', undefined, 'repository'); repository.append(node('span', pr.snapshot.repository), node('span', `#${pr.snapshot.number}`, 'pr-number'));
  const title = link(pr.snapshot.title, `https://github.com/${pr.snapshot.repository}/pull/${pr.snapshot.number}`); title.className = 'row-title';
  const state = node('img', undefined, 'pr-state-icon'); state.src = `/git-${pr.state}-inline.svg`;
  state.alt = pr.state[0]!.toUpperCase() + pr.state.slice(1); state.title = state.alt; state.width = 20; state.height = 20;
  main.append(state, title, repository);
  const meta = node('div', undefined, 'meta pr-meta'); meta.append(node('span', `by ${pr.snapshot.author}`, 'pr-author'));
  if (activityCount !== undefined) meta.append(node('span', `${activityCount} ${activityCount === 1 ? 'activity' : 'activities'}`));
  if (!pr.tracked) meta.append(node('span', 'Inactive', 'tracking-status'));
  main.append(meta); result.append(avatar(pr.snapshot.author, pr.snapshot.authorAvatar), main); return result;
}
function prCard(pr: PrView): HTMLElement {
  const card = node('details', undefined, 'pr'); card.open = expanded.has(pr.id); card.dataset.pr = pr.id;
  card.addEventListener('toggle', () => {
    if (card.open) { expanded.add(pr.id); if (!loaded) void loadActivity(); } else expanded.delete(pr.id);
  });
  const summary = node('summary'); summary.setAttribute('aria-label', `Details for ${pr.snapshot.repository} #${pr.snapshot.number}: ${pr.snapshot.title}`);
  const review = node('div', undefined, 'review-status');
  const direct = pr.groups.requested.some(person => person.login.toLowerCase() === identity?.login.toLowerCase());
  let reviewLabel = 'No pending request';
  if (pr.queue === 'needs-my-review') reviewLabel = direct ? 'Your review requested' : 'Team review requested';
  else if (pr.groups.decliners.length) reviewLabel = 'Changes requested';
  else if (pr.groups.requested.length || pr.pendingTeams.length) reviewLabel = 'Awaiting review';
  else if (pr.groups.approvers.length) reviewLabel = 'Approved';
  review.append(node('span', reviewLabel, `review-label${pr.queue === 'needs-my-review' ? ' review-required' : ''}`));
  if (pr.merge) review.append(node('span', pr.merge, 'merge-status'));
  if (pr.pendingTeams.length) review.append(node('p', `Requested teams: ${pr.pendingTeams.join(', ')}`, 'pending-teams'));
  const ci = node('div', undefined, `ci-status ci-${pr.ci.outcome ?? 'pending'}`);
  const counts = Object.entries(pr.ci.counts).filter(([, count]) => count > 0).map(([key, count]) => `${count} ${key}`).join(' · ');
  if (counts || pr.ci.outcome || pr.ci.workflows.length || pr.ci.uncertain) {
    ci.append(node('span', pr.ci.outcome === 'failure' ? 'CI failed' : pr.ci.outcome === 'success' ? 'CI passed' : pr.ci.counts.pending ? 'CI in progress' : 'CI results', 'ci-label'),
      node('span', counts || 'No job details', 'ci-counts'));
    if (pr.ci.uncertain) ci.append(node('span', 'ordering uncertain', 'ci-uncertain'));
  } else {
    ci.classList.add('ci-empty'); ci.append(node('span', 'No current-head results', 'ci-label'));
  }
  const groups = node('div', undefined, 'groups');
  for (const [key, label] of [['approvers', 'Approvers'], ['commenters', 'Commenters / Reviewers'], ['decliners', 'Decliners'], ['requested', 'Requested Reviewers']] as const) {
    if (!pr.groups[key].length) continue;
    const group = node('div', undefined, `group group-${key}`); group.append(node('span', label, 'group-label'));
    const people = node('span', undefined, 'avatar-stack');
    for (const person of pr.groups[key]) people.append(avatar(person.login, person.avatar)); group.append(people); groups.append(group);
  }
  const reviewers = node('div', undefined, 'summary-reviewers');
  const people = [...new Map(Object.values(pr.groups).flat().map(person => [person.login.toLowerCase(), person])).values()];
  for (const person of people.slice(0, 3)) reviewers.append(avatar(person.login, person.avatar));
  if (people.length > 3) reviewers.append(node('span', `+${people.length - 3}`, 'muted'));
  if (!people.length) reviewers.append(node('span', 'None', 'muted'));
  const updated = node('div', undefined, 'row-updated'); updated.append(time(pr.latestAt));
  summary.append(prSummary(pr, pr.activityCount), review, ci, reviewers, updated); card.append(summary);
  const body = node('div', undefined, 'pr-body');
  const actions = node('div', undefined, 'actions detail-toolbar'); actions.append(actionButton(pr.tracked ? 'Untrack' : 'Retrack', () => pr.tracked
    ? mutation(`/api/tracked-pull-requests/${encodeURIComponent(pr.id)}`, 'DELETE', {})
    : mutation('/api/tracked-pull-requests', 'POST', { url: pr.destination })));
  actions.append(node('span', pr.baselineComplete ? 'Baseline complete' : 'Initial baseline incomplete', 'muted'));
  const freshness = node('span', 'Last local update: ', 'detail-freshness muted'); freshness.append(time(pr.recordedAt)); actions.append(freshness);
  if (groups.childElementCount) {
    const reviewSection = node('section', undefined, 'review-section'); reviewSection.append(node('h3', 'Review state'), groups); body.append(reviewSection);
  }
  const columns = node('div', undefined, 'detail-columns');
  const activitySection = node('section', undefined, 'activity-section'); activitySection.append(node('h3', 'Activity timeline'));
  const timeline = node('ol', undefined, 'timeline');
  const activityStatus = node('p', 'Expand to load saved activity.', 'muted'); activityStatus.setAttribute('role', 'status');
  let loaded = false;
  let loading = false;
  let nextCursor: string | null = null;
  const more = button('Load more activity', () => { void loadActivity(); }); more.hidden = true;
  async function loadActivity(): Promise<void> {
    if (loading || !card.isConnected) return;
    const restoreFocus = document.activeElement === more;
    const request = new AbortController(); activityControllers.add(request);
    loading = true; more.disabled = true; activitySection.setAttribute('aria-busy', 'true'); activityStatus.textContent = 'Loading saved activity…';
    try {
      const query = nextCursor ? `?${new URLSearchParams({ cursor: nextCursor })}` : '';
      const response = await api(`/api/pull-requests/${encodeURIComponent(pr.id)}/activity${query}`, { signal: request.signal });
      if (request.signal.aborted || !card.isConnected) return;
      if (!response || typeof response !== 'object' || !('items' in response) || !Array.isArray(response.items)
        || !('total' in response) || !Number.isSafeInteger(response.total)
        || !('nextCursor' in response) || !(response.nextCursor === null || typeof response.nextCursor === 'string')) {
        throw new Error('Activity response is invalid');
      }
      const page = response as ActivityPage;
      for (const activity of page.items) {
        const item = node('li'); const header = node('div', undefined, 'meta');
        if (activity.event.actor) header.append(avatar(activity.event.actor.login, activity.event.actor.avatar ?? null));
        header.append(node('strong', `${activity.event.actor?.login ? `${activity.event.actor.login}: ` : ''}${activity.event.kind.replaceAll('_', ' ')}`),
          time(activity.event.occurredAt));
        if (activity.decision !== 'eligible') header.append(node('span', activity.decision.replaceAll('_', ' '), 'badge'));
        item.append(header);
        if (activity.bodyHtml) {
          const body = node('div', undefined, 'comment-body');
          // Only the server's allowlisted Markdown output enters this HTML sink.
          body.innerHTML = activity.bodyHtml; item.append(body);
        } else if (activity.event.body) item.append(node('p', activity.event.body));
        timeline.append(item);
      }
      loaded = true; nextCursor = page.nextCursor;
      activityStatus.textContent = page.total ? `${timeline.childElementCount} of ${page.total} activities loaded.` : 'No saved activity.';
      more.textContent = 'Load more activity'; more.hidden = nextCursor === null;
    } catch (error) {
      if (!card.isConnected) return;
      activityStatus.textContent = `Unable to load activity. ${error instanceof Error ? error.message : 'Try again.'}`;
      more.textContent = 'Retry loading activity'; more.hidden = false;
    } finally {
      activityControllers.delete(request);
      loading = false; more.disabled = false; activitySection.removeAttribute('aria-busy');
      if (restoreFocus && card.isConnected && document.activeElement === document.body) {
        activitySection.tabIndex = -1; (more.hidden ? activitySection : more).focus({ preventScroll: true });
      }
    }
  }
  activitySection.append(timeline, activityStatus, more);
  const ciSection = node('section', undefined, 'ci-section'); ciSection.append(node('h3', 'Current-head CI'));
  if (pr.ci.uncertain) ciSection.append(node('p', 'Workflow ordering is uncertain. Last established results are retained.', 'muted'));
  if (!pr.ci.workflows.length) ciSection.append(node('p', 'No current-head workflow results.', 'muted'));
  for (const workflow of pr.ci.workflows) {
    const group = node('section', undefined, 'ci'); group.append(node('strong', `${workflow.name || `Workflow ${workflow.id}`} · ${workflow.trigger} · attempt ${workflow.attempt ?? '?'} · ${workflow.state}`));
    const jobs = node('ul'); for (const job of workflow.jobs) jobs.append(node('li', `${job.name}: ${job.state}`, `state-${job.state}`)); group.append(jobs); ciSection.append(group);
  }
  columns.append(activitySection, ciSection); body.append(columns, actions);
  card.append(body); return card;
}
function renderPrs(data: PrPage): void {
  filterControls(data.repositories, false); tabs.replaceChildren();
  const selected = new URLSearchParams(location.search).get('tab');
  const tab = selected === 'needs-my-review' || selected === 'review-requested' ? selected : 'my-prs';
  for (const [key, label] of [['my-prs', 'My PRs'], ['needs-my-review', 'Needs My Review'], ['review-requested', 'Review Requests']] as const) {
    const queue = button('', () => changeQuery(query => query.set('tab', key), true), key === tab);
    queue.setAttribute('aria-label', `${label} (${data.counts[key]})`);
    queue.dataset.focusKey = `queue:${key}`;
    queue.append(node('span', label), node('span', String(data.counts[key]), 'queue-count')); tabs.append(queue);
  }
  const items = data.items;
  const summary = element('result-summary'); summary.hidden = false;
  summary.replaceChildren(node('span', `${data.total} pull ${data.total === 1 ? 'request' : 'requests'}`));
  clearContent();
  if (items.length) {
    const headings = node('div', undefined, 'list-headings'); headings.setAttribute('aria-hidden', 'true');
    for (const label of ['', 'Pull request', 'Review', 'Current-head CI', 'Reviewers', 'Updated ↓']) headings.append(node('span', label));
    content.append(headings, ...items.map(prCard));
  }
  if (!items.length) {
    const empty = node('div', undefined, 'empty'); empty.append(node('span', '✓', 'empty-symbol'), node('h2', 'No matching pull requests'),
      node('p', 'No pull requests match this queue and its filters.'), node('p', 'Try another queue or adjust the filters above.', 'empty-hint')); content.append(empty);
  }
  if (data.pages > 1) content.append(pagination(data, 'Pull request pages'));
}
function pagination(data: Pick<HistoryPage, 'page' | 'pages' | 'from' | 'to' | 'total'>, label: string): HTMLElement {
  const result = node('nav', undefined, 'pagination'); result.setAttribute('aria-label', label); result.tabIndex = -1;
  const previous = button('Previous', () => changeQuery(query => query.set('page', String(data.page - 1)))); previous.disabled = data.page <= 1;
  const next = button('Next', () => changeQuery(query => query.set('page', String(data.page + 1)))); next.disabled = data.page >= data.pages;
  previous.dataset.focusKey = 'page:previous'; next.dataset.focusKey = 'page:next';
  result.append(previous, node('span', `${data.from}–${data.to} of ${data.total} · Page ${data.page} of ${data.pages}`), next); return result;
}
function renderHistory(data: HistoryPage): void {
  filterControls(data.repositories, true); tabs.replaceChildren(); clearContent();
  for (const record of data.items) {
    const card = node('details', undefined, 'notification'); const header = node('summary', undefined, 'notification-header');
    const snapshot = record.pr.snapshot;
    const description = node('div', undefined, 'notification-description'); description.append(prSummary(record.pr));
    const excerpt = Array.from(record.intent.body.replace(/\s+/g, ' ').trim());
    if (excerpt.length) description.append(node('span', `${excerpt.slice(0, 180).join('')}${excerpt.length > 180 ? '…' : ''}`, 'notification-preview'));
    if (record.status !== 'sent') description.append(node('span', record.status === 'failed' ? 'Failed' : 'Pending', `delivery-status delivery-${record.status}`));
    header.append(description, time(record.createdAt, true));
    const body = node('div', undefined, 'notification-detail');
    const preview = node('section'); preview.append(node('h3', 'Notification content'), node('p', record.intent.body || record.intent.title, 'notification-body'),
      link('Open pull request on GitHub ↗', `https://github.com/${snapshot.repository}/pull/${snapshot.number}`));
    const delivery = node('section'); delivery.append(node('h3', 'Recorded delivery state'));
    const created = node('p', undefined, 'meta'); created.append(node('span', 'Created'), time(record.createdAt)); delivery.append(created);
    if (record.deliveredAt) { const accepted = node('p', undefined, 'meta'); accepted.append(node('span', 'Accepted by desktop service'), time(record.deliveredAt)); delivery.append(accepted); }
    if (record.reason) delivery.append(node('p', record.reason, 'delivery-reason'));
    delivery.append(node('p', [...new Set(record.decisions)].join(', ').replaceAll('_', ' '), 'muted'),
      node('p', 'Service acceptance does not confirm the notification was displayed or read.', 'delivery-note'),
      actionButton('Resend', () => mutation(`/api/notification-records/${record.id}/resend`, 'POST', {})));
    body.append(preview, delivery); card.append(header, body); content.append(card);
  }
  if (!data.items.length) content.append(node('p', 'No notifications match these filters.', 'empty'));
  content.append(pagination(data, 'Notification pages'));
}
function renderLogs(data: { items: { at: string; level: string; message: string; context?: unknown }[] }): void {
  tabs.replaceChildren(); controls.replaceChildren(); clearContent();
  const label = node('label', 'Exact level'); const select = node('select'); select.setAttribute('aria-label', 'Log level');
  select.dataset.focusKey = 'log-level';
  for (const level of ['', 'debug', 'info', 'warn', 'error']) { const option = node('option', level || 'All'); option.value = level; select.append(option); }
  select.value = new URLSearchParams(location.search).get('level') ?? '';
  select.addEventListener('change', () => changeQuery(query => { if (select.value) query.set('level', select.value); else query.delete('level'); }));
  label.append(select); controls.append(label);
  for (const entry of data.items) {
    const card = node('article', undefined, 'log');
    card.append(time(entry.at), node('strong', entry.level.toUpperCase(), `log-level level-${entry.level}`), node('p', entry.message, 'log-message'));
    if (entry.context !== undefined) { const details = node('details'); details.append(node('summary', 'Context'), node('pre', JSON.stringify(entry.context, null, 2))); card.append(details); }
    content.append(card);
  }
  if (!data.items.length) content.append(node('p', 'No matching log entries.', 'empty'));
}
async function load(): Promise<void> {
  const version = ++sequence; controller?.abort(); const current = new AbortController(); controller = current;
  const initialFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const disabledFocusKey = initialFocus?.matches('[data-requires-identity]') ? initialFocus.dataset.focusKey : undefined;
  let focusKey: string | undefined;
  showingPrevious = false;
  errorBox.hidden = true; content.setAttribute('aria-busy', 'true'); status.textContent = 'Loading local state…';
  identity = null; updateMutationButtons();
  const path = location.pathname;
  const title = path === '/logs' ? 'Logs' : path === '/notification-history' ? 'Notification History' : 'Pull Requests';
  if (!renderedView || new URL(renderedView).pathname !== path) {
    renderedView = undefined; clearContent(); controls.replaceChildren(); tabs.replaceChildren(); element('result-summary').hidden = true;
    element('identity').textContent = 'Loading identity…';
  }
  document.querySelector('main')!.setAttribute('aria-label', title); document.title = `${title} · Octopulse`; element('track').hidden = path !== '/';
  const workbar = element('workbar'); workbar.hidden = path !== '/';
  const actionParent = path === '/' ? workbar : element('filter-bar');
  if (element('page-actions').parentElement !== actionParent) actionParent.append(element('page-actions'));
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('.masthead nav a')) {
    if (new URL(anchor.href).pathname === path) anchor.setAttribute('aria-current', 'page'); else anchor.removeAttribute('aria-current');
  }
  try {
    const endpoint = path === '/logs' ? '/api/logs' : path === '/notification-history' ? '/api/notification-history' : '/api/pull-request-timeline';
    const meRequest = api('/api/me', { signal: current.signal });
    const dataRequest = api(endpoint + location.search, { signal: current.signal }).then(
      value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
    let me: unknown;
    try { me = await meRequest; }
    catch (error) { if (version === sequence && !current.signal.aborted) element('identity').textContent = 'Identity unavailable'; throw error; }
    if (version !== sequence) return;
    if (!me || typeof me !== 'object' || !('login' in me) || typeof me.login !== 'string' || !('teams' in me) || !Array.isArray(me.teams)
      || !me.teams.every(team => typeof team === 'string') || !('actionToken' in me) || typeof me.actionToken !== 'string') {
      element('identity').textContent = 'Identity unavailable'; throw new Error('Identity response is invalid');
    }
    identity = { login: me.login, teams: me.teams, actionToken: me.actionToken }; element('identity').textContent = identity.login ? `@${identity.login}` : 'Local profile';
    const dataResult = await dataRequest;
    if (version !== sequence || current.signal.aborted) return;
    if (dataResult.status === 'rejected') throw dataResult.reason;
    const data = dataResult.value;
    if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) throw new Error('Local data response is invalid');
    focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    if (path === '/logs') renderLogs(data as Parameters<typeof renderLogs>[0]);
    else if (path === '/notification-history') renderHistory(data as HistoryPage); else renderPrs(data as PrPage);
    renderedView = location.href;
    status.textContent = `Local state refreshed at ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (version !== sequence || current.signal.aborted) return;
    current.abort();
    showingPrevious = renderedView !== undefined;
    status.textContent = renderedView ? (renderedView === location.href ? 'Refresh failed. Showing previous results.' : 'Could not apply these filters. Showing previous results.') : 'Unable to load local state. Retry to try again.';
    fail(error);
  } finally {
    if (version === sequence) {
      content.removeAttribute('aria-busy'); updateMutationButtons();
      focusKey ??= document.activeElement === document.body ? disabledFocusKey : undefined;
      if (focusKey) {
        const replacement = [...document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(el => el.dataset.focusKey === focusKey);
        const destination = replacement instanceof HTMLButtonElement && replacement.disabled
          ? replacement.closest<HTMLElement>('.pagination') ?? (!errorBox.hidden ? element('retry') : undefined) : replacement;
        destination?.focus({ preventScroll: true });
      }
    }
  }
}

document.querySelector('.masthead')!.addEventListener('click', event => {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>('a');
  if (!anchor || !(event instanceof MouseEvent) || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); navigate(new URL(anchor.href));
});
window.addEventListener('popstate', () => { closeDialog(); void load(); });
element('refresh').addEventListener('click', () => { void load(); }); element('retry').addEventListener('click', () => { void load(); });
element('track').addEventListener('click', () => { dialogEpoch++; form.reset(); element('track-error').textContent = ''; dialog.showModal(); });
element('cancel-track').addEventListener('click', closeDialog);
dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
form.addEventListener('submit', event => {
  event.preventDefault(); const epoch = dialogEpoch; const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.dataset.busy = 'true'; submit.disabled = true;
  void mutation('/api/tracked-pull-requests', 'POST', { url: element<HTMLInputElement>('pr-url').value }).then(async result => {
    if (epoch !== dialogEpoch) return;
    closeDialog(); await load();
    if (errorBox.hidden && result && typeof result === 'object' && 'status' in result) status.textContent = result.status === 'already-tracked' ? 'Already tracked. Local state refreshed.' : 'Pull request tracked. Local state refreshed.';
  }).catch(error => { if (epoch === dialogEpoch) element('track-error').textContent = error instanceof Error ? error.message : 'Tracking failed'; })
    .finally(() => { if (epoch === dialogEpoch) { delete submit.dataset.busy; updateMutationButtons(); } });
});
void load();
