import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import type { PullRequestRecord } from "./pull-request-repository.js";
import {
  RawEventRepository,
  type InsertRawEventInput,
} from "./raw-event-repository.js";

const GITHUB_API_HEADERS = {
  "X-GitHub-Api-Version": "2022-11-28",
};
const GITHUB_PAGE_SIZE = 100;
const ISSUE_COMMENT_SOURCE = "github_issue_comment";
const PULL_REQUEST_REVIEW_SOURCE = "github_pull_request_review";
const PULL_REQUEST_REVIEW_COMMENT_SOURCE = "github_pull_request_review_comment";
const ISSUE_TIMELINE_SOURCE = "github_issue_timeline";
const ACTIONS_WORKFLOW_RUN_SOURCE = "github_actions_workflow_run";
const ACTIVITY_FETCH_CURSOR_KEY_PREFIX = "pull_request_activity_cursor";
const SUPPORTED_TIMELINE_EVENT_TYPES = new Set([
  "closed",
  "merged",
  "reopened",
  "ready_for_review",
  "convert_to_draft",
  "committed",
]);

type ActivityFetchCursorSource =
  | typeof ISSUE_COMMENT_SOURCE
  | typeof PULL_REQUEST_REVIEW_COMMENT_SOURCE;

export interface IngestPullRequestActivityOptions<TClient = Octokit> {
  rawEventRepository?: Pick<RawEventRepository, "insertRawEvent">;
  fetchIssueComments?: (
    client: TClient,
    pullRequest: PullRequestRecord,
    since?: string,
  ) => Promise<unknown[]>;
  fetchPullRequestReviews?: (
    client: TClient,
    pullRequest: PullRequestRecord,
  ) => Promise<unknown[]>;
  fetchPullRequestReviewComments?: (
    client: TClient,
    pullRequest: PullRequestRecord,
    since?: string,
  ) => Promise<unknown[]>;
  fetchPullRequestTimeline?: (
    client: TClient,
    pullRequest: PullRequestRecord,
  ) => Promise<unknown[]>;
  fetchWorkflowRuns?: (
    client: TClient,
    pullRequest: PullRequestRecord,
  ) => Promise<unknown[]>;
}

export interface IngestPullRequestActivityResult {
  processedCount: number;
  insertedCount: number;
  duplicateCount: number;
}

export class PullRequestActivityIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestActivityIngestionError";
  }
}

export async function ingestPullRequestActivity<TClient>(
  database: DatabaseSync,
  client: TClient,
  pullRequest: PullRequestRecord,
  options: IngestPullRequestActivityOptions<TClient> = {},
): Promise<IngestPullRequestActivityResult> {
  const rawEventRepository = options.rawEventRepository ?? new RawEventRepository(database);
  const issueCommentCursor = readActivityFetchCursor(
    database,
    pullRequest.id,
    ISSUE_COMMENT_SOURCE,
  );
  const pullRequestReviewCommentCursor = readActivityFetchCursor(
    database,
    pullRequest.id,
    PULL_REQUEST_REVIEW_COMMENT_SOURCE,
  );
  const fetchIssueComments =
    options.fetchIssueComments ??
    ((client: TClient, pullRequest: PullRequestRecord, since?: string) =>
      fetchIssueCommentsFromGitHub(
        client as unknown as Octokit,
        pullRequest,
        since,
      ) as Promise<unknown[]>);
  const fetchPullRequestReviews =
    options.fetchPullRequestReviews ??
    ((client: TClient, pullRequest: PullRequestRecord) =>
      fetchPullRequestReviewsFromGitHub(
        client as unknown as Octokit,
        pullRequest,
      ) as Promise<unknown[]>);
  const fetchPullRequestReviewComments =
    options.fetchPullRequestReviewComments ??
    ((client: TClient, pullRequest: PullRequestRecord, since?: string) =>
      fetchPullRequestReviewCommentsFromGitHub(
        client as unknown as Octokit,
        pullRequest,
        since,
      ) as Promise<unknown[]>);
  const fetchPullRequestTimeline =
    options.fetchPullRequestTimeline ??
    ((client: TClient, pullRequest: PullRequestRecord) =>
      fetchPullRequestTimelineFromGitHub(
        client as unknown as Octokit,
        pullRequest,
      ) as Promise<unknown[]>);
  const fetchWorkflowRuns =
    options.fetchWorkflowRuns ??
    ((client: TClient, pullRequest: PullRequestRecord) =>
      fetchWorkflowRunsFromGitHub(
        client as unknown as Octokit,
        pullRequest,
      ) as Promise<unknown[]>);
  const headSha = pullRequest.lastSeenHeadSha;
  const workflowRunsPromise =
    headSha === null
      ? Promise.resolve<unknown[]>([])
      : loadActivity("workflow runs", pullRequest, () => fetchWorkflowRuns(client, pullRequest));

  const [issueComments, reviews, reviewComments, timelineEvents, workflowRuns] = await Promise.all([
    loadActivity("issue comments", pullRequest, () =>
      fetchIssueComments(client, pullRequest, issueCommentCursor),
    ),
    loadActivity("pull request reviews", pullRequest, () => fetchPullRequestReviews(client, pullRequest)),
    loadActivity("pull request review comments", pullRequest, () =>
      fetchPullRequestReviewComments(client, pullRequest, pullRequestReviewCommentCursor),
    ),
    loadActivity("pull request timeline events", pullRequest, () =>
      fetchPullRequestTimeline(client, pullRequest),
    ),
    workflowRunsPromise,
  ]);
  const rawEvents = [
    ...issueComments.map((comment) => mapIssueCommentRawEvent(comment, pullRequest.id)),
    ...reviews.flatMap((review) => {
      const rawEvent = mapPullRequestReviewRawEvent(review, pullRequest.id);
      return rawEvent ? [rawEvent] : [];
    }),
    ...reviewComments.map((comment) => mapPullRequestReviewCommentRawEvent(comment, pullRequest.id)),
    ...timelineEvents.flatMap((event) => {
      const rawEvent = mapPullRequestTimelineRawEvent(event, pullRequest.id);
      return rawEvent ? [rawEvent] : [];
    }),
    ...(headSha === null
      ? []
      : workflowRuns.map((workflowRun) => mapWorkflowRunRawEvent(workflowRun, pullRequest.id, headSha))),
  ];

  let insertedCount = 0;
  let duplicateCount = 0;
  const nextIssueCommentCursor = pickLaterTimestamp(
    issueCommentCursor,
    readLatestActivityCursor(issueComments, "issue comment"),
  );
  const nextPullRequestReviewCommentCursor = pickLaterTimestamp(
    pullRequestReviewCommentCursor,
    readLatestActivityCursor(reviewComments, "pull request review comment"),
  );

  try {
    for (const rawEvent of rawEvents) {
      const result = rawEventRepository.insertRawEvent(rawEvent);

      if (result.outcome === "inserted") {
        insertedCount += 1;
      } else {
        duplicateCount += 1;
      }
    }

    if (nextIssueCommentCursor !== undefined && nextIssueCommentCursor !== issueCommentCursor) {
      writeActivityFetchCursor(
        database,
        pullRequest.id,
        ISSUE_COMMENT_SOURCE,
        nextIssueCommentCursor,
      );
    }

    if (
      nextPullRequestReviewCommentCursor !== undefined &&
      nextPullRequestReviewCommentCursor !== pullRequestReviewCommentCursor
    ) {
      writeActivityFetchCursor(
        database,
        pullRequest.id,
        PULL_REQUEST_REVIEW_COMMENT_SOURCE,
        nextPullRequestReviewCommentCursor,
      );
    }
  } catch (error) {
    if (error instanceof PullRequestActivityIngestionError) {
      throw error;
    }

    throw new PullRequestActivityIngestionError(
      `Failed to persist raw activity for ${formatPullRequestLabel(pullRequest)}: ${getErrorMessage(error)}`,
    );
  }

  return {
    processedCount: rawEvents.length,
    insertedCount,
    duplicateCount,
  };
}

async function fetchIssueCommentsFromGitHub(
  client: Octokit,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
  since?: string,
): Promise<unknown[]> {
  return fetchAllPagesFromGitHub(
    client,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner: pullRequest.repositoryOwner,
      repo: pullRequest.repositoryName,
      issue_number: pullRequest.number,
      ...(since === undefined ? {} : { since }),
    },
    "issue comments response",
  );
}

async function fetchPullRequestReviewsFromGitHub(
  client: Octokit,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): Promise<unknown[]> {
  return fetchAllPagesFromGitHub(
    client,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      owner: pullRequest.repositoryOwner,
      repo: pullRequest.repositoryName,
      pull_number: pullRequest.number,
    },
    "pull request reviews response",
  );
}

async function fetchPullRequestReviewCommentsFromGitHub(
  client: Octokit,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
  since?: string,
): Promise<unknown[]> {
  return fetchAllPagesFromGitHub(
    client,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    {
      owner: pullRequest.repositoryOwner,
      repo: pullRequest.repositoryName,
      pull_number: pullRequest.number,
      ...(since === undefined ? {} : { since }),
    },
    "pull request review comments response",
  );
}

async function fetchPullRequestTimelineFromGitHub(
  client: Octokit,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): Promise<unknown[]> {
  return fetchAllPagesFromGitHub(
    client,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
    {
      owner: pullRequest.repositoryOwner,
      repo: pullRequest.repositoryName,
      issue_number: pullRequest.number,
    },
    "pull request timeline response",
  );
}

async function fetchWorkflowRunsFromGitHub(
  client: Octokit,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "lastSeenHeadSha">,
): Promise<unknown[]> {
  const headSha = pullRequest.lastSeenHeadSha;

  if (headSha === null) {
    return [];
  }

  const items: unknown[] = [];

  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /repos/{owner}/{repo}/actions/runs", {
      owner: pullRequest.repositoryOwner,
      repo: pullRequest.repositoryName,
      head_sha: headSha,
      per_page: GITHUB_PAGE_SIZE,
      page,
      headers: GITHUB_API_HEADERS,
    });
    const pageItems = readWorkflowRunsResponse(response.data as unknown);
    items.push(...pageItems);

    if (pageItems.length < GITHUB_PAGE_SIZE) {
      return items;
    }
  }
}

async function fetchAllPagesFromGitHub(
  client: Octokit,
  route: string,
  parameters: Record<string, unknown>,
  responseFieldName: string,
): Promise<unknown[]> {
  const items: unknown[] = [];

  for (let page = 1; ; page += 1) {
    const response = await client.request(route, {
      ...parameters,
      per_page: GITHUB_PAGE_SIZE,
      page,
      headers: GITHUB_API_HEADERS,
    });
    const pageItems = readArray(response.data as unknown, responseFieldName);
    items.push(...pageItems);

    if (pageItems.length < GITHUB_PAGE_SIZE) {
      return items;
    }
  }
}

async function loadActivity(
  description: string,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
  loader: () => Promise<unknown[]>,
): Promise<unknown[]> {
  try {
    return await loader();
  } catch (error) {
    if (error instanceof PullRequestActivityIngestionError) {
      throw error;
    }

    throw new PullRequestActivityIngestionError(
      `Failed to fetch ${description} for ${formatPullRequestLabel(pullRequest)}: ${getErrorMessage(error)}`,
    );
  }
}

function mapIssueCommentRawEvent(data: unknown, pullRequestId: number): InsertRawEventInput {
  const value = requireRecord(data, "issue comment");

  return {
    pullRequestId,
    source: ISSUE_COMMENT_SOURCE,
    sourceId: readSourceId(value, "issue comment"),
    eventType: "issue_comment",
    actorLogin: readNullableLogin(value.user, "issue comment.user"),
    payloadJson: serializePayload(data, "issue comment"),
    occurredAt: readString(value.created_at, "issue comment.created_at"),
  };
}

function mapPullRequestReviewRawEvent(
  data: unknown,
  pullRequestId: number,
): InsertRawEventInput | undefined {
  const value = requireRecord(data, "pull request review");
  const state = readString(value.state, "pull request review.state");
  const submittedAt = value.submitted_at;

  if (state === "PENDING" || submittedAt === null) {
    return undefined;
  }

  return {
    pullRequestId,
    source: PULL_REQUEST_REVIEW_SOURCE,
    sourceId: readSourceId(value, "pull request review"),
    eventType: "pull_request_review",
    actorLogin: readNullableLogin(value.user, "pull request review.user"),
    payloadJson: serializePayload(data, "pull request review"),
    occurredAt: readString(submittedAt, "pull request review.submitted_at"),
  };
}

function mapPullRequestReviewCommentRawEvent(
  data: unknown,
  pullRequestId: number,
): InsertRawEventInput {
  const value = requireRecord(data, "pull request review comment");

  return {
    pullRequestId,
    source: PULL_REQUEST_REVIEW_COMMENT_SOURCE,
    sourceId: readSourceId(value, "pull request review comment"),
    eventType: "pull_request_review_comment",
    actorLogin: readNullableLogin(value.user, "pull request review comment.user"),
    payloadJson: serializePayload(data, "pull request review comment"),
    occurredAt: readString(value.created_at, "pull request review comment.created_at"),
  };
}

function mapPullRequestTimelineRawEvent(
  data: unknown,
  pullRequestId: number,
): InsertRawEventInput | undefined {
  const value = requireRecord(data, "pull request timeline event");
  const eventType = readString(value.event, "pull request timeline event.event");

  if (!SUPPORTED_TIMELINE_EVENT_TYPES.has(eventType)) {
    return undefined;
  }

  return {
    pullRequestId,
    source: ISSUE_TIMELINE_SOURCE,
    sourceId: readPullRequestTimelineSourceId(value, eventType),
    eventType,
    actorLogin: readPullRequestTimelineActorLogin(value, eventType),
    payloadJson: serializePayload(data, "pull request timeline event"),
    occurredAt: readPullRequestTimelineOccurredAt(value, eventType),
  };
}

function mapWorkflowRunRawEvent(
  data: unknown,
  pullRequestId: number,
  headSha: string,
): InsertRawEventInput {
  const value = requireRecord(data, "workflow run");
  const workflowRunHeadSha = readString(value.head_sha, "workflow run.head_sha");

  if (workflowRunHeadSha !== headSha) {
    throw new PullRequestActivityIngestionError(
      `workflow run.head_sha must match pull request head SHA ${headSha}`,
    );
  }

  const updatedAt = readString(value.updated_at, "workflow run.updated_at");

  return {
    pullRequestId,
    source: ACTIONS_WORKFLOW_RUN_SOURCE,
    sourceId: `${readSourceId(value, "workflow run")}:${updatedAt}`,
    eventType: "workflow_run",
    actorLogin: readNullableLogin(value.actor, "workflow run.actor"),
    payloadJson: serializePayload(data, "workflow run"),
    occurredAt: updatedAt,
  };
}

function readPullRequestTimelineSourceId(
  value: Record<string, unknown>,
  eventType: string,
): string {
  if (eventType === "committed") {
    const sha = readOptionalNonEmptyString(value.sha);

    if (sha !== null) {
      return sha;
    }
  }

  return readSourceId(value, "pull request timeline event");
}

function readPullRequestTimelineActorLogin(
  value: Record<string, unknown>,
  eventType: string,
): string | null {
  if (eventType === "committed") {
    return (
      readNullableLogin(value.committer, "pull request timeline event.committer") ??
      readNullableLogin(value.author, "pull request timeline event.author")
    );
  }

  return readNullableLogin(value.actor, "pull request timeline event.actor");
}

function readPullRequestTimelineOccurredAt(
  value: Record<string, unknown>,
  eventType: string,
): string {
  if (eventType !== "committed") {
    return readString(value.created_at, "pull request timeline event.created_at");
  }

  const occurredAt =
    readOptionalNonEmptyString(value.created_at) ??
    readOptionalNestedString(readOptionalRecord(value.commit)?.committer, "date") ??
    readOptionalNestedString(readOptionalRecord(value.commit)?.author, "date") ??
    readOptionalNestedString(value.committer, "date") ??
    readOptionalNestedString(value.author, "date");

  if (occurredAt !== null) {
    return occurredAt;
  }

  throw new PullRequestActivityIngestionError(
    "pull request timeline event.committed must include created_at or commit author/committer date",
  );
}

function readArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PullRequestActivityIngestionError(`${fieldName} must be an array`);
  }

  return value;
}

function readWorkflowRunsResponse(value: unknown): unknown[] {
  const response = requireRecord(value, "workflow runs response");
  return readArray(response.workflow_runs, "workflow runs response.workflow_runs");
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PullRequestActivityIngestionError(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readSourceId(value: Record<string, unknown>, fieldName: string): string {
  const id = value.id;

  if (typeof id === "string" && id.length > 0) {
    return id;
  }

  if (typeof id === "number" && Number.isSafeInteger(id)) {
    return String(id);
  }

  if (typeof id === "bigint") {
    const numericValue = Number(id);

    if (Number.isSafeInteger(numericValue)) {
      return String(numericValue);
    }
  }

  const nodeId = value.node_id;

  if (typeof nodeId === "string" && nodeId.length > 0) {
    return nodeId;
  }

  throw new PullRequestActivityIngestionError(`${fieldName} must include id or node_id`);
}

function readNullableLogin(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const record = requireRecord(value, fieldName);
  const login = record.login;

  if (login === null || login === undefined) {
    return null;
  }

  return readString(login, `${fieldName}.login`);
}

function readOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalNestedString(value: unknown, fieldName: string): string | null {
  const record = readOptionalRecord(value);

  if (record === null) {
    return null;
  }

  return readOptionalNonEmptyString(record[fieldName]);
}

function readActivityFetchCursor(
  database: DatabaseSync,
  pullRequestId: number,
  source: ActivityFetchCursorSource,
): string | undefined {
  const row = database
    .prepare("SELECT value FROM AppState WHERE key = ?")
    .get(buildActivityFetchCursorKey(pullRequestId, source));

  if (row === undefined) {
    return undefined;
  }

  const value = requireRecord(row, "AppState row").value;
  return readString(value, "AppState.value");
}

function writeActivityFetchCursor(
  database: DatabaseSync,
  pullRequestId: number,
  source: ActivityFetchCursorSource,
  cursor: string | undefined,
): void {
  if (cursor === undefined) {
    return;
  }

  database
    .prepare(
      `
        INSERT INTO AppState (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(buildActivityFetchCursorKey(pullRequestId, source), cursor);
}

function buildActivityFetchCursorKey(
  pullRequestId: number,
  source: ActivityFetchCursorSource,
): string {
  return `${ACTIVITY_FETCH_CURSOR_KEY_PREFIX}:${pullRequestId}:${source}`;
}

function readLatestActivityCursor(items: unknown[], fieldName: string): string | undefined {
  let latestCursor: string | undefined;

  for (const item of items) {
    const value = requireRecord(item, fieldName);
    const updatedAt = value.updated_at;
    const cursor =
      updatedAt === undefined || updatedAt === null
        ? readString(value.created_at, `${fieldName}.created_at`)
        : readString(updatedAt, `${fieldName}.updated_at`);

    latestCursor = pickLaterTimestamp(latestCursor, cursor);
  }

  return latestCursor;
}

function pickLaterTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return left >= right ? left : right;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new PullRequestActivityIngestionError(`${fieldName} must be a string`);
  }

  return value;
}

function serializePayload(value: unknown, fieldName: string): string {
  try {
    const payloadJson = JSON.stringify(value);

    if (payloadJson === undefined) {
      throw new PullRequestActivityIngestionError(`${fieldName} could not be serialized to JSON`);
    }

    return payloadJson;
  } catch (error) {
    if (error instanceof PullRequestActivityIngestionError) {
      throw error;
    }

    throw new PullRequestActivityIngestionError(
      `Failed to serialize ${fieldName}: ${getErrorMessage(error)}`,
    );
  }
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.number}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
