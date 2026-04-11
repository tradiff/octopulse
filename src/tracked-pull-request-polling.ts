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
import { preparePullRequestNotifications } from "./notification-preparation.js";
import { ingestPullRequestActivity } from "./pull-request-activity-ingestion.js";
import { normalizePullRequestActivity } from "./pull-request-activity-normalization.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
} from "./pull-request-repository.js";

export interface PollTrackedPullRequestsOptions<TClient = Octokit> {
  pullRequestRepository?: Pick<PullRequestRepository, "listPullRequestsForPolling">;
  pollPullRequest?: (client: TClient, pullRequest: PullRequestRecord) => Promise<void>;
  botActivityClassifier?: BotActivityClassifier;
  notificationDispatcher?: NotificationDispatcher;
  observedAt?: string;
  notificationPreparedAt?: string;
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
  const notificationPreparedAt = options.notificationPreparedAt ?? new Date().toISOString();
  const notificationDispatchedAt = options.notificationDispatchedAt ?? new Date().toISOString();
  const pollPullRequest =
    options.pollPullRequest ??
    (async (client: TClient, pullRequest: PullRequestRecord) => {
      await ingestPullRequestActivity(database, client, pullRequest);
      normalizePullRequestActivity(database, pullRequest, githubAuth.currentUserLogin);

      try {
        await classifyBotPullRequestActivity(database, pullRequest.id, {
          ...(botActivityClassifier ? { botActivityClassifier } : {}),
        });
      } catch (error) {
        console.error(
          `Octopulse bot activity classification failed for pull request ${formatPullRequestLabel(pullRequest)}: ${getErrorMessage(error)}`,
        );
      }

      bundlePullRequestEvents(database, pullRequest.id);

      if (notificationDispatcher) {
        await dispatchPullRequestNotifications(database, pullRequest, {
          preparedAt: notificationPreparedAt,
          dispatchedAt: notificationDispatchedAt,
          notificationDispatcher,
        });
        return;
      }

      preparePullRequestNotifications(database, pullRequest, {
        preparedAt: notificationPreparedAt,
      });
    });
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

  let polledCount = 0;
  let failedCount = 0;

  for (const pullRequest of pullRequests) {
    try {
      await pollPullRequest(githubAuth.client, pullRequest);
      polledCount += 1;
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

      await pollTrackedPullRequests(database, githubAuth, cycleOptions);
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

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.number}`;
}

function logTrackedPullRequestPollingError(error: PullRequestPollingError): void {
  console.error(`Octopulse tracked pull request polling failed: ${error.message}`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
