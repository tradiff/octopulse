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
  const pollPullRequest =
    options.pollPullRequest ??
    (async (client: TClient, pullRequest: PullRequestRecord) => {
      await ingestPullRequestActivity(database, client, pullRequest);
      normalizePullRequestActivity(database, pullRequest, githubAuth.currentUserLogin);

      try {
        await classifyBotPullRequestActivity(database, pullRequest.id, {
          ...(botActivityClassifier ? { botActivityClassifier } : {}),
          currentUserLogin: githubAuth.currentUserLogin,
          pullRequestAuthorLogin: pullRequest.authorLogin,
        });
      } catch (error) {
        getLogger().warn("Bot activity classification failed", {
          pullRequest: formatPullRequestLabel(pullRequest),
          error,
        });
      }

      bundlePullRequestEvents(database, pullRequest.id);

      if (notificationDispatcher) {
        await dispatchPullRequestNotifications(database, pullRequest, {
          dispatchedAt: notificationDispatchedAt,
          notificationDispatcher,
        });
        return;
      }

      preparePullRequestNotifications(database, pullRequest);
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
