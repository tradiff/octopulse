import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import {
  type DiscoveredPullRequest,
  fetchPullRequestDetailFromGitHub,
  type PullRequestCoordinates,
} from "./authored-pull-request-discovery.js";
import type { GitHubAuthContext } from "./github.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
} from "./pull-request-repository.js";

const MANUAL_TRACKING_REASON = "manual";

export interface TrackPullRequestByUrlOptions<TClient = Octokit> {
  pullRequestRepository?: Pick<
    PullRequestRepository,
    | "getPullRequestByRepositoryCoordinates"
    | "upsertPullRequest"
  >;
  fetchPullRequestDetail?: (
    client: TClient,
    coordinates: PullRequestCoordinates,
  ) => Promise<DiscoveredPullRequest>;
  observedAt?: string;
}

export interface TrackPullRequestByUrlResult {
  outcome: "tracked" | "already_tracked";
  pullRequest: PullRequestRecord;
}

export interface UntrackPullRequestOptions {
  pullRequestRepository?: Pick<
    PullRequestRepository,
    | "getPullRequestByGitHubPullRequestId"
    | "updatePullRequestTrackingState"
  >;
}

export interface UntrackPullRequestResult {
  outcome: "untracked" | "already_untracked";
  pullRequest: PullRequestRecord;
}

export class ManualPullRequestTrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualPullRequestTrackingError";
  }
}

export async function trackPullRequestByUrl<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  pullRequestUrl: string,
  options: TrackPullRequestByUrlOptions<TClient> = {},
): Promise<TrackPullRequestByUrlResult> {
  const coordinates = parseGitHubPullRequestUrl(pullRequestUrl);
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const fetchPullRequestDetail =
    options.fetchPullRequestDetail ??
    ((client: TClient, nextCoordinates: PullRequestCoordinates) =>
      fetchPullRequestDetailFromGitHub(
        client as unknown as Octokit,
        nextCoordinates,
      ) as Promise<DiscoveredPullRequest>);
  const existing = pullRequestRepository.getPullRequestByRepositoryCoordinates(
    coordinates.repositoryOwner,
    coordinates.repositoryName,
    coordinates.number,
  );

  let pullRequest: DiscoveredPullRequest;

  try {
    pullRequest = await fetchPullRequestDetail(githubAuth.client, coordinates);
  } catch (error) {
    throw new ManualPullRequestTrackingError(
      `Failed to fetch pull request ${formatPullRequestLabel(coordinates)}: ${getErrorMessage(error)}`,
    );
  }

  if (existing?.isTracked) {
    return {
      outcome: "already_tracked",
      pullRequest: existing,
    };
  }

  try {
    return {
      outcome: "tracked",
      pullRequest: pullRequestRepository.upsertPullRequest({
        githubPullRequestId: pullRequest.githubPullRequestId,
        repositoryOwner: pullRequest.repositoryOwner,
        repositoryName: pullRequest.repositoryName,
        number: pullRequest.number,
        url: pullRequest.url,
        authorLogin: pullRequest.authorLogin,
        title: pullRequest.title,
        state: pullRequest.state,
        isDraft: pullRequest.isDraft,
        lastSeenAt: options.observedAt ?? new Date().toISOString(),
        closedAt: pullRequest.closedAt,
        mergedAt: pullRequest.mergedAt,
        graceUntil: null,
        lastSeenHeadSha: pullRequest.lastSeenHeadSha,
        tracking: {
          isTracked: true,
          trackingReason: MANUAL_TRACKING_REASON,
          isStickyUntracked: false,
        },
      }),
    };
  } catch (error) {
    throw new ManualPullRequestTrackingError(
      `Failed to persist pull request ${formatPullRequestLabel(coordinates)}: ${getErrorMessage(error)}`,
    );
  }
}

export async function untrackPullRequest(
  database: DatabaseSync,
  githubPullRequestId: number,
  options: UntrackPullRequestOptions = {},
): Promise<UntrackPullRequestResult> {
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);

  let existing: PullRequestRecord | undefined;

  try {
    existing = pullRequestRepository.getPullRequestByGitHubPullRequestId(githubPullRequestId);
  } catch (error) {
    throw new ManualPullRequestTrackingError(
      `Failed to read pull request ${githubPullRequestId}: ${getErrorMessage(error)}`,
    );
  }

  if (!existing) {
    throw new ManualPullRequestTrackingError(
      `Pull request ${githubPullRequestId} is not tracked locally`,
    );
  }

  if (!existing.isTracked && existing.isStickyUntracked) {
    return {
      outcome: "already_untracked",
      pullRequest: existing,
    };
  }

  try {
    return {
      outcome: "untracked",
      pullRequest: pullRequestRepository.updatePullRequestTrackingState(githubPullRequestId, {
        isTracked: false,
        trackingReason: MANUAL_TRACKING_REASON,
        isStickyUntracked: true,
      }),
    };
  } catch (error) {
    throw new ManualPullRequestTrackingError(
      `Failed to persist pull request ${formatStoredPullRequestLabel(existing)}: ${getErrorMessage(error)}`,
    );
  }
}

export function parseGitHubPullRequestUrl(pullRequestUrl: string): PullRequestCoordinates {
  const normalizedPullRequestUrl = pullRequestUrl.trim();
  let url: URL;

  try {
    url = new URL(normalizedPullRequestUrl);
  } catch {
    throw new ManualPullRequestTrackingError(
      `Invalid pull request URL: ${normalizedPullRequestUrl}`,
    );
  }

  if (url.hostname !== "github.com") {
    throw new ManualPullRequestTrackingError(
      "Manual tracking only supports github.com pull request URLs",
    );
  }

  const pathParts = url.pathname.split("/").filter((part) => part.length > 0);
  const repositoryOwner = pathParts[0];
  const repositoryName = pathParts[1];
  const pullSegment = pathParts[2];
  const pullRequestNumber = Number(pathParts[3]);

  if (
    pathParts.length !== 4 ||
    !repositoryOwner ||
    !repositoryName ||
    pullSegment !== "pull" ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0
  ) {
    throw new ManualPullRequestTrackingError(
      `Unsupported pull request URL: ${normalizedPullRequestUrl}`,
    );
  }

  return {
    repositoryOwner,
    repositoryName,
    number: pullRequestNumber,
  };
}

function formatPullRequestLabel(coordinates: PullRequestCoordinates): string {
  return `${coordinates.repositoryOwner}/${coordinates.repositoryName}#${coordinates.number}`;
}

function formatStoredPullRequestLabel(
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
