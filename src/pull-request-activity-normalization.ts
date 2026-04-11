import { DatabaseSync } from "node:sqlite";

import {
  NormalizedEventRepository,
  type ActorClass,
  type InsertNormalizedEventInput,
} from "./normalized-event-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import { RawEventRepository, type RawEventRecord } from "./raw-event-repository.js";

export interface NormalizePullRequestActivityOptions {
  rawEventRepository?: Pick<RawEventRepository, "listUnnormalizedRawEventsForPullRequest">;
  normalizedEventRepository?: Pick<NormalizedEventRepository, "insertNormalizedEvent">;
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

export function normalizePullRequestActivity(
  database: DatabaseSync,
  pullRequest: Pick<PullRequestRecord, "id">,
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
    for (const rawEvent of rawEvents) {
      const normalizedEvent = normalizeRawEvent(rawEvent, currentUserLogin);

      if (normalizedEvent === undefined) {
        skippedCount += 1;
        continue;
      }

      normalizedEventRepository.insertNormalizedEvent(normalizedEvent);
      normalizedCount += 1;
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

  return {
    rawEventId: rawEvent.id,
    pullRequestId: rawEvent.pullRequestId,
    eventType,
    actorLogin: rawEvent.actorLogin,
    actorClass: classifyActor({
      currentUserLogin,
      actorLogin: rawEvent.actorLogin,
      actorType: readActorType(payload),
    }),
    payloadJson: serializeNormalizedPayload(rawEvent, buildNormalizedPayload(rawEvent, payload)),
    occurredAt: rawEvent.occurredAt,
  };
}

function buildNormalizedPayload(
  rawEvent: RawEventRecord,
  payload: Record<string, unknown>,
): Record<string, number | string | null> | undefined {
  switch (rawEvent.eventType) {
    case "issue_comment":
      return {
        commentId: readOptionalInteger(payload.id),
        bodyText: readOptionalString(payload.body),
        url: readOptionalString(payload.html_url),
      };
    case "pull_request_review":
      return {
        reviewId: readOptionalInteger(payload.id),
        reviewState: normalizeReviewState(readOptionalString(payload.state)),
        bodyText: readOptionalString(payload.body),
        url: readOptionalString(payload.html_url),
      };
    case "pull_request_review_comment":
      return {
        commentId: readOptionalInteger(payload.id),
        reviewId: readOptionalInteger(payload.pull_request_review_id),
        inReplyToCommentId: readOptionalInteger(payload.in_reply_to_id),
        bodyText: readOptionalString(payload.body),
        path: readOptionalString(payload.path),
        url: readOptionalString(payload.html_url),
      };
    case "committed":
      return {
        commitSha: readOptionalString(payload.sha),
        messageHeadline: readCommitMessageHeadline(payload),
        url: readOptionalString(payload.html_url),
      };
    default:
      return undefined;
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
      // CI needs cross-run derivation in later slice.
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

function readOptionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
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

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
