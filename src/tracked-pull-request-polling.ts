import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import {
  type BotActivityClassifier,
} from "./bot-activity-classification.js";
import type { GitHubAuthContext } from "./github.js";
import { getLogger } from "./logger.js";
import {
  type NotificationDispatcher,
} from "./notification-dispatch.js";
import {
  processTrackedPullRequestActivity,
  type ProcessTrackedPullRequestActivityOptions,
} from "./tracked-pull-request-activity.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
} from "./pull-request-repository.js";

const PULL_REQUEST_POLL_CONCURRENCY = 4;
const GRACE_PERIOD_POLL_INTERVAL_MS = 15 * 60_000;
const GRACE_PERIOD_POLL_RETRY_DELAY_MS = 60_000;
const GRACE_PERIOD_POLL_DEFER_DELAY_MS = 1_000;

export interface PollTrackedPullRequestsOptions<TClient = Octokit> {
  pullRequestRepository?: Pick<
    PullRequestRepository,
    "deactivateClosedPullRequests" | "listPullRequestsForPolling" | "upsertPullRequest"
  >;
  pollPullRequest?: (client: TClient, pullRequest: PullRequestRecord) => Promise<void>;
  botActivityClassifier?: BotActivityClassifier;
  notificationDispatcher?: NotificationDispatcher;
  observedAt?: string;
  gracePeriodMs?: number;
  includeTrackedPullRequests?: boolean;
  includeGracePeriodPullRequests?: boolean;
  notificationDispatchedAt?: string;
  onError?: (error: PullRequestPollingError) => void;
  fetchJobsForWorkflowRun?: ProcessTrackedPullRequestActivityOptions<TClient>["fetchJobsForWorkflowRun"];
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
  const includeTrackedPullRequests = options.includeTrackedPullRequests ?? true;
  const includeGracePeriodPullRequests = options.includeGracePeriodPullRequests ?? true;

  if (options.gracePeriodMs !== undefined) {
    pullRequestRepository.deactivateClosedPullRequests(options.gracePeriodMs);
  }

  const defaultPollPullRequest =
    options.pollPullRequest ??
    (async (client: TClient, pullRequest: PullRequestRecord) => {
      await processTrackedPullRequestActivity(database, client, pullRequest, {
        currentUserLogin: githubAuth.currentUserLogin,
        pullRequestRepository,
        ...(botActivityClassifier ? { botActivityClassifier } : {}),
        ...(notificationDispatcher
          ? {
              notificationDispatcher,
              notificationDispatchedAt,
            }
          : {}),
        ...(options.fetchJobsForWorkflowRun
          ? { fetchJobsForWorkflowRun: options.fetchJobsForWorkflowRun }
          : {}),
      });
    });
  const pollPullRequest = defaultPollPullRequest;
  const onError = options.onError ?? logTrackedPullRequestPollingError;

  let pullRequests: PullRequestRecord[];

  try {
    pullRequests = pullRequestRepository
      .listPullRequestsForPolling(observedAt)
      .filter(
        (pullRequest) =>
          pullRequest.isTracked ? includeTrackedPullRequests : includeGracePeriodPullRequests,
      );
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

  let nextPullRequestIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(PULL_REQUEST_POLL_CONCURRENCY, pullRequests.length) }, async () => {
      while (nextPullRequestIndex < pullRequests.length) {
        const pullRequest = pullRequests[nextPullRequestIndex];
        nextPullRequestIndex += 1;

        if (!pullRequest) {
          return;
        }

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
    }),
  );

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
    void runPollingCycle({ includeGracePeriodPullRequests: false });
  }, intervalMs);
  let gracePeriodTimer: ReturnType<typeof setTimeout> | undefined;

  timer.unref?.();
  scheduleGracePeriodPolling(GRACE_PERIOD_POLL_INTERVAL_MS);

  return {
    stop(): void {
      if (isStopped) {
        return;
      }

      isStopped = true;
      clearInterval(timer);
      if (gracePeriodTimer !== undefined) {
        clearTimeout(gracePeriodTimer);
      }
    },
  };

  async function runPollingCycle(
    cycleOptions: Pick<
      PollTrackedPullRequestsOptions<TClient>,
      "includeTrackedPullRequests" | "includeGracePeriodPullRequests"
    >,
  ): Promise<PollTrackedPullRequestsResult | undefined> {
    if (isStopped || isRunning) {
      return;
    }

    isRunning = true;

    try {
      const pollingOptions: PollTrackedPullRequestsOptions<TClient> = {
        ...pollOptions,
        ...cycleOptions,
        ...(onError ? { onError } : {}),
      };

      const result = await pollTrackedPullRequests(database, githubAuth, pollingOptions);

      if (result.polledCount > 0 || result.failedCount > 0) {
        getLogger().info("Completed tracked pull request polling cycle", result);
      } else {
        getLogger().debug("Tracked pull request polling cycle found no eligible work", result);
      }

      return result;
    } catch (error) {
      const pollingError =
        error instanceof PullRequestPollingError
          ? error
          : new PullRequestPollingError(
              `Failed to poll tracked pull requests: ${getErrorMessage(error)}`,
            );

      (onError ?? logTrackedPullRequestPollingError)(pollingError);
      return undefined;
    } finally {
      isRunning = false;
    }
  }

  function scheduleGracePeriodPolling(delayMs: number): void {
    gracePeriodTimer = setTimeout(() => {
      void runGracePeriodPollingCycle();
    }, delayMs);
    gracePeriodTimer.unref?.();
  }

  async function runGracePeriodPollingCycle(): Promise<void> {
    if (isStopped) {
      return;
    }

    if (isRunning) {
      scheduleGracePeriodPolling(GRACE_PERIOD_POLL_DEFER_DELAY_MS);
      return;
    }

    const result = await runPollingCycle({ includeTrackedPullRequests: false });

    if (isStopped) {
      return;
    }

    scheduleGracePeriodPolling(
      result === undefined || result.failedCount > 0
        ? GRACE_PERIOD_POLL_RETRY_DELAY_MS
        : GRACE_PERIOD_POLL_INTERVAL_MS,
    );
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
