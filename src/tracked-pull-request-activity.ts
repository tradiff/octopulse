import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import {
  classifyBotPullRequestActivity,
  type BotActivityClassifier,
} from "./bot-activity-classification.js";
import { bundlePullRequestEvents } from "./event-bundling.js";
import { getLogger } from "./logger.js";
import {
  dispatchPullRequestNotifications,
  type NotificationDispatcher,
} from "./notification-dispatch.js";
import { preparePullRequestNotifications } from "./notification-preparation.js";
import {
  ingestPullRequestActivity,
  type IngestPullRequestActivityOptions,
} from "./pull-request-activity-ingestion.js";
import { normalizePullRequestActivity } from "./pull-request-activity-normalization.js";
import {
  createPullRequestUpsertInput,
  mapPullRequestSnapshot,
} from "./pull-request-snapshot.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
} from "./pull-request-repository.js";
import { PullRequestReviewStateRepository } from "./pull-request-review-state-repository.js";

const GITHUB_API_HEADERS = {
  "X-GitHub-Api-Version": "2022-11-28",
};
const PULL_REQUEST_DETAIL_ETAG_KEY_PREFIX = "pull_request_detail_etag";

export interface ProcessTrackedPullRequestActivityOptions<TClient = Octokit> {
  currentUserLogin: string;
  pullRequestRepository?: Pick<PullRequestRepository, "upsertPullRequest">;
  botActivityClassifier?: BotActivityClassifier;
  notificationDispatcher?: NotificationDispatcher;
  notificationDispatchedAt?: string;
  fetchJobsForWorkflowRun?: IngestPullRequestActivityOptions<TClient>["fetchJobsForWorkflowRun"];
}

export interface ProcessTrackedPullRequestActivityResult {
  pullRequest: PullRequestRecord;
  skipActivityFanout: boolean;
}

export async function processTrackedPullRequestActivity<TClient>(
  database: DatabaseSync,
  client: TClient,
  pullRequest: PullRequestRecord,
  options: ProcessTrackedPullRequestActivityOptions<TClient>,
): Promise<ProcessTrackedPullRequestActivityResult> {
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const { pullRequest: refreshedPullRequest, skipActivityFanout } = await refreshPullRequestForActivity(
    database,
    client,
    pullRequest,
    pullRequestRepository,
  );
  const activityIngestionOptions: IngestPullRequestActivityOptions<TClient> = {
    ...(skipActivityFanout
      ? buildSkippedPullRequestActivityFetchOptions<TClient>(database, refreshedPullRequest.id)
      : {}),
    ...(options.fetchJobsForWorkflowRun
      ? { fetchJobsForWorkflowRun: options.fetchJobsForWorkflowRun }
      : {}),
  };

  await ingestPullRequestActivity(
    database,
    client,
    refreshedPullRequest,
    activityIngestionOptions,
  );
  normalizePullRequestActivity(database, refreshedPullRequest, options.currentUserLogin);

  try {
    await classifyBotPullRequestActivity(database, refreshedPullRequest.id, {
      ...(options.botActivityClassifier ? { botActivityClassifier: options.botActivityClassifier } : {}),
      currentUserLogin: options.currentUserLogin,
      pullRequestAuthorLogin: refreshedPullRequest.authorLogin,
    });
  } catch (error) {
    getLogger().warn("Bot activity classification failed", {
      pullRequest: formatPullRequestLabel(refreshedPullRequest),
      error,
    });
  }

  bundlePullRequestEvents(database, refreshedPullRequest.id);

  if (options.notificationDispatcher) {
    await dispatchPullRequestNotifications(database, refreshedPullRequest, {
      ...(options.notificationDispatchedAt
        ? { dispatchedAt: options.notificationDispatchedAt }
        : {}),
      currentUserLogin: options.currentUserLogin,
      notificationDispatcher: options.notificationDispatcher,
    });
  } else {
    preparePullRequestNotifications(database, refreshedPullRequest);
  }

  return {
    pullRequest: refreshedPullRequest,
    skipActivityFanout,
  };
}

async function refreshPullRequestForActivity<TClient>(
  database: DatabaseSync,
  client: TClient,
  pullRequest: PullRequestRecord,
  pullRequestRepository: Pick<PullRequestRepository, "upsertPullRequest">,
): Promise<ProcessTrackedPullRequestActivityResult> {
  const storedEtag = readPullRequestDetailEtag(database, pullRequest.id);
  const response = await requestPullRequestDetailFromGitHub(
    client as unknown as Octokit,
    pullRequest,
    storedEtag,
  );

  if (response.status === 304) {
    getLogger().debug("Skipped unchanged pull request activity fanout", {
      pullRequest: formatPullRequestLabel(pullRequest),
    });

    return {
      pullRequest,
      skipActivityFanout: true,
    };
  }

  if (response.status !== 200) {
    throw new Error(
      `GitHub returned unexpected status ${response.status} for ${formatPullRequestLabel(pullRequest)}`,
    );
  }

  const detail = mapPullRequestSnapshot(
    response.data,
    {
      repositoryOwner: pullRequest.repositoryOwner,
      repositoryName: pullRequest.repositoryName,
      number: pullRequest.number,
    },
    (message) => new Error(message),
  );
  const refreshedPullRequest = pullRequestRepository.upsertPullRequest(
    createPullRequestUpsertInput(detail),
  );

  writePullRequestDetailEtag(database, refreshedPullRequest.id, response.etag);

  return {
    pullRequest: refreshedPullRequest,
    skipActivityFanout: false,
  };
}

function buildSkippedPullRequestActivityFetchOptions<TClient>(
  database: DatabaseSync,
  pullRequestId: number,
): IngestPullRequestActivityOptions<TClient> {
  const reviewStateRepository = new PullRequestReviewStateRepository(database);
  const hasReviewStates = reviewStateRepository.hasReviewStatesForPullRequest(pullRequestId);

  return {
    fetchIssueComments: async () => [],
    ...(hasReviewStates ? { fetchPullRequestReviews: async () => [] } : {}),
    fetchPullRequestReviewComments: async () => [],
    fetchPullRequestTimeline: async () => [],
  };
}

async function requestPullRequestDetailFromGitHub(
  client: Octokit,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
  etag: string | undefined,
): Promise<{
  status: number;
  etag: string | null;
  data: unknown;
}> {
  const headers = etag
    ? {
        ...GITHUB_API_HEADERS,
        "If-None-Match": etag,
      }
    : GITHUB_API_HEADERS;

  try {
    const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: pullRequest.repositoryOwner,
      repo: pullRequest.repositoryName,
      pull_number: pullRequest.number,
      headers,
    });

    return {
      status: readInteger(response.status, "pull request response.status"),
      etag: readHeaderString(response.headers as unknown, "etag"),
      data: response.data as unknown,
    };
  } catch (error) {
    if (readStatusCode(error) === 304) {
      const errorResponse = readErrorResponse(error);

      return {
        status: 304,
        etag: readHeaderString(errorResponse?.headers, "etag"),
        data: errorResponse?.data ?? "",
      };
    }

    throw error;
  }
}

function readPullRequestDetailEtag(database: DatabaseSync, pullRequestId: number): string | undefined {
  const row = database
    .prepare("SELECT value FROM AppState WHERE key = ?")
    .get(buildPullRequestDetailEtagKey(pullRequestId));

  if (row === undefined) {
    return undefined;
  }

  const value = readString(requireRecord(row, "AppState row").value, "AppState.value").trim();
  return value.length === 0 ? undefined : value;
}

function writePullRequestDetailEtag(
  database: DatabaseSync,
  pullRequestId: number,
  etag: string | null,
): void {
  const key = buildPullRequestDetailEtagKey(pullRequestId);

  if (!etag) {
    database.prepare("DELETE FROM AppState WHERE key = ?").run(key);
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
    .run(key, etag);
}

function buildPullRequestDetailEtagKey(pullRequestId: number): string {
  return `${PULL_REQUEST_DETAIL_ETAG_KEY_PREFIX}:${pullRequestId}`;
}

function readHeaderString(headers: unknown, headerName: string): string | null {
  const record = readRecord(headers);

  if (record === undefined) {
    return null;
  }

  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== headerName.toLowerCase()) {
      continue;
    }

    return stringifyHeaderValue(value);
  }

  return null;
}

function stringifyHeaderValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const headerValues = value
      .map((entry) => stringifyHeaderValue(entry))
      .filter((entry): entry is string => entry !== null);

    return headerValues.length === 0 ? null : headerValues.join(", ");
  }

  return null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  const record = readRecord(value);

  if (record === undefined) {
    throw new Error(`${fieldName} must be an object`);
  }

  return record;
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function readErrorResponse(error: unknown): { headers?: unknown; data?: unknown } | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }

  const response = error.response;

  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  return response as { headers?: unknown; data?: unknown };
}

function readInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const numericValue = Number(value);

    if (Number.isSafeInteger(numericValue)) {
      return numericValue;
    }
  }

  throw new Error(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.number}`;
}
