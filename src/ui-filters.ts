import type { NotificationHistoryEntry } from "./notification-history.js";
import type { ActorClass, DecisionState } from "./normalized-event-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { RawEventsEntry } from "./raw-events.js";

export type PullRequestStateFilter = "all" | "tracked" | "inactive";

export interface UiFilterValues {
  pullRequestState: PullRequestStateFilter;
  repository: string;
  eventType: string;
  decisionState: "" | DecisionState;
  actorClass: "" | ActorClass;
  startDate: string;
  endDate: string;
}

export interface UiFilterOptions {
  repositories: string[];
  eventTypes: string[];
  decisionStates: DecisionState[];
  actorClasses: ActorClass[];
}

export interface BuildUiFilterOptionsInput {
  trackedPullRequests: PullRequestRecord[];
  inactivePullRequests: PullRequestRecord[];
  notificationHistory: NotificationHistoryEntry[];
  rawEvents: RawEventsEntry[];
}

export const DEFAULT_UI_FILTERS: UiFilterValues = {
  pullRequestState: "all",
  repository: "",
  eventType: "",
  decisionState: "",
  actorClass: "",
  startDate: "",
  endDate: "",
};

const PULL_REQUEST_STATE_FILTERS = new Set<PullRequestStateFilter>(["all", "tracked", "inactive"]);
const DECISION_STATES = new Set<DecisionState>([
  "notified",
  "notified_ai",
  "suppressed_self_action",
  "suppressed_rule",
  "notified_ai_fallback",
  "error",
]);
const ACTOR_CLASSES = new Set<ActorClass>(["self", "human_other", "bot"]);

export function readUiFilterValues(searchParams: URLSearchParams): UiFilterValues {
  const pullRequestState = searchParams.get("pr-state");
  const decisionState = searchParams.get("decision-state");
  const actorClass = searchParams.get("actor-type");

  return {
    pullRequestState: PULL_REQUEST_STATE_FILTERS.has(pullRequestState as PullRequestStateFilter)
      ? (pullRequestState as PullRequestStateFilter)
      : DEFAULT_UI_FILTERS.pullRequestState,
    repository: readTrimmedSearchParam(searchParams, "repo"),
    eventType: readTrimmedSearchParam(searchParams, "event-type"),
    decisionState: DECISION_STATES.has(decisionState as DecisionState)
      ? (decisionState as DecisionState)
      : DEFAULT_UI_FILTERS.decisionState,
    actorClass: ACTOR_CLASSES.has(actorClass as ActorClass)
      ? (actorClass as ActorClass)
      : DEFAULT_UI_FILTERS.actorClass,
    startDate: readDateSearchParam(searchParams, "start-date"),
    endDate: readDateSearchParam(searchParams, "end-date"),
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
    eventTypes: sortStrings([
      ...input.notificationHistory.flatMap((entry) => entry.eventTypes),
      ...input.rawEvents.map((entry) => entry.eventType),
    ]),
    decisionStates: sortStrings([
      ...input.notificationHistory.flatMap((entry) => entry.decisionStates),
      ...input.rawEvents.flatMap((entry) => (entry.decisionState ? [entry.decisionState] : [])),
    ]) as DecisionState[],
    actorClasses: sortStrings([
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

    if (!matchesMultiValue(entry.eventTypes, filters.eventType)) {
      return false;
    }

    if (!matchesMultiValue(entry.decisionStates, filters.decisionState)) {
      return false;
    }

    if (!matchesMultiValue(entry.actorClasses, filters.actorClass)) {
      return false;
    }

    return matchesDateRange(entry.createdAt, filters.startDate, filters.endDate);
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

    if (!matchesSingleValue(entry.eventType, filters.eventType)) {
      return false;
    }

    if (!matchesOptionalValue(entry.decisionState, filters.decisionState)) {
      return false;
    }

    if (!matchesOptionalValue(entry.actorClass, filters.actorClass)) {
      return false;
    }

    return matchesDateRange(entry.occurredAt, filters.startDate, filters.endDate);
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

function matchesSingleValue(value: string, filterValue: string): boolean {
  return filterValue.length === 0 || value === filterValue;
}

function matchesOptionalValue(value: string | null, filterValue: string): boolean {
  return filterValue.length === 0 || value === filterValue;
}

function matchesMultiValue(values: readonly string[], filterValue: string): boolean {
  return filterValue.length === 0 || values.includes(filterValue);
}

function matchesDateRange(value: string, startDate: string, endDate: string): boolean {
  const timestamp = readTimestamp(value);

  if (timestamp === null) {
    return false;
  }

  if (startDate.length > 0) {
    const startTimestamp = Date.parse(`${startDate}T00:00:00.000Z`);

    if (Number.isFinite(startTimestamp) && timestamp < startTimestamp) {
      return false;
    }
  }

  if (endDate.length > 0) {
    const endTimestamp = Date.parse(`${endDate}T23:59:59.999Z`);

    if (Number.isFinite(endTimestamp) && timestamp > endTimestamp) {
      return false;
    }
  }

  return true;
}

function readTimestamp(value: string): number | null {
  const normalizedValue = value.includes("T")
    ? value.endsWith("Z")
      ? value
      : `${value}Z`
    : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalizedValue);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function readTrimmedSearchParam(searchParams: URLSearchParams, key: string): string {
  return searchParams.get(key)?.trim() ?? "";
}

function readDateSearchParam(searchParams: URLSearchParams, key: string): string {
  const value = readTrimmedSearchParam(searchParams, key);

  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function formatRepositoryKey(pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName">): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`;
}

function sortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
