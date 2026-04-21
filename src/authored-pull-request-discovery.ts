import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

import type { GitHubAuthContext } from "./github.js";
import { getLogger } from "./logger.js";
import type { NotificationDispatcher } from "./notification-dispatch.js";
import { dispatchPullRequestNotifications } from "./notification-dispatch.js";
import { NormalizedEventRepository } from "./normalized-event-repository.js";
import { preparePullRequestNotifications } from "./notification-preparation.js";
import { PullRequestRepository } from "./pull-request-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";

const FIRST_RUN_DISCOVERY_COMPLETED_KEY = "first_run_pull_request_discovery_completed";
const GITHUB_API_HEADERS = {
  "X-GitHub-Api-Version": "2022-11-28",
};
const SEARCH_PAGE_SIZE = 100;
const COMPLETED_STATE_VALUE = "true";
const REVIEW_REQUESTED_NOTIFICATION_EVENT_TYPE = "review_requested";

type PullRequestDiscoverySource = "authored" | "review_requested";

interface DiscoveryCandidate {
  coordinates: PullRequestCoordinates;
  sources: PullRequestDiscoverySource[];
}

export interface PullRequestCoordinates {
  repositoryOwner: string;
  repositoryName: string;
  number: number;
}

export interface DiscoveredPullRequest extends PullRequestCoordinates {
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

export interface DiscoverOpenAuthoredPullRequestsOptions<TClient = Octokit> {
  pullRequestRepository?: Pick<
    PullRequestRepository,
    | "getPullRequestByRepositoryCoordinates"
    | "upsertPullRequest"
  >;
  searchOpenAuthoredPullRequests?: (
    client: TClient,
    authorLogin: string,
  ) => Promise<PullRequestCoordinates[]>;
  searchOpenReviewRequestedPullRequests?: (
    client: TClient,
    reviewerLogin: string,
  ) => Promise<PullRequestCoordinates[]>;
  fetchPullRequestDetail?: (
    client: TClient,
    coordinates: PullRequestCoordinates,
  ) => Promise<DiscoveredPullRequest>;
  observedAt?: string;
  notificationDispatcher?: NotificationDispatcher;
  notificationDispatchedAt?: string;
}

export interface DiscoverOpenAuthoredPullRequestsResult {
  discoveredCount: number;
}

export interface FirstRunAuthoredPullRequestDiscoveryResult
  extends DiscoverOpenAuthoredPullRequestsResult {
  didRun: boolean;
}

export interface StartRecurringAuthoredPullRequestDiscoveryOptions<TClient = Octokit>
  extends DiscoverOpenAuthoredPullRequestsOptions<TClient> {
  intervalMs: number;
  onError?: (error: PullRequestDiscoveryError) => void;
}

export interface RecurringAuthoredPullRequestDiscoveryHandle {
  stop(): void;
}

export class PullRequestDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestDiscoveryError";
  }
}

export async function runFirstRunAuthoredPullRequestDiscovery<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  options: DiscoverOpenAuthoredPullRequestsOptions<TClient> = {},
): Promise<FirstRunAuthoredPullRequestDiscoveryResult> {
  if (readAppStateValue(database, FIRST_RUN_DISCOVERY_COMPLETED_KEY) === COMPLETED_STATE_VALUE) {
    return {
      didRun: false,
      discoveredCount: 0,
    };
  }

  const result = await discoverOpenAuthoredPullRequests(database, githubAuth, options);
  writeAppStateValue(database, FIRST_RUN_DISCOVERY_COMPLETED_KEY, COMPLETED_STATE_VALUE);

  return {
    didRun: true,
    discoveredCount: result.discoveredCount,
  };
}

export function startRecurringAuthoredPullRequestDiscovery<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  options: StartRecurringAuthoredPullRequestDiscoveryOptions<TClient>,
): RecurringAuthoredPullRequestDiscoveryHandle {
  const { intervalMs, onError, ...discoveryOptions } = options;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new PullRequestDiscoveryError(
      "Recurring pull request discovery interval must be greater than zero",
    );
  }

  let isStopped = false;
  let isRunning = false;
  const timer = setInterval(() => {
    void runDiscoveryCycle();
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

  async function runDiscoveryCycle(): Promise<void> {
    if (isStopped || isRunning) {
      return;
    }

    isRunning = true;

    try {
      const result = await discoverOpenAuthoredPullRequests(database, githubAuth, discoveryOptions);

      if (result.discoveredCount > 0) {
        getLogger().info("Completed pull request discovery cycle", result);
      } else {
        getLogger().debug("Pull request discovery cycle found no new pull requests", result);
      }
    } catch (error) {
      const discoveryError =
        error instanceof PullRequestDiscoveryError
          ? error
          : new PullRequestDiscoveryError(
              `Failed to discover pull requests: ${getErrorMessage(error)}`,
            );

      (onError ?? logRecurringDiscoveryError)(discoveryError);
    } finally {
      isRunning = false;
    }
  }
}

export async function discoverOpenAuthoredPullRequests<TClient>(
  database: DatabaseSync,
  githubAuth: GitHubAuthContext<TClient>,
  options: DiscoverOpenAuthoredPullRequestsOptions<TClient> = {},
): Promise<DiscoverOpenAuthoredPullRequestsResult> {
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const searchOpenAuthoredPullRequests =
    options.searchOpenAuthoredPullRequests ??
    ((client: TClient, authorLogin: string) =>
      searchOpenAuthoredPullRequestsViaGitHub(
        client as unknown as Octokit,
        authorLogin,
      ) as Promise<PullRequestCoordinates[]>);
  const searchOpenReviewRequestedPullRequests =
    options.searchOpenReviewRequestedPullRequests ??
    ((client: TClient, reviewerLogin: string) =>
      searchOpenReviewRequestedPullRequestsViaGitHub(
        client as unknown as Octokit,
        reviewerLogin,
      ) as Promise<PullRequestCoordinates[]>);
  const fetchPullRequestDetail =
    options.fetchPullRequestDetail ??
    ((client: TClient, coordinates: PullRequestCoordinates) =>
      fetchPullRequestDetailFromGitHub(
        client as unknown as Octokit,
        coordinates,
      ) as Promise<DiscoveredPullRequest>);
  const observedAt = options.observedAt ?? new Date().toISOString();
  const notificationDispatchedAt = options.notificationDispatchedAt ?? observedAt;

  let discoveryCandidates: DiscoveryCandidate[];

  try {
    const [authoredCoordinates, reviewRequestedCoordinates] = await Promise.all([
      searchOpenAuthoredPullRequests(githubAuth.client, githubAuth.currentUserLogin),
      searchOpenReviewRequestedPullRequests(githubAuth.client, githubAuth.currentUserLogin),
    ]);

    discoveryCandidates = mergeDiscoveryCandidates({
      authoredCoordinates,
      reviewRequestedCoordinates,
    });
  } catch (error) {
    if (error instanceof PullRequestDiscoveryError) {
      throw error;
    }

    throw new PullRequestDiscoveryError(
      `Failed to discover pull requests: ${getErrorMessage(error)}`,
    );
  }

  getLogger().debug("Loaded pull requests from GitHub search", {
    currentUserLogin: githubAuth.currentUserLogin,
    discoveredCount: discoveryCandidates.length,
    authoredCount: discoveryCandidates.filter((candidate) => candidate.sources.includes("authored")).length,
    reviewRequestedCount: discoveryCandidates.filter((candidate) =>
      candidate.sources.includes("review_requested"),
    ).length,
  });

  for (const candidate of discoveryCandidates) {
    const { coordinates } = candidate;
    const existingPullRequest = pullRequestRepository.getPullRequestByRepositoryCoordinates(
      coordinates.repositoryOwner,
      coordinates.repositoryName,
      coordinates.number,
    );
    let pullRequest: DiscoveredPullRequest;

    try {
      pullRequest = await fetchPullRequestDetail(githubAuth.client, coordinates);
    } catch (error) {
      if (error instanceof PullRequestDiscoveryError) {
        throw error;
      }

      throw new PullRequestDiscoveryError(
        `Failed to fetch pull request ${formatPullRequestLabel(coordinates)}: ${getErrorMessage(error)}`,
      );
    }

    try {
      const persistedPullRequest = pullRequestRepository.upsertPullRequest({
        githubPullRequestId: pullRequest.githubPullRequestId,
        repositoryOwner: pullRequest.repositoryOwner,
        repositoryName: pullRequest.repositoryName,
        number: pullRequest.number,
        url: pullRequest.url,
        authorLogin: pullRequest.authorLogin,
        authorAvatarUrl: pullRequest.authorAvatarUrl,
        title: pullRequest.title,
        state: pullRequest.state,
        isDraft: pullRequest.isDraft,
        lastSeenAt: observedAt,
        closedAt: pullRequest.closedAt,
        mergedAt: pullRequest.mergedAt,
        graceUntil: null,
        lastSeenHeadSha: pullRequest.lastSeenHeadSha,
      });

      if (
        existingPullRequest === undefined &&
        candidate.sources.includes("review_requested") &&
        !candidate.sources.includes("authored")
      ) {
        await createReviewRequestedNotification(database, persistedPullRequest, {
          occurredAt: observedAt,
          dispatchedAt: notificationDispatchedAt,
          currentUserLogin: githubAuth.currentUserLogin,
          ...(options.notificationDispatcher
            ? { notificationDispatcher: options.notificationDispatcher }
            : {}),
        });
      }

      getLogger().debug("Persisted discovered pull request", {
        pullRequest: formatPullRequestLabel(coordinates),
      });
    } catch (error) {
      if (error instanceof PullRequestDiscoveryError) {
        throw error;
      }

      throw new PullRequestDiscoveryError(
        `Failed to persist pull request ${formatPullRequestLabel(coordinates)}: ${getErrorMessage(error)}`,
      );
    }
  }

  return {
    discoveredCount: discoveryCandidates.length,
  };
}

async function searchOpenAuthoredPullRequestsViaGitHub(
  client: Octokit,
  authorLogin: string,
): Promise<PullRequestCoordinates[]> {
  const coordinatesList: PullRequestCoordinates[] = [];

  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /search/issues", {
      q: `is:pr state:open author:${authorLogin}`,
      per_page: SEARCH_PAGE_SIZE,
      page,
      headers: GITHUB_API_HEADERS,
    });
    const items = readSearchItems(response.data as unknown);

    for (const item of items) {
      coordinatesList.push(readSearchItemCoordinates(item));
    }

    if (items.length < SEARCH_PAGE_SIZE) {
      return coordinatesList;
    }
  }
}

async function searchOpenReviewRequestedPullRequestsViaGitHub(
  client: Octokit,
  reviewerLogin: string,
): Promise<PullRequestCoordinates[]> {
  const coordinatesList: PullRequestCoordinates[] = [];

  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /search/issues", {
      q: `is:pr state:open review-requested:${reviewerLogin}`,
      per_page: SEARCH_PAGE_SIZE,
      page,
      headers: GITHUB_API_HEADERS,
    });
    const items = readSearchItems(response.data as unknown);

    for (const item of items) {
      coordinatesList.push(readSearchItemCoordinates(item));
    }

    if (items.length < SEARCH_PAGE_SIZE) {
      return coordinatesList;
    }
  }
}

export async function fetchPullRequestDetailFromGitHub(
  client: Octokit,
  coordinates: PullRequestCoordinates,
): Promise<DiscoveredPullRequest> {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: coordinates.repositoryOwner,
    repo: coordinates.repositoryName,
    pull_number: coordinates.number,
    headers: GITHUB_API_HEADERS,
  });

  return mapPullRequestDetail(response.data as unknown, coordinates);
}

function readSearchItems(data: unknown): unknown[] {
  const value = requireRecord(data, "search response");
  const items = value.items;

  if (!Array.isArray(items)) {
    throw new PullRequestDiscoveryError("search response.items must be an array");
  }

  return items;
}

function readSearchItemCoordinates(item: unknown): PullRequestCoordinates {
  const value = requireRecord(item, "search response item");

  return {
    ...parseRepositoryApiUrl(
      readString(value.repository_url, "search response item.repository_url"),
    ),
    number: readInteger(value.number, "search response item.number"),
  };
}

function parseRepositoryApiUrl(
  repositoryApiUrl: string,
): Pick<PullRequestCoordinates, "repositoryOwner" | "repositoryName"> {
  let url: URL;

  try {
    url = new URL(repositoryApiUrl);
  } catch {
    throw new PullRequestDiscoveryError(`Invalid repository API URL: ${repositoryApiUrl}`);
  }

  const pathParts = url.pathname.split("/").filter((part) => part.length > 0);
  const repositoryOwner = pathParts[1];
  const repositoryName = pathParts[2];

  if (pathParts[0] !== "repos" || !repositoryOwner || !repositoryName) {
    throw new PullRequestDiscoveryError(`Unsupported repository API URL: ${repositoryApiUrl}`);
  }

  return {
    repositoryOwner,
    repositoryName,
  };
}

function mergeDiscoveryCandidates(input: {
  authoredCoordinates: PullRequestCoordinates[];
  reviewRequestedCoordinates: PullRequestCoordinates[];
}): DiscoveryCandidate[] {
  const candidates = new Map<string, DiscoveryCandidate>();

  appendDiscoveryCandidates(candidates, input.authoredCoordinates, "authored");
  appendDiscoveryCandidates(candidates, input.reviewRequestedCoordinates, "review_requested");

  return [...candidates.values()];
}

function appendDiscoveryCandidates(
  candidates: Map<string, DiscoveryCandidate>,
  coordinatesList: PullRequestCoordinates[],
  source: PullRequestDiscoverySource,
): void {
  for (const coordinates of coordinatesList) {
    const key = formatPullRequestLabel(coordinates);
    const existing = candidates.get(key);

    if (existing) {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }

      continue;
    }

    candidates.set(key, {
      coordinates,
      sources: [source],
    });
  }
}

async function createReviewRequestedNotification(
  database: DatabaseSync,
  pullRequest: PullRequestRecord,
  options: {
    occurredAt: string;
    dispatchedAt: string;
    currentUserLogin: string;
    notificationDispatcher?: NotificationDispatcher;
  },
): Promise<void> {
  new NormalizedEventRepository(database).insertNormalizedEvent({
    pullRequestId: pullRequest.id,
    eventType: REVIEW_REQUESTED_NOTIFICATION_EVENT_TYPE,
    decisionState: "notified",
    notificationTiming: "immediate",
    occurredAt: options.occurredAt,
  });

  if (options.notificationDispatcher) {
    await dispatchPullRequestNotifications(database, pullRequest, {
      dispatchedAt: options.dispatchedAt,
      currentUserLogin: options.currentUserLogin,
      notificationDispatcher: options.notificationDispatcher,
    });
    return;
  }

  preparePullRequestNotifications(database, pullRequest);
}

function mapPullRequestDetail(
  data: unknown,
  coordinates: PullRequestCoordinates,
): DiscoveredPullRequest {
  const value = requireRecord(data, "pull request response");
  const user = requireRecord(value.user, "pull request response.user");
  const head = requireRecord(value.head, "pull request response.head");
  const number = readInteger(value.number, "pull request response.number");

  if (number !== coordinates.number) {
    throw new PullRequestDiscoveryError(
      `GitHub returned a mismatched pull request number for ${formatPullRequestLabel(coordinates)}`,
    );
  }

  return {
    githubPullRequestId: readInteger(value.id, "pull request response.id"),
    repositoryOwner: coordinates.repositoryOwner,
    repositoryName: coordinates.repositoryName,
    number,
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

function readAppStateValue(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM AppState WHERE key = ?").get(key);

  if (row === undefined) {
    return undefined;
  }

  const value = requireRecord(row, "AppState row").value;
  return readString(value, "AppState.value");
}

function writeAppStateValue(database: DatabaseSync, key: string, value: string): void {
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
    .run(key, value);
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PullRequestDiscoveryError(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
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

  throw new PullRequestDiscoveryError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new PullRequestDiscoveryError(`${fieldName} must be a string`);
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
    throw new PullRequestDiscoveryError(`${fieldName} must be a boolean`);
  }

  return value;
}

function formatPullRequestLabel(coordinates: PullRequestCoordinates): string {
  return `${coordinates.repositoryOwner}/${coordinates.repositoryName}#${coordinates.number}`;
}

function logRecurringDiscoveryError(error: PullRequestDiscoveryError): void {
  getLogger().error("Octopulse recurring pull request discovery failed", {
    error,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
