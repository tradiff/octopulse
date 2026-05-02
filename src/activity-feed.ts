import type { ActorClass } from "./normalized-event-repository.js";
import type { PullRequestLifecycleState } from "./pull-request-state.js";

export type PullRequestTrackingFilter = "tracked" | "inactive";
export type PullRequestStateFilter = "tracked" | "inactive" | PullRequestLifecycleState;

const TRACKING_FILTER_VALUES = ["tracked", "inactive"] satisfies PullRequestTrackingFilter[];
const LIFECYCLE_FILTER_VALUES = ["open", "merged", "closed"] satisfies PullRequestLifecycleState[];
export const PULL_REQUEST_STATE_FILTER_VALUES = [
  "tracked",
  "inactive",
  "open",
  "merged",
  "closed",
] satisfies PullRequestStateFilter[];

export interface ActivityFeedFilters {
  pullRequestStates: PullRequestStateFilter[];
  repository: string;
  actorClass: "" | ActorClass;
}

export interface PullRequestStateFilterMatchInput {
  isTracked: boolean | null;
  pullRequestStatus: PullRequestLifecycleState | null;
}

export interface PullRequestStateSqlColumns {
  tracked: string;
  state: string;
  mergedAt: string;
}

export interface ListActivityFeedOptions {
  filters?: ActivityFeedFilters;
  page?: number;
  pageSize?: number;
}

export interface PaginatedEntries<T> {
  entries: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface PaginationWindow {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  limit: number;
  offset: number;
}

export const DEFAULT_ACTIVITY_FEED_FILTERS: ActivityFeedFilters = {
  pullRequestStates: [],
  repository: "",
  actorClass: "",
};

export const DEFAULT_ACTIVITY_PAGE_SIZE = 50;

export function matchesPullRequestStateFilter(
  filter: PullRequestStateFilter,
  input: PullRequestStateFilterMatchInput,
): boolean {
  if (filter === "tracked" || filter === "inactive") {
    if (input.isTracked === null) {
      return false;
    }

    return filter === "tracked" ? input.isTracked : !input.isTracked;
  }

  return input.pullRequestStatus === filter;
}

export function matchesPullRequestStateFilters(
  filters: readonly PullRequestStateFilter[],
  input: PullRequestStateFilterMatchInput,
): boolean {
  const { trackingFilters, lifecycleFilters } = splitPullRequestStateFilters(filters);

  return (
    matchesPullRequestStateFilterCategory(trackingFilters, TRACKING_FILTER_VALUES, input)
    && matchesPullRequestStateFilterCategory(lifecycleFilters, LIFECYCLE_FILTER_VALUES, input)
  );
}

export function buildPullRequestStateSqlFilter(
  filters: readonly PullRequestStateFilter[],
  columns: PullRequestStateSqlColumns,
): { clauses: string[]; parameters: Array<number | string> } {
  if (isAllPullRequestStateFilterSelection(filters)) {
    return {
      clauses: [],
      parameters: [],
    };
  }

  const { trackingFilters, lifecycleFilters } = splitPullRequestStateFilters(filters);
  const clauses: string[] = [];
  const parameters: Array<number | string> = [];

  appendPullRequestStateSqlClause(clauses, parameters, trackingFilters, TRACKING_FILTER_VALUES, columns);
  appendPullRequestStateSqlClause(clauses, parameters, lifecycleFilters, LIFECYCLE_FILTER_VALUES, columns);

  return {
    clauses,
    parameters,
  };
}

export function normalizePullRequestStateFilters(
  filters: readonly PullRequestStateFilter[],
): PullRequestStateFilter[] {
  const selectedFilters = new Set(filters);

  return PULL_REQUEST_STATE_FILTER_VALUES.filter((filter) => selectedFilters.has(filter));
}

export function isAllPullRequestStateFilterSelection(
  filters: readonly PullRequestStateFilter[],
): boolean {
  const { trackingFilters, lifecycleFilters } = splitPullRequestStateFilters(filters);

  return (
    isPullRequestStateFilterCategoryNoOp(trackingFilters, TRACKING_FILTER_VALUES)
    && isPullRequestStateFilterCategoryNoOp(lifecycleFilters, LIFECYCLE_FILTER_VALUES)
  );
}

function splitPullRequestStateFilters(filters: readonly PullRequestStateFilter[]): {
  trackingFilters: PullRequestTrackingFilter[];
  lifecycleFilters: PullRequestLifecycleState[];
} {
  const normalizedFilters = normalizePullRequestStateFilters(filters);

  return {
    trackingFilters: normalizedFilters.filter(isPullRequestTrackingFilter),
    lifecycleFilters: normalizedFilters.filter(
      (filter): filter is PullRequestLifecycleState => !isPullRequestTrackingFilter(filter),
    ),
  };
}

function matchesPullRequestStateFilterCategory<TFilter extends PullRequestStateFilter>(
  filters: readonly TFilter[],
  allFilters: readonly TFilter[],
  input: PullRequestStateFilterMatchInput,
): boolean {
  return (
    isPullRequestStateFilterCategoryNoOp(filters, allFilters)
    || filters.some((filter) => matchesPullRequestStateFilter(filter, input))
  );
}

function appendPullRequestStateSqlClause<TFilter extends PullRequestStateFilter>(
  clauses: string[],
  parameters: Array<number | string>,
  filters: readonly TFilter[],
  allFilters: readonly TFilter[],
  columns: PullRequestStateSqlColumns,
): void {
  if (isPullRequestStateFilterCategoryNoOp(filters, allFilters)) {
    return;
  }

  const conditions = filters.map((filter) => buildPullRequestStateSqlCondition(filter, columns));

  clauses.push(`(${conditions.map(({ clause }) => `(${clause})`).join(" OR ")})`);
  parameters.push(...conditions.flatMap((condition) => condition.parameters));
}

function isPullRequestStateFilterCategoryNoOp<TFilter extends PullRequestStateFilter>(
  filters: readonly TFilter[],
  allFilters: readonly TFilter[],
): boolean {
  return filters.length === 0 || filters.length === allFilters.length;
}

function isPullRequestTrackingFilter(filter: PullRequestStateFilter): filter is PullRequestTrackingFilter {
  return filter === "tracked" || filter === "inactive";
}

function buildPullRequestStateSqlCondition(
  filter: PullRequestStateFilter,
  columns: PullRequestStateSqlColumns,
): { clause: string; parameters: Array<number | string> } {
  if (filter === "tracked" || filter === "inactive") {
    return {
      clause: `${columns.tracked} = ?`,
      parameters: [filter === "tracked" ? 1 : 0],
    };
  }

  if (filter === "merged") {
    return {
      clause: `${columns.mergedAt} IS NOT NULL`,
      parameters: [],
    };
  }

  if (filter === "closed") {
    return {
      clause: `${columns.mergedAt} IS NULL AND LOWER(${columns.state}) = 'closed'`,
      parameters: [],
    };
  }

  return {
    clause: `${columns.mergedAt} IS NULL AND LOWER(${columns.state}) <> 'closed'`,
    parameters: [],
  };
}

export function resolvePaginationWindow(
  totalCount: number,
  requestedPage: number,
  pageSize: number,
): PaginationWindow {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_ACTIVITY_PAGE_SIZE;
  const safeRequestedPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const page = Math.min(safeRequestedPage, totalPages);

  return {
    page,
    pageSize: safePageSize,
    totalCount,
    totalPages,
    limit: safePageSize,
    offset: (page - 1) * safePageSize,
  };
}
