import { z } from 'zod';
import { Event, Job, Observation, Review, Snapshot, Workflow } from './model.js';
import type { Clock, FetchState, PullRequest } from './model.js';
import { Store } from './store.js';

const Page = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal(200), items: z.array(z.unknown()), next: z.number().int().positive().nullable(), validator: z.string().nullable(), rawIds: z.array(z.number().int().positive()).optional(), total: z.number().int().nonnegative().optional() }),
  z.strictObject({ status: z.literal(304) }),
]);
const SubmittedReview = z.strictObject({ review: Review.nullable(), event: Event.nullable() });
export interface PageRequest {
  resource: 'detail' | 'comments' | 'inlineComments' | 'reviews' | 'timeline' | 'workflows' | 'jobs';
  page: number;
  validator: string | null;
  since: string | null;
  head: string | null;
  runId: string | null;
  attempt: number | null;
}
export interface PageClient { request(pr: Snapshot, request: PageRequest, signal: AbortSignal): Promise<unknown> }

export class Collector {
  constructor(private readonly store: Store, private readonly clock: Clock, private readonly client: PageClient) {}

  async collect(pr: PullRequest, signal: AbortSignal): Promise<Observation> {
    const fetchState: FetchState = { pages: { ...pr.fetchState.pages }, progress: { ...pr.fetchState.progress } };
    let lastResponse: unknown = null;
    let snapshot = pr.snapshot;
    const observation: Observation = {
      snapshot, events: [], reviews: [], workflows: [], fetchState, rawIds: [],
      sources: { comments: 'incomplete', inlineComments: 'incomplete', reviews: 'incomplete', timeline: 'incomplete', workflows: 'incomplete', jobs: 'incomplete' },
    };
    const group = async (
      resource: PageRequest['resource'],
      options: { head?: string; runId?: string; attempt?: number; version?: string; reuse?: boolean } = {},
      consume?: (items: unknown[]) => void,
    ) => {
      const since = resource === 'comments' || resource === 'inlineComments' ? pr.fetchState.progress[resource] : null;
      const prefix = JSON.stringify([resource, options.head ?? null, options.runId ?? null, options.attempt ?? null, options.version ?? null, since]);
      const items: unknown[] = [];
      const visited = new Set<number>();
      let pageNumber: number | null = 1;
      let changed = false;
      let expected = 0;
      let count = 0;
      while (pageNumber !== null) {
        signal.throwIfAborted();
        if (visited.has(pageNumber)) throw new Error('Pagination cycle');
        visited.add(pageNumber);
        const key: string = `${prefix}:${pageNumber}`;
        let cached: FetchState['pages'][string] | undefined = pr.fetchState.pages[key];
        if (resource === 'detail' && cached) {
          const detail = Snapshot.safeParse(cached.items[0]);
          if (!detail.success || JSON.stringify(detail.data) !== JSON.stringify(pr.snapshot)) cached = undefined;
        }
        let data: FetchState['pages'][string] | undefined = cached;
        if (!options.reuse || !cached) {
          const raw = await this.client.request(snapshot, {
            resource, page: pageNumber, validator: cached?.validator ?? null,
            since,
            head: options.head ?? null, runId: options.runId ?? null, attempt: options.attempt ?? null,
          }, signal);
          lastResponse = raw;
          const response = Page.parse(raw);
          if (response.status === 200) {
            expected = Math.max(expected, response.total ?? 0);
            observation.rawIds.push(...response.rawIds ?? []);
            changed = true;
            data = { validator: response.validator, items: response.items, next: response.next };
          } else if (!cached) throw new Error('Unchanged page without a complete cache');
        }
        if (!data) throw new Error('Missing page');
        fetchState.pages[key] = data;
        count += data.items.length;
        if (consume) consume(data.items);
        else items.push(...data.items);
        pageNumber = data.next;
      }
      if (count < expected) throw new Error('Incomplete paginated collection');
      return { items, changed };
    };
    try {
      const detail = await group('detail');
      if (detail.items.length !== 1) throw new Error('Expected one pull request detail');
      snapshot = Snapshot.parse(detail.items[0]);
      if (snapshot.id !== pr.snapshot.id || snapshot.number !== pr.snapshot.number) throw new Error('Mismatched pull request detail');
      observation.snapshot = snapshot;
      if (detail.changed || !pr.baselineComplete) {
        for (const source of ['comments', 'inlineComments', 'timeline'] as const) {
          const expectedSource = source === 'comments' ? 'issue_comment' : source === 'inlineComments' ? 'inline_comment' : 'timeline';
          await group(source, {}, items => {
            for (const item of items) {
              const event = Event.parse(item);
              if (event.source !== expectedSource) throw new Error('Activity returned by the wrong source');
              observation.events.push(event);
              if (source !== 'timeline') {
                const updated = event.updatedAt ?? event.occurredAt;
                const prior = fetchState.progress[source];
                if (!prior || Date.parse(updated) > Date.parse(prior)) fetchState.progress[source] = updated;
              }
            }
          });
          observation.sources[source] = 'complete';
        }
        await group('reviews', {}, items => {
          for (const item of items) {
            const value = SubmittedReview.parse(item);
            if (value.review && (value.review.state === 'pending' || !value.review.submittedAt)) continue;
            if (value.event && value.event.source !== 'review') throw new Error('Review returned the wrong activity source');
            if (value.review) observation.reviews.push(value.review);
            if (value.event) observation.events.push(value.event);
          }
        });
        observation.sources.reviews = 'complete';
      } else {
        for (const source of ['comments', 'inlineComments', 'timeline', 'reviews'] as const) observation.sources[source] = 'unchanged';
      }
      if (snapshot.head) {
        const items: unknown[] = [];
        let unchanged = false;
        try {
          const workflows = await group('workflows', { head: snapshot.head }, page => items.push(...page));
          unchanged = !workflows.changed && pr.baselineComplete && snapshot.head === pr.snapshot.head
            && pr.completeSources.includes('workflows') && pr.completeSources.includes('jobs');
        } finally {
          if (!unchanged) for (const item of items) {
            const run = Workflow.parse({ ...z.record(z.string(), z.unknown()).parse(item), jobs: [], jobsComplete: false });
            if (run.head !== snapshot.head) throw new Error('Workflow returned for a different head');
            observation.workflows!.push(run);
          }
        }
        if (unchanged) {
          observation.sources.workflows = 'unchanged';
          observation.sources.jobs = 'unchanged';
        } else {
          for (const run of observation.workflows!) {
            if (run.attempt !== null) {
              await group('jobs', { head: snapshot.head, runId: run.id, attempt: run.attempt, version: run.updatedAt, reuse: true }, items => {
                const partial = Workflow.parse({ ...run, jobs: items.map(job => Job.parse(job)) });
                run.jobs.push(...partial.jobs);
              });
            }
            run.jobsComplete = true;
          }
          observation.sources.workflows = 'complete';
          observation.sources.jobs = 'complete';
        }
      } else {
        const state = pr.baselineComplete && snapshot.head === pr.snapshot.head ? 'unchanged' : 'complete';
        observation.sources.workflows = state;
        observation.sources.jobs = state;
      }
      if (Object.values(observation.sources).every(state => state === 'unchanged')) delete observation.fetchState;
      return observation;
    } catch (error) {
      this.store.failedInput(pr.snapshot.id, 'incomplete-collection', { pages: fetchState.pages, lastResponse }, this.clock.now());
      this.store.stage(pr.snapshot.id, { observation, generation: pr.generation, observedAt: this.clock.now(), processed: false });
      throw error;
    }
  }
}
