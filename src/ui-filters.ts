import {
  DEFAULT_ACTIVITY_FEED_FILTERS,
  isAllPullRequestStateFilterSelection,
  matchesPullRequestStateFilters,
  normalizePullRequestStateFilters,
  PULL_REQUEST_STATE_FILTER_VALUES,
  type ActivityFeedFilters,
  type PullRequestStateFilter,
} from "./activity-feed.js";
import type { NotificationHistoryEntry } from "./notification-history.js";
import type { ActorClass } from "./normalized-event-repository.js";
import { resolvePullRequestLifecycleState } from "./pull-request-state.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { RawEventsEntry } from "./raw-events.js";

export type UiFilterValues = ActivityFeedFilters;

export interface UiFilterOptions {
  repositories: string[];
  actorClasses: ActorClass[];
}

export interface BuildUiFilterOptionsInput {
  trackedPullRequests: PullRequestRecord[];
  inactivePullRequests: PullRequestRecord[];
  notificationHistory: NotificationHistoryEntry[];
  rawEvents: RawEventsEntry[];
}

export const DEFAULT_UI_FILTERS: UiFilterValues = {
  ...DEFAULT_ACTIVITY_FEED_FILTERS,
  pullRequestStates: [],
};

const PULL_REQUEST_STATE_FILTERS = new Set<PullRequestStateFilter>(PULL_REQUEST_STATE_FILTER_VALUES);
const ACTOR_CLASSES = new Set<ActorClass>(["self", "human_other", "bot"]);
const ALL_ACTIVITY_ACTOR_CLASSES = ["self", "human_other", "bot"] satisfies ActorClass[];

export function readUiFilterValues(searchParams: URLSearchParams): UiFilterValues {
  const actorClass = searchParams.get("actor-type");

  return {
    pullRequestStates: readPullRequestStateFilters(searchParams),
    repository: readTrimmedSearchParam(searchParams, "repo"),
    actorClass: ACTOR_CLASSES.has(actorClass as ActorClass)
      ? (actorClass as ActorClass)
      : DEFAULT_UI_FILTERS.actorClass,
  };
}

export function buildUiFilterOptions(input: BuildUiFilterOptionsInput): UiFilterOptions {
  return {
    repositories: sortStrings([
      ...input.trackedPullRequests.map((pullRequest) => formatRepositoryKey(pullRequest)),
      ...input.inactivePullRequests.map((pullRequest) => formatRepositoryKey(pullRequest)),
      ...input.notificationHistory.flatMap((entry) => (entry.repositoryKey ? [entry.repositoryKey] : [])),
      ...input.rawEvents.map((entry) => entry.repositoryKey),
    ]),
    actorClasses: sortStrings([
      ...ALL_ACTIVITY_ACTOR_CLASSES,
      ...input.notificationHistory.flatMap((entry) => entry.actorClasses),
      ...input.rawEvents.flatMap((entry) => (entry.actorClass ? [entry.actorClass] : [])),
    ]) as ActorClass[],
  };
}

export function filterTrackedPullRequests(
  pullRequests: PullRequestRecord[],
  filters: UiFilterValues,
): PullRequestRecord[] {
  return filterPullRequests(pullRequests, filters);
}

export function filterInactivePullRequests(
  pullRequests: PullRequestRecord[],
  filters: UiFilterValues,
): PullRequestRecord[] {
  return filterPullRequests(pullRequests, filters);
}

export function filterNotificationHistory(
  entries: NotificationHistoryEntry[],
  filters: UiFilterValues,
): NotificationHistoryEntry[] {
  return entries.filter((entry) => {
    if (
      !matchesPullRequestStateFilters(filters.pullRequestStates, {
        isTracked: entry.isTracked,
        pullRequestStatus: entry.pullRequestStatus,
      })
    ) {
      return false;
    }

    if (!matchesRepository(entry.repositoryKey, filters.repository)) {
      return false;
    }

    if (!matchesMultiValue(entry.actorClasses, filters.actorClass)) {
      return false;
    }

    return true;
  });
}

export function filterRawEvents(entries: RawEventsEntry[], filters: UiFilterValues): RawEventsEntry[] {
  return entries.filter((entry) => {
    if (
      !matchesPullRequestStateFilters(filters.pullRequestStates, {
        isTracked: entry.isTracked,
        pullRequestStatus: entry.pullRequestStatus,
      })
    ) {
      return false;
    }

    if (!matchesRepository(entry.repositoryKey, filters.repository)) {
      return false;
    }

    if (!matchesOptionalValue(entry.actorClass, filters.actorClass)) {
      return false;
    }

    return true;
  });
}

export function countActiveUiFilters(filters: UiFilterValues): number {
  let count = 0;

  if (!isAllPullRequestStateFilterSelection(filters.pullRequestStates)) {
    count += 1;
  }

  if (filters.repository.length > 0) {
    count += 1;
  }

  if (filters.actorClass.length > 0) {
    count += 1;
  }

  return count;
}

function filterPullRequests(
  pullRequests: PullRequestRecord[],
  filters: UiFilterValues,
): PullRequestRecord[] {
  return pullRequests.filter((pullRequest) => {
    if (
      !matchesPullRequestStateFilters(filters.pullRequestStates, {
        isTracked: pullRequest.isTracked,
        pullRequestStatus: resolvePullRequestLifecycleState(pullRequest),
      })
    ) {
      return false;
    }

    return matchesRepository(formatRepositoryKey(pullRequest), filters.repository);
  });
}

function matchesRepository(repositoryKey: string | null, filterValue: string): boolean {
  return filterValue.length === 0 || repositoryKey === filterValue;
}

function matchesOptionalValue(value: string | null, filterValue: string): boolean {
  return filterValue.length === 0 || value === filterValue;
}

function matchesMultiValue(values: readonly string[], filterValue: string): boolean {
  return filterValue.length === 0 || values.includes(filterValue);
}

function readTrimmedSearchParam(searchParams: URLSearchParams, key: string): string {
  return searchParams.get(key)?.trim() ?? "";
}

function readPullRequestStateFilters(searchParams: URLSearchParams): PullRequestStateFilter[] {
  const filters: PullRequestStateFilter[] = [];

  for (const rawValue of searchParams.getAll("pr-state")) {
    const value = rawValue.trim();

    if (value.length === 0 || value === "all") {
      continue;
    }

    if (PULL_REQUEST_STATE_FILTERS.has(value as PullRequestStateFilter)) {
      filters.push(value as PullRequestStateFilter);
    }
  }

  return normalizePullRequestStateFilters(filters);
}

function formatRepositoryKey(pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName">): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`;
}

function sortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
