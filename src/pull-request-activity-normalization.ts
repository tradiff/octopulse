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
    payloadJson: "{}",
    occurredAt: rawEvent.occurredAt,
  };
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
    case "converted_to_draft":
      return "converted_to_draft";
    case "workflow_run":
      // CI needs cross-run derivation in later slice.
      return undefined;
    default:
      return undefined;
  }
}

function mapReviewEventType(payload: Record<string, unknown>): string {
  const state = readOptionalString(payload.state)?.toUpperCase();

  if (state === "APPROVED") {
    return "review_approved";
  }

  if (state === "CHANGES_REQUESTED") {
    return "review_changes_requested";
  }

  return "review_submitted";
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
  return readOptionalActorType(payload.user) ?? readOptionalActorType(payload.actor);
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
