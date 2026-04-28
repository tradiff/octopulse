import {
  DEFAULT_ACTIVITY_FEED_FILTERS,
  type ActivityFeedFilters,
} from "./activity-feed.js";
import type { NotificationHistoryEntry } from "./notification-history.js";
import type { ActorClass } from "./normalized-event-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { RawEventsEntry } from "./raw-events.js";

export type PullRequestStateFilter = "all" | "tracked" | "inactive";

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

export const DEFAULT_UI_FILTERS: UiFilterValues = { ...DEFAULT_ACTIVITY_FEED_FILTERS };

const PULL_REQUEST_STATE_FILTERS = new Set<PullRequestStateFilter>(["all", "tracked", "inactive"]);
const ACTOR_CLASSES = new Set<ActorClass>(["self", "human_other", "bot"]);
const ALL_ACTIVITY_ACTOR_CLASSES = ["self", "human_other", "bot"] satisfies ActorClass[];

export function readUiFilterValues(searchParams: URLSearchParams): UiFilterValues {
  const pullRequestState = searchParams.get("pr-state");
  const actorClass = searchParams.get("actor-type");

  return {
    pullRequestState: PULL_REQUEST_STATE_FILTERS.has(pullRequestState as PullRequestStateFilter)
      ? (pullRequestState as PullRequestStateFilter)
      : DEFAULT_UI_FILTERS.pullRequestState,
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
  return filterPullRequests(pullRequests, filters, "tracked");
}

export function filterInactivePullRequests(
  pullRequests: PullRequestRecord[],
  filters: UiFilterValues,
): PullRequestRecord[] {
  return filterPullRequests(pullRequests, filters, "inactive");
}

export function filterNotificationHistory(
  entries: NotificationHistoryEntry[],
  filters: UiFilterValues,
): NotificationHistoryEntry[] {
  return entries.filter((entry) => {
    if (!matchesPullRequestState(entry.isTracked, filters.pullRequestState)) {
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
    if (!matchesPullRequestState(entry.isTracked, filters.pullRequestState)) {
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

  for (const value of Object.values(filters)) {
    if (value !== "" && value !== "all") {
      count += 1;
    }
  }

  return count;
}

function filterPullRequests(
  pullRequests: PullRequestRecord[],
  filters: UiFilterValues,
  state: Exclude<PullRequestStateFilter, "all">,
): PullRequestRecord[] {
  if (filters.pullRequestState !== "all" && filters.pullRequestState !== state) {
    return [];
  }

  return pullRequests.filter((pullRequest) =>
    matchesRepository(formatRepositoryKey(pullRequest), filters.repository),
  );
}

function matchesPullRequestState(
  isTracked: boolean | null,
  filter: PullRequestStateFilter,
): boolean {
  if (filter === "all") {
    return true;
  }

  if (isTracked === null) {
    return false;
  }

  return filter === "tracked" ? isTracked : !isTracked;
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

function formatRepositoryKey(pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName">): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`;
}

function sortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
