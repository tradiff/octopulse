import type { ActorClass } from "./normalized-event-repository.js";
import type { PullRequestLifecycleState } from "./pull-request-state.js";

export type PullRequestStateFilter = "all" | "tracked" | "inactive" | PullRequestLifecycleState;

export interface ActivityFeedFilters {
  pullRequestState: PullRequestStateFilter;
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
  pullRequestState: "all",
  repository: "",
  actorClass: "",
};

export const DEFAULT_ACTIVITY_PAGE_SIZE = 50;

export function matchesPullRequestStateFilter(
  filter: PullRequestStateFilter,
  input: PullRequestStateFilterMatchInput,
): boolean {
  if (filter === "all") {
    return true;
  }

  if (filter === "tracked" || filter === "inactive") {
    if (input.isTracked === null) {
      return false;
    }

    return filter === "tracked" ? input.isTracked : !input.isTracked;
  }

  return input.pullRequestStatus === filter;
}

export function buildPullRequestStateSqlFilter(
  filter: PullRequestStateFilter,
  columns: PullRequestStateSqlColumns,
): { clauses: string[]; parameters: Array<number | string> } {
  if (filter === "all") {
    return {
      clauses: [],
      parameters: [],
    };
  }

  if (filter === "tracked" || filter === "inactive") {
    return {
      clauses: [`${columns.tracked} = ?`],
      parameters: [filter === "tracked" ? 1 : 0],
    };
  }

  if (filter === "merged") {
    return {
      clauses: [`${columns.mergedAt} IS NOT NULL`],
      parameters: [],
    };
  }

  if (filter === "closed") {
    return {
      clauses: [`${columns.mergedAt} IS NULL`, `LOWER(${columns.state}) = 'closed'`],
      parameters: [],
    };
  }

  return {
    clauses: [`${columns.mergedAt} IS NULL`, `LOWER(${columns.state}) <> 'closed'`],
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
