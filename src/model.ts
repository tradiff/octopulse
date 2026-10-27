import { z } from 'zod';

export const Instant = z.iso.datetime({ offset: true }).refine(
  value => Number.isFinite(Date.parse(value)), 'Invalid instant',
);
export const Login = z.string().trim().min(1);
export const Actor = z.strictObject({ login: Login, bot: z.boolean().default(false), avatar: z.url().optional() });
export const Review = z.strictObject({
  id: z.string().min(1),
  reviewer: Actor,
  state: z.enum(['approved', 'changes_requested', 'dismissed', 'commented', 'pending']),
  submittedAt: Instant.nullable(),
});
export const Snapshot = z.strictObject({
  id: z.string().min(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive(),
  title: z.string(),
  author: Login,
  state: z.enum(['open', 'closed', 'merged']).default('open'),
  draft: z.boolean().default(false),
  requestedReviewers: z.array(Login).default([]),
  requestedTeams: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).default([]),
  requestedActors: z.array(Actor).default([]),
  head: z.string().min(1).nullable().default(null),
  updatedAt: Instant.nullable().default(null),
  closedAt: Instant.nullable().default(null),
  mergedAt: Instant.nullable().default(null),
  authorAvatar: z.url().nullable().default(null),
  base: z.string().nullable().default(null),
  mergeStatus: z.string().nullable().default(null),
});
export const Event = z.strictObject({
  source: z.enum(['issue_comment', 'inline_comment', 'review', 'timeline', 'ci']),
  id: z.string().min(1),
  kind: z.enum([
    'comment', 'inline_comment', 'review', 'approval', 'changes_requested',
    'review_requested', 'close', 'merge', 'reopen', 'ready_for_review',
    'converted_to_draft', 'commit', 'ci_failure', 'ci_success',
  ]),
  occurredAt: Instant,
  updatedAt: Instant.optional(),
  actor: Actor.nullable().default(null),
  body: z.string().default(''),
  targetUser: Login.optional(),
  targetTeam: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  reviewId: z.string().min(1).optional(),
  threadRoot: z.string().min(1).optional(),
}).superRefine((event, context) => {
  if (event.kind === 'review_requested' && !event.targetUser && !event.targetTeam) {
    context.addIssue({ code: 'custom', message: 'Review request has no valid target' });
  }
  let expectedSource = 'timeline';
  if (event.kind === 'comment') expectedSource = 'issue_comment';
  else if (event.kind === 'inline_comment') expectedSource = 'inline_comment';
  else if (['review', 'approval', 'changes_requested'].includes(event.kind)) expectedSource = 'review';
  else if (event.kind.startsWith('ci_')) expectedSource = 'ci';
  if (event.source !== expectedSource) {
    context.addIssue({ code: 'custom', message: 'Activity kind does not match its source' });
  }
});
export const sourceNames = ['comments', 'reviews', 'inlineComments', 'timeline', 'workflows', 'jobs'] as const;
export const Sources = z.record(z.enum(sourceNames), z.enum(['complete', 'unchanged', 'incomplete']));
export const Job = z.strictObject({
  id: z.string().min(1), name: z.string(), runId: z.string().min(1),
  attempt: z.number().int().positive(), head: z.string().min(1),
  status: z.string().min(1), conclusion: z.string().nullable(),
});
export const Workflow = z.strictObject({
  id: z.string().min(1), workflowId: z.string().min(1).nullable(), trigger: z.string().min(1).nullable(),
  runNumber: z.number().int().positive().nullable(), attempt: z.number().int().positive().nullable(),
  head: z.string().min(1), name: z.string(), updatedAt: Instant,
  status: z.string().min(1), conclusion: z.string().nullable(),
  jobs: z.array(Job), jobsComplete: z.boolean(),
}).superRefine((run, context) => {
  if (run.jobs.some(job => job.runId !== run.id || job.attempt !== run.attempt || job.head !== run.head)) {
    context.addIssue({ code: 'custom', message: 'Job does not belong to its workflow run/attempt/head' });
  }
});
export const CiState = z.strictObject({
  runs: z.array(Workflow), selected: z.array(Workflow),
  unresolved: z.array(Workflow).default([]),
  outcome: z.enum(['failure', 'success']).nullable(), uncertain: z.boolean(), transition: z.number().int().nonnegative(),
});
export const FetchState = z.strictObject({
  pages: z.record(z.string(), z.strictObject({ validator: z.string().nullable(), items: z.array(z.unknown()), next: z.number().int().positive().nullable() })),
  progress: z.strictObject({ comments: Instant.nullable(), inlineComments: Instant.nullable() }),
});
export const Observation = z.strictObject({
  snapshot: Snapshot,
  sources: Sources,
  events: z.array(Event),
  reviews: z.array(Review).default([]),
  workflows: z.array(Workflow).optional(),
  fetchState: FetchState.optional(),
  rawIds: z.array(z.number().int().positive()).default([]),
});
export const Choice = z.strictObject({
  type: z.literal('Choice'),
  choice: z.enum(['notify', 'suppress']),
  probabilities: z.strictObject({ notify: z.number().min(0).max(1), suppress: z.number().min(0).max(1) }),
  confidence: z.number().min(0).max(1),
}).refine(value => Math.abs(value.probabilities.notify + value.probabilities.suppress - 1) <= 0.001,
  'Probabilities must sum to one');
export const Classification = z.union([
  Choice,
  z.strictObject({ type: z.literal('fallback'), reason: z.enum(['not_configured', 'provider_failure', 'invalid_answer']) }),
]);
export const PullRequest = z.strictObject({
  snapshot: Snapshot,
  tracked: z.boolean(),
  manualUntracked: z.boolean(),
  generation: z.number().int().positive(),
  baselineComplete: z.boolean(),
  completeSources: z.array(z.enum(sourceNames)),
  reviewAlertAt: Instant.nullable(),
  reviews: z.array(Review),
  origin: z.enum(['manual', 'discovery']).default('manual'),
  revision: z.number().int().nonnegative().default(0),
  recordedAt: Instant.nullable().default(null),
  graceUntil: Instant.nullable().default(null),
  ci: z.record(z.string(), CiState).default({}),
  fetchState: FetchState.default({ pages: {}, progress: { comments: null, inlineComments: null } }),
});
export const Activity = z.strictObject({
  event: Event,
  observedAt: Instant,
  actorType: z.enum(['self', 'human_other', 'bot']),
  decision: z.enum([
    'baseline', 'self', 'bot_non_owned', 'commit_timeline_only', 'review_request_ineligible',
    'superseded_request', 'redundant_wrapper', 'redundant_close', 'classified_suppress', 'non_owned_ci', 'eligible',
  ]),
  delivery: z.enum(['none', 'immediate', 'bundle']),
  classification: Classification.nullable(),
  visible: z.boolean(),
});
export const Intent = z.strictObject({
  prId: z.string(),
  kind: z.enum(['immediate', 'bundled', 'monitoring']),
  events: z.array(z.string()),
  title: z.string(),
  body: z.string(),
  destination: z.url(),
  expiryMs: z.union([z.literal(0), z.literal(10000)]),
  sound: z.enum(['approval', 'comment']).nullable(),
});
export const Notification = z.strictObject({
  intent: Intent,
  createdAt: Instant,
  preparedAt: Instant,
  status: z.enum(['pending', 'failed', 'sent']),
  deliveredAt: Instant.nullable(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: Instant.nullable(),
  runningAt: Instant.nullable(),
  automatic: z.boolean(),
  reason: z.enum(['transient', 'permanent', 'exhausted', 'expired', 'untracked', 'ambiguous']).nullable(),
});
export const Attempt = z.strictObject({
  startedAt: Instant,
  finishedAt: Instant.nullable(),
  result: z.enum(['running', 'sent', 'transient', 'permanent', 'ambiguous']),
});
export const Staged = z.strictObject({
  observation: Observation,
  generation: z.number().int(),
  observedAt: Instant,
  processed: z.boolean(),
});

export type Event = z.infer<typeof Event>;
export type Actor = z.infer<typeof Actor>;
export type Snapshot = z.infer<typeof Snapshot>;
export type PullRequest = z.infer<typeof PullRequest>;
export type Activity = z.infer<typeof Activity>;
export type Intent = z.infer<typeof Intent>;
export type Notification = z.infer<typeof Notification>;
export type Attempt = z.infer<typeof Attempt>;
export type Classification = z.infer<typeof Classification>;
export type Staged = z.infer<typeof Staged>;
export type Observation = z.infer<typeof Observation>;
export type Review = z.infer<typeof Review>;
export type Workflow = z.infer<typeof Workflow>;
export type Job = z.infer<typeof Job>;
export type CiState = z.infer<typeof CiState>;
export type FetchState = z.infer<typeof FetchState>;
export const canonical = (login: string): string => login.toLowerCase();
export const eventKey = (event: Event): string => `${event.source}:${event.id}`;
export function compareEvents(a: Event, b: Event): number {
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || (eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0);
}
export interface Clock { now(): string }
export interface Classifier { classify(body: string, signal: AbortSignal): Promise<unknown> }
export interface Desktop { submit(intent: Intent, signal: AbortSignal): Promise<'sent' | 'transient' | 'permanent'> }
