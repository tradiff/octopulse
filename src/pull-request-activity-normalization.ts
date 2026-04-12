import { DatabaseSync } from "node:sqlite";

import {
  NormalizedEventRepository,
  type ActorClass,
  type DecisionState,
  type InsertNormalizedEventInput,
  type NotificationTiming,
  type NormalizedEventRecord,
} from "./normalized-event-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import { RawEventRepository, type RawEventRecord } from "./raw-event-repository.js";

export interface NormalizePullRequestActivityOptions {
  rawEventRepository?: Pick<
    RawEventRepository,
    "listUnnormalizedRawEventsForPullRequest" | "listRawEventsForPullRequest"
  >;
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "insertNormalizedEvent" | "listNormalizedEventsForPullRequest"
  >;
}

export interface NormalizePullRequestActivityResult {
  processedCount: number;
  normalizedCount: number;
  skippedCount: number;
}

export interface ActorClassificationInput {
  currentUserLogin: string;
  actorLogin: string | null;
  actorType?: string | null;
}

export class PullRequestActivityNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestActivityNormalizationError";
  }
}

type CiOutcomeEventType = "ci_failed" | "ci_succeeded";

interface WorkflowRunSnapshot {
  workflowRunId: number | string;
  headSha: string;
  status: string;
  conclusion: string | null;
  actorType: string | null;
  actorAvatarUrl: string | null;
  name: string | null;
  url: string | null;
}

interface DerivedCiOutcomeEvent extends InsertNormalizedEventInput {
  rawEventId: number;
  eventType: CiOutcomeEventType;
}

interface WorkflowRunHistoryEntry {
  rawEvent: RawEventRecord;
  snapshot: WorkflowRunSnapshot;
}

export function normalizePullRequestActivity(
  database: DatabaseSync,
  pullRequest: Pick<PullRequestRecord, "id" | "lastSeenHeadSha">,
  currentUserLogin: string,
  options: NormalizePullRequestActivityOptions = {},
): NormalizePullRequestActivityResult {
  const rawEventRepository = options.rawEventRepository ?? new RawEventRepository(database);
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);
  const rawEvents = rawEventRepository.listUnnormalizedRawEventsForPullRequest(pullRequest.id);
  let normalizedCount = 0;
  let skippedCount = 0;

  try {
    const workflowRawEventIds = new Set<number>();

    for (const rawEvent of rawEvents) {
      if (rawEvent.eventType === "workflow_run") {
        workflowRawEventIds.add(rawEvent.id);
        continue;
      }

      const normalizedEvent = normalizeRawEvent(rawEvent, currentUserLogin);

      if (normalizedEvent === undefined) {
        skippedCount += 1;
        continue;
      }

      normalizedEventRepository.insertNormalizedEvent(normalizedEvent);
      normalizedCount += 1;
    }

    if (workflowRawEventIds.size > 0) {
      let normalizedWorkflowCount = 0;

      for (const ciOutcomeEvent of deriveMissingCiOutcomeEvents({
        pullRequest,
        currentUserLogin,
        rawEvents: rawEventRepository.listRawEventsForPullRequest(pullRequest.id),
        normalizedEvents: normalizedEventRepository.listNormalizedEventsForPullRequest(
          pullRequest.id,
        ),
      })) {
        normalizedEventRepository.insertNormalizedEvent(ciOutcomeEvent);
        normalizedCount += 1;

        if (workflowRawEventIds.has(ciOutcomeEvent.rawEventId)) {
          normalizedWorkflowCount += 1;
        }
      }

      skippedCount += workflowRawEventIds.size - normalizedWorkflowCount;
    }
  } catch (error) {
    if (error instanceof PullRequestActivityNormalizationError) {
      throw error;
    }

    throw new PullRequestActivityNormalizationError(
      `Failed to normalize raw activity for pull request ${pullRequest.id}: ${getErrorMessage(error)}`,
    );
  }

  return {
    processedCount: rawEvents.length,
    normalizedCount,
    skippedCount,
  };
}

export function classifyActor(input: ActorClassificationInput): ActorClass {
  const currentUserLogin = normalizeLogin(input.currentUserLogin);
  const actorLogin = input.actorLogin === null ? null : normalizeLogin(input.actorLogin);

  if (actorLogin !== null && actorLogin === currentUserLogin) {
    return "self";
  }

  if (normalizeActorType(input.actorType) === "bot") {
    return "bot";
  }

  if (actorLogin !== null && actorLogin.endsWith("[bot]")) {
    return "bot";
  }

  return "human_other";
}

function normalizeRawEvent(
  rawEvent: RawEventRecord,
  currentUserLogin: string,
): InsertNormalizedEventInput | undefined {
  const payload = parseRawPayload(rawEvent);
  const eventType = mapNormalizedEventType(rawEvent, payload);

  if (eventType === undefined) {
    return undefined;
  }

  const actorClass = classifyActor({
    currentUserLogin,
    actorLogin: rawEvent.actorLogin,
    actorType: readActorType(payload),
  });

  return {
    rawEventId: rawEvent.id,
    pullRequestId: rawEvent.pullRequestId,
    eventType,
    actorLogin: rawEvent.actorLogin,
    actorClass,
    decisionState: resolveDecisionState(eventType, actorClass),
    notificationTiming: resolveNotificationTiming(eventType, actorClass),
    payloadJson: serializeNormalizedPayload(rawEvent, buildNormalizedPayload(rawEvent, payload)),
    occurredAt: rawEvent.occurredAt,
  };
}

function buildNormalizedPayload(
  rawEvent: RawEventRecord,
  payload: Record<string, unknown>,
): Record<string, number | string | null> | undefined {
  const actorAvatarUrl = readActorAvatarUrl(rawEvent, payload);

  switch (rawEvent.eventType) {
    case "issue_comment":
      return {
        ...(actorAvatarUrl === null ? {} : { actorAvatarUrl }),
        commentId: readOptionalInteger(payload.id),
        bodyText: readOptionalString(payload.body),
        url: readOptionalString(payload.html_url),
      };
    case "pull_request_review":
      return {
        ...(actorAvatarUrl === null ? {} : { actorAvatarUrl }),
        reviewId: readOptionalInteger(payload.id),
        reviewState: normalizeReviewState(readOptionalString(payload.state)),
        bodyText: readOptionalString(payload.body),
        url: readOptionalString(payload.html_url),
      };
    case "pull_request_review_comment":
      return {
        ...(actorAvatarUrl === null ? {} : { actorAvatarUrl }),
        commentId: readOptionalInteger(payload.id),
        reviewId: readOptionalInteger(payload.pull_request_review_id),
        inReplyToCommentId: readOptionalInteger(payload.in_reply_to_id),
        bodyText: readOptionalString(payload.body),
        path: readOptionalString(payload.path),
        url: readOptionalString(payload.html_url),
      };
    case "committed":
      return {
        ...(actorAvatarUrl === null ? {} : { actorAvatarUrl }),
        commitSha: readOptionalString(payload.sha),
        messageHeadline: readCommitMessageHeadline(payload),
        url: readOptionalString(payload.html_url),
      };
    default:
      return actorAvatarUrl === null ? undefined : { actorAvatarUrl };
  }
}

function mapNormalizedEventType(
  rawEvent: RawEventRecord,
  payload: Record<string, unknown>,
): string | undefined {
  switch (rawEvent.eventType) {
    case "issue_comment":
      return "issue_comment";
    case "pull_request_review_comment":
      return "review_inline_comment";
    case "pull_request_review":
      return mapReviewEventType(payload);
    case "closed":
      return "pr_closed";
    case "merged":
      return "pr_merged";
    case "reopened":
      return "pr_reopened";
    case "ready_for_review":
      return "ready_for_review";
    case "convert_to_draft":
    case "converted_to_draft":
      return "converted_to_draft";
    case "committed":
      return "commit_pushed";
    case "workflow_run":
      // CI outcomes derive from workflow history, not single raw events.
      return undefined;
    default:
      return undefined;
  }
}

function mapReviewEventType(payload: Record<string, unknown>): string {
  const state = normalizeReviewState(readOptionalString(payload.state));

  if (state === "APPROVED") {
    return "review_approved";
  }

  if (state === "CHANGES_REQUESTED") {
    return "review_changes_requested";
  }

  return "review_submitted";
}

function deriveMissingCiOutcomeEvents(input: {
  pullRequest: Pick<PullRequestRecord, "id" | "lastSeenHeadSha">;
  currentUserLogin: string;
  rawEvents: RawEventRecord[];
  normalizedEvents: NormalizedEventRecord[];
}): DerivedCiOutcomeEvent[] {
  const headSha = normalizeHeadSha(input.pullRequest.lastSeenHeadSha);

  if (headSha === null) {
    return [];
  }

  const existingCiOutcomeRawEventIds = new Set(
    input.normalizedEvents.flatMap((event) =>
      isCiOutcomeEventType(event.eventType) && event.rawEventId !== null ? [event.rawEventId] : [],
    ),
  );
  const workflowHistory = input.rawEvents.flatMap((rawEvent) => {
    if (rawEvent.eventType !== "workflow_run") {
      return [];
    }

    const snapshot = parseWorkflowRunSnapshot(rawEvent);

    return snapshot.headSha === headSha ? [{ rawEvent, snapshot }] : [];
  });
  const workflowRunSnapshots = new Map<string, WorkflowRunSnapshot>();
  const derivedEvents: DerivedCiOutcomeEvent[] = [];
  let previousOutcome: CiOutcomeEventType | undefined;

  for (const [index, workflowRun] of workflowHistory.entries()) {
    workflowRunSnapshots.set(String(workflowRun.snapshot.workflowRunId), workflowRun.snapshot);

    const nextOutcome = resolveCiOutcomeEventType(workflowRunSnapshots);

    if (nextOutcome === previousOutcome) {
      continue;
    }

    if (
      nextOutcome === "ci_succeeded" &&
      shouldDelayInitialCiSuccess({
        workflowHistory,
        currentIndex: index,
        observedWorkflowRunIds: workflowRunSnapshots,
        previousOutcome,
      })
    ) {
      continue;
    }

    previousOutcome = nextOutcome;

    if (nextOutcome === undefined || existingCiOutcomeRawEventIds.has(workflowRun.rawEvent.id)) {
      continue;
    }

    const actorClass = classifyActor({
      currentUserLogin: input.currentUserLogin,
      actorLogin: workflowRun.rawEvent.actorLogin,
      actorType: workflowRun.snapshot.actorType,
    });

    derivedEvents.push({
      rawEventId: workflowRun.rawEvent.id,
      pullRequestId: workflowRun.rawEvent.pullRequestId,
      eventType: nextOutcome,
      actorLogin: workflowRun.rawEvent.actorLogin,
      actorClass,
      decisionState: resolveDecisionState(nextOutcome, actorClass),
      notificationTiming: resolveNotificationTiming(nextOutcome, actorClass),
      payloadJson: serializeNormalizedPayload(
        workflowRun.rawEvent,
        buildCiOutcomePayload(workflowRun.snapshot),
      ),
      occurredAt: workflowRun.rawEvent.occurredAt,
    });
  }

  return derivedEvents;
}

function parseWorkflowRunSnapshot(rawEvent: RawEventRecord): WorkflowRunSnapshot {
  const payload = parseRawPayload(rawEvent);

  return {
    workflowRunId: readWorkflowRunId(payload, rawEvent),
    headSha: readRequiredNormalizedString(payload.head_sha, rawEvent, "workflow run.head_sha"),
    status: readRequiredNormalizedString(payload.status, rawEvent, "workflow run.status"),
    conclusion: readOptionalNormalizedString(payload.conclusion),
    actorType: readActorType(payload),
    actorAvatarUrl: readActorAvatarUrl(rawEvent, payload),
    name: readOptionalString(payload.name),
    url: readOptionalString(payload.html_url),
  };
}

function readActorAvatarUrl(
  rawEvent: RawEventRecord,
  payload: Record<string, unknown>,
): string | null {
  switch (rawEvent.eventType) {
    case "issue_comment":
    case "pull_request_review":
    case "pull_request_review_comment":
      return readAvatarUrlFromActorRecord(readOptionalRecord(payload.user));
    case "workflow_run":
      return readAvatarUrlFromActorRecord(readOptionalRecord(payload.actor));
    case "committed":
      return (
        readAvatarUrlFromActorRecord(readOptionalRecord(payload.committer)) ??
        readAvatarUrlFromActorRecord(readOptionalRecord(payload.author))
      );
    default:
      return readAvatarUrlFromActorRecord(readOptionalRecord(payload.actor));
  }
}

function readAvatarUrlFromActorRecord(actor: Record<string, unknown> | null): string | null {
  if (actor === null) {
    return null;
  }

  return readOptionalString(actor.avatar_url);
}

function buildCiOutcomePayload(
  workflowRun: WorkflowRunSnapshot,
): Record<string, number | string | null> {
  return {
    ...(workflowRun.actorAvatarUrl === null ? {} : { actorAvatarUrl: workflowRun.actorAvatarUrl }),
    headSha: workflowRun.headSha,
    workflowRunId: workflowRun.workflowRunId,
    workflowName: workflowRun.name,
    workflowRunStatus: workflowRun.status,
    workflowRunConclusion: workflowRun.conclusion,
    url: workflowRun.url,
  };
}

function resolveCiOutcomeEventType(
  workflowRuns: ReadonlyMap<string, WorkflowRunSnapshot>,
): CiOutcomeEventType | undefined {
  if (workflowRuns.size === 0) {
    return undefined;
  }

  let allSucceeded = true;

  for (const workflowRun of workflowRuns.values()) {
    if (workflowRun.conclusion === "failure") {
      return "ci_failed";
    }

    if (workflowRun.status !== "completed" || workflowRun.conclusion !== "success") {
      allSucceeded = false;
    }
  }

  return allSucceeded ? "ci_succeeded" : undefined;
}

function isCiOutcomeEventType(eventType: string): eventType is CiOutcomeEventType {
  return eventType === "ci_failed" || eventType === "ci_succeeded";
}

function resolveDecisionState(eventType: string, actorClass: ActorClass): DecisionState {
  if (actorClass === "self" && !isCiOutcomeEventType(eventType)) {
    return "suppressed_self_action";
  }

  return "notified";
}

function resolveNotificationTiming(
  eventType: string,
  actorClass: ActorClass,
): NotificationTiming | null {
  if (
    actorClass === "human_other" &&
    (eventType === "review_approved" || eventType === "review_changes_requested")
  ) {
    return "immediate";
  }

  return null;
}

function shouldDelayInitialCiSuccess(input: {
  workflowHistory: readonly WorkflowRunHistoryEntry[];
  currentIndex: number;
  observedWorkflowRunIds: ReadonlyMap<string, WorkflowRunSnapshot>;
  previousOutcome: CiOutcomeEventType | undefined;
}): boolean {
  if (input.previousOutcome !== undefined) {
    return false;
  }

  for (const laterWorkflowRun of input.workflowHistory.slice(input.currentIndex + 1)) {
    if (!input.observedWorkflowRunIds.has(String(laterWorkflowRun.snapshot.workflowRunId))) {
      return true;
    }
  }

  return false;
}

function serializeNormalizedPayload(
  rawEvent: Pick<RawEventRecord, "id">,
  payload: Record<string, number | string | null> | undefined,
): string {
  if (payload === undefined) {
    return "{}";
  }

  try {
    const payloadJson = JSON.stringify(payload);

    if (payloadJson === undefined) {
      throw new Error("Normalized payload must be serializable JSON");
    }

    return payloadJson;
  } catch (error) {
    throw new PullRequestActivityNormalizationError(
      `Failed to serialize normalized payload for raw event ${rawEvent.id}: ${getErrorMessage(error)}`,
    );
  }
}

function parseRawPayload(rawEvent: RawEventRecord): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawEvent.payloadJson) as unknown;
  } catch (error) {
    throw new PullRequestActivityNormalizationError(
      `Raw event ${rawEvent.id} payload must be valid JSON: ${getErrorMessage(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PullRequestActivityNormalizationError(`Raw event ${rawEvent.id} payload must be an object`);
  }

  return parsed as Record<string, unknown>;
}

function readActorType(payload: Record<string, unknown>): string | null {
  return (
    readOptionalActorType(payload.user) ??
    readOptionalActorType(payload.actor) ??
    readOptionalActorType(payload.committer) ??
    readOptionalActorType(payload.author)
  );
}

function readOptionalActorType(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return readOptionalString((value as Record<string, unknown>).type);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readRequiredNormalizedString(
  value: unknown,
  rawEvent: Pick<RawEventRecord, "id">,
  fieldName: string,
): string {
  const normalizedValue = readOptionalNormalizedString(value);

  if (normalizedValue !== null) {
    return normalizedValue;
  }

  throw new PullRequestActivityNormalizationError(
    `Raw event ${rawEvent.id} ${fieldName} must be a non-empty string`,
  );
}

function readOptionalNormalizedString(value: unknown): string | null {
  const stringValue = readOptionalString(value)?.trim().toLowerCase();
  return stringValue && stringValue.length > 0 ? stringValue : null;
}

function readOptionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readWorkflowRunId(
  payload: Record<string, unknown>,
  rawEvent: Pick<RawEventRecord, "id">,
): number | string {
  const numericId = readOptionalInteger(payload.id);

  if (numericId !== null) {
    return numericId;
  }

  const stringId = readOptionalString(payload.id)?.trim();

  if (stringId && stringId.length > 0) {
    return stringId;
  }

  const nodeId = readOptionalString(payload.node_id)?.trim();

  if (nodeId && nodeId.length > 0) {
    return nodeId;
  }

  throw new PullRequestActivityNormalizationError(
    `Raw event ${rawEvent.id} workflow run payload must include id or node_id`,
  );
}

function readCommitMessageHeadline(payload: Record<string, unknown>): string | null {
  const message = readOptionalString(payload.message) ?? readOptionalString(readOptionalRecord(payload.commit)?.message);

  if (message === null) {
    return null;
  }

  const headline = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return headline.length > 0 ? headline : null;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeReviewState(state: string | null): string | null {
  if (state === null) {
    return null;
  }

  const normalizedState = state.trim().toUpperCase();

  return normalizedState.length > 0 ? normalizedState : null;
}

function normalizeActorType(actorType: string | null | undefined): string | null {
  return typeof actorType === "string" && actorType.trim().length > 0
    ? actorType.trim().toLowerCase()
    : null;
}

function normalizeHeadSha(headSha: string | null | undefined): string | null {
  return typeof headSha === "string" && headSha.trim().length > 0
    ? headSha.trim().toLowerCase()
    : null;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
