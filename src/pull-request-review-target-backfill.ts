import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import {
  fetchPullRequestDetailFromGitHub,
  type DiscoveredPullRequest,
} from "./authored-pull-request-discovery.js";
import type { GitHubAuthContext } from "./github.js";
import { createPullRequestUpsertInput } from "./pull-request-snapshot.js";
import { PullRequestRepository } from "./pull-request-repository.js";

const BACKFILL_COMPLETED_KEY = "requested_review_targets_backfill_completed";
const COMPLETED_VALUE = "true";

export interface RequestedReviewTargetsBackfillOptions<TClient = Octokit> {
  pullRequestRepository?: Pick<
    PullRequestRepository,
    | "listTrackedPullRequests"
    | "listInactivePullRequests"
    | "upsertPullRequest"
  >;
  fetchPullRequestDetail?: (
    client: TClient,
    coordinates: {
      repositoryOwner: string;
      repositoryName: string;
      number: number;
    },
  ) => Promise<DiscoveredPullRequest>;
}

export interface RequestedReviewTargetsBackfillResult {
  didRun: boolean;
  updatedCount: number;
  failedCount: number;
}

export async function runRequestedReviewTargetsBackfill<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  options: RequestedReviewTargetsBackfillOptions<TClient> = {},
): Promise<RequestedReviewTargetsBackfillResult> {
  if (readAppStateValue(database, BACKFILL_COMPLETED_KEY) === COMPLETED_VALUE) {
    return {
      didRun: false,
      updatedCount: 0,
      failedCount: 0,
    };
  }

  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const fetchPullRequestDetail =
    options.fetchPullRequestDetail ??
    ((client: TClient, coordinates: { repositoryOwner: string; repositoryName: string; number: number }) =>
      fetchPullRequestDetailFromGitHub(
        client as unknown as Octokit,
        coordinates,
      ) as Promise<DiscoveredPullRequest>);
  const pullRequests = [
    ...pullRequestRepository.listTrackedPullRequests(),
    ...pullRequestRepository.listInactivePullRequests(),
  ];
  let updatedCount = 0;
  let failedCount = 0;

  for (const pullRequest of pullRequests) {
    try {
      const detail = await fetchPullRequestDetail(githubAuth.client, {
        repositoryOwner: pullRequest.repositoryOwner,
        repositoryName: pullRequest.repositoryName,
        number: pullRequest.number,
      });

      pullRequestRepository.upsertPullRequest(createPullRequestUpsertInput(detail));
      updatedCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  if (failedCount === 0) {
    writeAppStateValue(database, BACKFILL_COMPLETED_KEY, COMPLETED_VALUE);
  }

  return {
    didRun: true,
    updatedCount,
    failedCount,
  };
}

function readAppStateValue(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM AppState WHERE key = ?").get(key);

  if (row?.value === undefined) {
    return undefined;
  }

  return String(row.value);
}

function writeAppStateValue(database: DatabaseSync, key: string, value: string): void {
  database
    .prepare(
      `
        INSERT INTO AppState (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    )
    .run(key, value);
}
