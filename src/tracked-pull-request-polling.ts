import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import {
  classifyBotPullRequestActivity,
  type BotActivityClassifier,
} from "./bot-activity-classification.js";
import { bundlePullRequestEvents } from "./event-bundling.js";
import type { GitHubAuthContext } from "./github.js";
import {
  dispatchPullRequestNotifications,
  type NotificationDispatcher,
} from "./notification-dispatch.js";
import { getLogger } from "./logger.js";
import { preparePullRequestNotifications } from "./notification-preparation.js";
import {
  ingestPullRequestActivity,
  type IngestPullRequestActivityOptions,
} from "./pull-request-activity-ingestion.js";
import { normalizePullRequestActivity } from "./pull-request-activity-normalization.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
} from "./pull-request-repository.js";

const GITHUB_API_HEADERS = {
  "X-GitHub-Api-Version": "2022-11-28",
};
const PULL_REQUEST_DETAIL_ETAG_KEY_PREFIX = "pull_request_detail_etag";

interface PullRequestDetailRefresh {
  githubPullRequestId: number;
  url: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  title: string;
  state: string;
  isDraft: boolean;
  closedAt: string | null;
  mergedAt: string | null;
  lastSeenHeadSha: string | null;
}

export interface PollTrackedPullRequestsOptions<TClient = Octokit> {
  pullRequestRepository?: Pick<PullRequestRepository, "listPullRequestsForPolling" | "upsertPullRequest">;
  pollPullRequest?: (client: TClient, pullRequest: PullRequestRecord) => Promise<void>;
  botActivityClassifier?: BotActivityClassifier;
  notificationDispatcher?: NotificationDispatcher;
  observedAt?: string;
  notificationDispatchedAt?: string;
  onError?: (error: PullRequestPollingError) => void;
}

export interface PollTrackedPullRequestsResult {
  eligibleCount: number;
  polledCount: number;
  failedCount: number;
}

export interface StartRecurringTrackedPullRequestPollingOptions<TClient = Octokit>
  extends PollTrackedPullRequestsOptions<TClient> {
  intervalMs: number;
}

export interface RecurringTrackedPullRequestPollingHandle {
  stop(): void;
}

export class PullRequestPollingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestPollingError";
  }
}

export async function pollTrackedPullRequests<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  options: PollTrackedPullRequestsOptions<TClient> = {},
): Promise<PollTrackedPullRequestsResult> {
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const botActivityClassifier = options.botActivityClassifier;
  const notificationDispatcher = options.notificationDispatcher;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const notificationDispatchedAt = options.notificationDispatchedAt ?? new Date().toISOString();
  const defaultPollPullRequest =
    options.pollPullRequest ??
    (async (client: TClient, pullRequest: PullRequestRecord) => {
      const { pullRequest: refreshedPullRequest, skipActivityFanout } = await refreshPullRequestForPolling(
        database,
        client,
        pullRequest,
        pullRequestRepository,
      );
      const activityIngestionOptions = skipActivityFanout
        ? buildSkippedPullRequestActivityFetchOptions<TClient>()
        : undefined;

      await ingestPullRequestActivity(
        database,
        client,
        refreshedPullRequest,
        activityIngestionOptions,
      );
      normalizePullRequestActivity(database, refreshedPullRequest, githubAuth.currentUserLogin);

      try {
        await classifyBotPullRequestActivity(database, refreshedPullRequest.id, {
          ...(botActivityClassifier ? { botActivityClassifier } : {}),
          currentUserLogin: githubAuth.currentUserLogin,
          pullRequestAuthorLogin: refreshedPullRequest.authorLogin,
        });
      } catch (error) {
        getLogger().warn("Bot activity classification failed", {
          pullRequest: formatPullRequestLabel(refreshedPullRequest),
          error,
        });
      }

      bundlePullRequestEvents(database, refreshedPullRequest.id);

      if (notificationDispatcher) {
        await dispatchPullRequestNotifications(database, refreshedPullRequest, {
          dispatchedAt: notificationDispatchedAt,
          notificationDispatcher,
        });
        return;
      }

      preparePullRequestNotifications(database, refreshedPullRequest);
    });
  const pollPullRequest = defaultPollPullRequest;
  const onError = options.onError ?? logTrackedPullRequestPollingError;

  let pullRequests: PullRequestRecord[];

  try {
    pullRequests = pullRequestRepository.listPullRequestsForPolling(observedAt);
  } catch (error) {
    if (error instanceof PullRequestPollingError) {
      throw error;
    }

    throw new PullRequestPollingError(
      `Failed to load pull requests for polling: ${getErrorMessage(error)}`,
    );
  }

  getLogger().debug("Loaded pull requests eligible for polling", {
    observedAt,
    eligibleCount: pullRequests.length,
  });

  let polledCount = 0;
  let failedCount = 0;

  for (const pullRequest of pullRequests) {
    try {
      await pollPullRequest(githubAuth.client, pullRequest);
      polledCount += 1;
      getLogger().debug("Polled tracked pull request", {
        pullRequest: formatPullRequestLabel(pullRequest),
      });
    } catch (error) {
      failedCount += 1;
      onError(
        new PullRequestPollingError(
          `Failed to poll pull request ${formatPullRequestLabel(pullRequest)}: ${getErrorMessage(error)}`,
        ),
      );
    }
  }

  return {
    eligibleCount: pullRequests.length,
    polledCount,
    failedCount,
  };
}

export function startRecurringTrackedPullRequestPolling<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  options: StartRecurringTrackedPullRequestPollingOptions<TClient>,
): RecurringTrackedPullRequestPollingHandle {
  const { intervalMs, onError, ...pollOptions } = options;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new PullRequestPollingError(
      "Recurring tracked pull request polling interval must be greater than zero",
    );
  }

  let isStopped = false;
  let isRunning = false;
  const timer = setInterval(() => {
    void runPollingCycle();
  }, intervalMs);

  timer.unref?.();

  return {
    stop(): void {
      if (isStopped) {
        return;
      }

      isStopped = true;
      clearInterval(timer);
    },
  };

  async function runPollingCycle(): Promise<void> {
    if (isStopped || isRunning) {
      return;
    }

    isRunning = true;

    try {
      const cycleOptions: PollTrackedPullRequestsOptions<TClient> = onError
        ? {
            ...pollOptions,
            onError,
          }
        : pollOptions;

      const result = await pollTrackedPullRequests(database, githubAuth, cycleOptions);

      if (result.polledCount > 0 || result.failedCount > 0) {
        getLogger().info("Completed tracked pull request polling cycle", result);
      } else {
        getLogger().debug("Tracked pull request polling cycle found no eligible work", result);
      }
    } catch (error) {
      const pollingError =
        error instanceof PullRequestPollingError
          ? error
          : new PullRequestPollingError(
              `Failed to poll tracked pull requests: ${getErrorMessage(error)}`,
            );

      (onError ?? logTrackedPullRequestPollingError)(pollingError);
    } finally {
      isRunning = false;
    }
  }
}

async function refreshPullRequestForPolling<TClient>(
  database: DatabaseSync,
  client: TClient,
  pullRequest: PullRequestRecord,
  pullRequestRepository: Pick<PullRequestRepository, "upsertPullRequest">,
): Promise<{
  pullRequest: PullRequestRecord;
  skipActivityFanout: boolean;
}> {
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
    throw new PullRequestPollingError(
      `GitHub returned unexpected status ${response.status} for ${formatPullRequestLabel(pullRequest)}`,
    );
  }

  const detail = mapPullRequestDetailResponse(response.data, pullRequest);
  const refreshedPullRequest = pullRequestRepository.upsertPullRequest({
    githubPullRequestId: detail.githubPullRequestId,
    repositoryOwner: pullRequest.repositoryOwner,
    repositoryName: pullRequest.repositoryName,
    number: pullRequest.number,
    url: detail.url,
    authorLogin: detail.authorLogin,
    authorAvatarUrl: detail.authorAvatarUrl,
    title: detail.title,
    state: detail.state,
    isDraft: detail.isDraft,
    closedAt: detail.closedAt,
    mergedAt: detail.mergedAt,
    lastSeenHeadSha: detail.lastSeenHeadSha,
  });

  writePullRequestDetailEtag(database, refreshedPullRequest.id, response.etag);

  return {
    pullRequest: refreshedPullRequest,
    skipActivityFanout: false,
  };
}

function buildSkippedPullRequestActivityFetchOptions<TClient>(): IngestPullRequestActivityOptions<TClient> {
  return {
    fetchIssueComments: async () => [],
    fetchPullRequestReviews: async () => [],
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

function mapPullRequestDetailResponse(
  data: unknown,
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): PullRequestDetailRefresh {
  const value = requireRecord(data, "pull request response");
  const user = requireRecord(value.user, "pull request response.user");
  const head = requireRecord(value.head, "pull request response.head");
  const number = readInteger(value.number, "pull request response.number");

  if (number !== pullRequest.number) {
    throw new PullRequestPollingError(
      `GitHub returned a mismatched pull request number for ${formatPullRequestLabel(pullRequest)}`,
    );
  }

  return {
    githubPullRequestId: readInteger(value.id, "pull request response.id"),
    url: readString(value.html_url, "pull request response.html_url"),
    authorLogin: readString(user.login, "pull request response.user.login"),
    authorAvatarUrl: readNullableString(user.avatar_url, "pull request response.user.avatar_url"),
    title: readString(value.title, "pull request response.title"),
    state: readString(value.state, "pull request response.state"),
    isDraft: readBoolean(value.draft, "pull request response.draft"),
    closedAt: readNullableString(value.closed_at, "pull request response.closed_at"),
    mergedAt: readNullableString(value.merged_at, "pull request response.merged_at"),
    lastSeenHeadSha: readNullableString(head.sha, "pull request response.head.sha"),
  };
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
    throw new PullRequestPollingError(`${fieldName} must be an object`);
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

  throw new PullRequestPollingError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new PullRequestPollingError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new PullRequestPollingError(`${fieldName} must be a boolean`);
  }

  return value;
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.number}`;
}

function logTrackedPullRequestPollingError(error: PullRequestPollingError): void {
  getLogger().error("Octopulse tracked pull request polling failed", {
    error,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
