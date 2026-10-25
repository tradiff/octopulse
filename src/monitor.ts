import { isDeepStrictEqual } from 'node:util';
import { Activity, Choice, Observation, PullRequest, Snapshot, canonical, compareEvents, eventKey, sourceNames } from './model.js';
import type { Classifier, Clock, Event, Review } from './model.js';
import { evaluateCi } from './ci.js';
import { abortable } from './cancellation.js';
import { intent, readable } from './presentation.js';
import { Store } from './store.js';

export class Monitor {
  private readonly processing = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    readonly user: string,
    readonly teams: string[],
    private readonly reviewCutoff: string,
    private readonly classifier?: Classifier,
    private readonly graceMs = 7 * 86_400_000,
  ) {}

  track(input: unknown, origin: 'manual' | 'discovery'): void {
    if (this.stopped) throw new Error('Monitor is stopped');
    const snapshot = Snapshot.parse(input);
    this.store.transaction(() => {
      const old = this.store.pr(snapshot.id);
      if (old?.snapshot.updatedAt && snapshot.updatedAt && Date.parse(snapshot.updatedAt) < Date.parse(old.snapshot.updatedAt)) return;
      if (old && (old.tracked || origin === 'discovery')) {
        const reopened = !old.manualUntracked && snapshot.state === 'open';
        this.save({ ...old, snapshot, revision: old.revision + 1,
          tracked: reopened || old.tracked, graceUntil: reopened ? null : old.graceUntil });
        return;
      }
      const pr = PullRequest.parse({
        snapshot, tracked: true, manualUntracked: false, generation: (old?.generation ?? 0) + 1,
        baselineComplete: false, completeSources: [], reviewAlertAt: null, reviews: old?.reviews ?? [],
        origin, revision: (old?.revision ?? 0) + 1, ci: old?.ci ?? {},
      });
      this.save(pr);
      for (const batch of this.store.staged(snapshot.id)) {
        if (!batch.data.processed) this.store.saveStaged(batch.id, { ...batch.data, generation: pr.generation });
      }
      if (this.currentRequest(snapshot) && !this.own(pr)) {
        const event: Event = {
          source: 'timeline', id: `current-review:${pr.generation}`, kind: 'review_requested',
          occurredAt: this.clock.now(), actor: null, body: '', targetUser: this.user,
        };
        this.prepare(pr, [event], 'immediate', []);
        pr.reviewAlertAt = this.clock.now();
        this.save(pr);
      }
    });
  }

  untrack(prId: string): void {
    this.store.transaction(() => {
      const pr = this.requirePr(prId);
      if (!pr.manualUntracked) {
        this.save({ ...pr, tracked: false, manualUntracked: true, generation: pr.generation + 1, revision: pr.revision + 1 });
      }
      for (const { id, data } of this.store.notifications()) {
        if (data.intent.prId === prId && data.status !== 'sent') {
          this.store.saveNotification(id, { ...data, automatic: false, nextAttemptAt: null, reason: 'untracked' });
        }
      }
    });
  }

  observe(input: unknown): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Monitor is stopped'));
    let observation: Observation;
    try { observation = Observation.parse(input); } catch (error) { return Promise.reject(error); }
    const generation = this.requirePr(observation.snapshot.id).generation;
    return this.serialize(observation.snapshot.id, () => this.process(observation, generation));
  }

  poll(prId: string, fetch: (pr: PullRequest, signal: AbortSignal) => Promise<unknown>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Monitor is stopped'));
    return this.serialize(prId, async () => {
      const pr = this.requirePr(prId);
      if (!this.eligible(pr)) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const observation = Observation.parse(await abortable(fetch(pr, controller.signal), controller.signal));
        if (observation.snapshot.id !== prId || observation.snapshot.number !== pr.snapshot.number) throw new Error('Mismatched pull request detail');
        const current = this.requirePr(prId);
        if (this.stopped || current.generation !== pr.generation || current.revision !== pr.revision) {
          this.store.stage(prId, { observation, generation: pr.generation, observedAt: this.clock.now(), processed: false });
          return;
        }
        await this.process(observation, pr.generation);
      } finally { this.controllers.delete(controller); }
    });
  }

  lookup(prId: string, origin: 'manual' | 'discovery', fetch: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Monitor is stopped'));
    return this.serialize(prId, async () => {
      const previous = this.store.pr(prId);
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const snapshot = Snapshot.parse(await abortable(fetch(controller.signal), controller.signal));
        if (snapshot.id !== prId) throw new Error('Mismatched pull request detail');
        const current = this.store.pr(prId);
        if (this.stopped || current?.revision !== previous?.revision) return;
        this.track(snapshot, origin);
      } finally { this.controllers.delete(controller); }
    });
  }

  private async serialize(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.processing.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => { if (!this.stopped) return task(); });
    this.processing.set(id, current);
    try { await current; } finally { if (this.processing.get(id) === current) this.processing.delete(id); }
  }

  private async process(observation: Observation, generation: number): Promise<void> {
    const pr = this.requirePr(observation.snapshot.id);
    if (pr.generation !== generation || !this.eligible(pr)) return;
    if (pr.snapshot.updatedAt && observation.snapshot.updatedAt && Date.parse(observation.snapshot.updatedAt) < Date.parse(pr.snapshot.updatedAt)) {
      this.store.stage(pr.snapshot.id, { observation, generation, observedAt: this.clock.now(), processed: false });
      return;
    }
    for (const source of sourceNames) {
      if (observation.sources[source] === 'unchanged' && !pr.completeSources.includes(source)) {
        throw new Error(`Unchanged ${source} without a complete cached observation`);
      }
    }
    if (pr.snapshot.head !== observation.snapshot.head && (observation.sources.workflows === 'unchanged' || observation.sources.jobs === 'unchanged')) {
      throw new Error('Workflow cache does not belong to the current head');
    }
    const unchanged = pr.baselineComplete && sourceNames.every(source => observation.sources[source] === 'unchanged')
      && !observation.events.length && !observation.reviews.length && !observation.workflows?.length && !observation.rawIds.length
      && isDeepStrictEqual(pr.snapshot, observation.snapshot)
      && (!observation.fetchState || isDeepStrictEqual(pr.fetchState, observation.fetchState));
    if (unchanged && !this.store.staged(pr.snapshot.id, pr.generation).length) return;
    pr.snapshot = observation.snapshot;
    pr.revision++;
    pr.completeSources = sourceNames.filter(source => pr.completeSources.includes(source) || observation.sources[source] === 'complete');
    this.store.transaction(() => {
      if (!unchanged) this.store.stage(pr.snapshot.id, {
        observation, generation: pr.generation, observedAt: this.clock.now(), processed: false,
      });
      this.save(pr);
    });
    if (sourceNames.some(source => observation.sources[source] === 'incomplete') || observation.workflows?.some(run => !run.jobsComplete)) return;

    const batches = this.store.staged(pr.snapshot.id, pr.generation);
    const history = this.store.activities(pr.snapshot.id);
    const known = new Set(history.map(activity => eventKey(activity.event)));
    const fresh = new Map<string, { event: Event; observedAt: string }>();
    for (const batch of batches) {
      for (const event of batch.data.observation.events) {
        if (!known.has(eventKey(event)) && !fresh.has(eventKey(event))) {
          fresh.set(eventKey(event), { event, observedAt: batch.data.observedAt });
        }
      }
    }
    if (pr.snapshot.head) {
      const head = pr.snapshot.head;
      const runs = batches.filter(batch => batch.data.observation.snapshot.head === head)
        .flatMap(batch => batch.data.observation.workflows ?? []).filter(run => run.jobsComplete);
      const result = evaluateCi(head, pr.ci[head], runs, this.clock.now());
      pr.ci[head] = result.state;
      if (!pr.baselineComplete && result.state.uncertain) {
        this.save(pr);
        return;
      }
      if (result.event && !known.has(eventKey(result.event))) fresh.set(eventKey(result.event), { event: result.event, observedAt: this.clock.now() });
    }
    const events = [...fresh.values()].sort((a, b) => compareEvents(a.event, b.event));
    const all = [...history.map(activity => activity.event), ...events.map(item => item.event)];
    const latestRequest = events.findLast(({ event }) => this.eligibleRequest(pr, event))?.event;
    const linkedReviews = new Set(all.flatMap(event => event.kind === 'inline_comment' && event.reviewId ? [event.reviewId] : []));
    const decisions: Activity[] = [];
    for (const { event, observedAt } of events) {
      const activity: Activity = {
        event, observedAt, actorType: this.actorType(event), decision: 'eligible',
        delivery: 'bundle', classification: null, visible: true,
      };
      const redundantWrapper = event.kind === 'review' && !readable(event.body) && linkedReviews.has(event.id);
      const redundantClose = event.kind === 'close' && event.actor
        && events.some(({ event: other }) => other.kind === 'merge' && other.actor
          && canonical(other.actor.login) === canonical(event.actor!.login)
          && Math.abs(Date.parse(other.occurredAt) - Date.parse(event.occurredAt)) <= 1000);
      if (redundantWrapper || redundantClose) {
        activity.decision = redundantWrapper ? 'redundant_wrapper' : 'redundant_close';
        activity.visible = false;
      } else if (!pr.baselineComplete) activity.decision = 'baseline';
      else if (event.kind === 'commit') activity.decision = 'commit_timeline_only';
      else if (event.kind.startsWith('ci_')) {
        if (!this.own(pr)) activity.decision = 'non_owned_ci';
      } else if (activity.actorType === 'self') activity.decision = 'self';
      else if (event.kind === 'review_requested') {
        if (!this.eligibleRequest(pr, event)) activity.decision = 'review_request_ineligible';
        else if (event !== latestRequest) activity.decision = 'superseded_request';
        else activity.delivery = 'immediate';
      } else if (['comment', 'inline_comment', 'review', 'approval', 'changes_requested'].includes(event.kind)) {
        if (activity.actorType === 'bot' && !this.own(pr)) activity.decision = 'bot_non_owned';
        else if (activity.actorType === 'bot' && event.body.trim()) {
          if (!this.classifier) activity.classification = { type: 'fallback', reason: 'not_configured' };
          else {
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
              const answer = Choice.safeParse(await abortable(this.classifier.classify(event.body, controller.signal), controller.signal));
              activity.classification = answer.success ? answer.data : { type: 'fallback', reason: 'invalid_answer' };
            } catch (error) {
              if (controller.signal.aborted) throw error;
              activity.classification = { type: 'fallback', reason: 'provider_failure' };
            } finally { this.controllers.delete(controller); }
          }
          if (activity.classification.type === 'Choice' && activity.classification.choice === 'suppress') {
            activity.decision = 'classified_suppress';
          }
        } else if (activity.actorType !== 'bot' && ['approval', 'changes_requested'].includes(event.kind)) activity.delivery = 'immediate';
      }
      if (activity.decision !== 'eligible') activity.delivery = 'none';
      decisions.push(activity);
    }
    this.store.transaction(() => {
      const current = this.requirePr(pr.snapshot.id);
      if (this.stopped || current.generation !== pr.generation || current.revision !== pr.revision || !this.eligible(current)) return;
      for (const activity of decisions) this.store.saveActivity(pr.snapshot.id, activity);
      const combined = [...history, ...decisions];
      for (const activity of decisions.filter(item => item.delivery === 'immediate')) {
        this.prepare(pr, [activity.event], 'immediate', combined);
      }
      const bundled = decisions.filter(item => item.delivery === 'bundle').map(item => item.event);
      if (bundled.length) this.prepare(pr, bundled, 'bundled', combined);
      const reviewBatch = batches.findLast(batch => batch.data.observation.sources.reviews === 'complete');
      this.save({ ...pr, baselineComplete: true, reviews: reviewBatch?.data.observation.reviews ?? pr.reviews,
        fetchState: observation.fetchState ?? pr.fetchState });
      for (const activity of history) {
        if (activity.event.kind === 'review' && activity.visible && !readable(activity.event.body) && linkedReviews.has(activity.event.id)) {
          this.store.updateActivity(pr.snapshot.id, { ...activity, visible: false });
        }
      }
      for (const batch of batches) {
        this.store.completeRaw(pr.snapshot.id, batch.data.observation.rawIds);
        const completed = { ...batch.data.observation };
        delete completed.fetchState;
        this.store.saveStaged(batch.id, { ...batch.data, observation: completed, processed: true });
      }
    });
  }

  eligible(pr: PullRequest): boolean {
    return !pr.manualUntracked && (pr.tracked || (pr.graceUntil !== null && Date.parse(this.clock.now()) < Date.parse(pr.graceUntil)));
  }

  reconcile(): void {
    this.store.transaction(() => {
      for (const pr of this.store.prs()) {
        if (pr.manualUntracked) continue;
        if (pr.snapshot.state === 'open') {
          if (!pr.tracked || pr.graceUntil) this.save({ ...pr, tracked: true, graceUntil: null, revision: pr.revision + 1 });
        } else {
          const closed = pr.snapshot.mergedAt ?? pr.snapshot.closedAt;
          if (!closed) continue;
          const graceUntil = new Date(Date.parse(closed) + this.graceMs).toISOString();
          if (pr.tracked || pr.graceUntil !== graceUntil) this.save({ ...pr, tracked: false, graceUntil, revision: pr.revision + 1 });
        }
      }
    });
  }

  select(kind: 'active' | 'grace'): string[] {
    this.reconcile();
    return this.store.prs().filter(pr => this.eligible(pr) && (kind === 'active' ? pr.tracked : !pr.tracked)).map(pr => pr.snapshot.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.processing.values());
  }

  private prepare(pr: PullRequest, events: Event[], kind: 'immediate' | 'bundled', history: Activity[]): void {
    this.store.insertNotification({
      intent: intent(pr.snapshot, events, kind, this.user, history),
      createdAt: this.clock.now(), preparedAt: this.clock.now(), status: 'pending',
      deliveredAt: null, attempts: 0, nextAttemptAt: this.clock.now(), runningAt: null, automatic: true, reason: null,
    });
  }

  private own(pr: PullRequest): boolean { return canonical(pr.snapshot.author) === canonical(this.user); }
  private save(pr: PullRequest): void { this.store.savePr({ ...pr, recordedAt: this.clock.now() }); }
  private currentRequest(snapshot: Snapshot): boolean {
    return snapshot.state === 'open' && snapshot.requestedReviewers.some(login => canonical(login) === canonical(this.user));
  }
  private eligibleRequest(pr: PullRequest, event: Event): boolean {
    return event.kind === 'review_requested' && this.actorType(event) !== 'self'
      && canonical(event.targetUser ?? '') === canonical(this.user) && this.currentRequest(pr.snapshot)
      && Date.parse(event.occurredAt) > Date.parse(this.reviewCutoff)
      && (!pr.reviewAlertAt || Date.parse(event.occurredAt) > Date.parse(pr.reviewAlertAt));
  }
  private actorType(event: Event): Activity['actorType'] {
    if (event.actor && canonical(event.actor.login) === canonical(this.user)) return 'self';
    return event.actor && (event.actor.bot || /\[bot\]$/i.test(event.actor.login)) ? 'bot' : 'human_other';
  }
  private requirePr(id: string): PullRequest {
    const pr = this.store.pr(id);
    if (!pr) throw new Error('Unknown pull request');
    return pr;
  }

  responsibility(pr: PullRequest): { queue: string; reviewers: Record<string, string> } {
    const snapshot = pr.snapshot;
    const requested = snapshot.state === 'open' ? snapshot.requestedReviewers.map(canonical) : [];
    const latest = new Map<string, Review>();
    for (const review of pr.reviews.filter(review => review.state !== 'pending' && review.submittedAt).sort((a, b) =>
      Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      latest.set(canonical(review.reviewer.login), review);
    }
    const reviewers: Record<string, string> = {};
    for (const [login, review] of latest) reviewers[login] = review.state;
    for (const login of requested) reviewers[login] = 'requested';
    return {
      queue: this.own(pr) ? 'my-prs' : snapshot.state === 'open'
        && (requested.includes(canonical(this.user)) || snapshot.requestedTeams.some(team => this.teams.includes(team)))
        ? 'needs-my-review' : 'review-requests',
      reviewers,
    };
  }
}
