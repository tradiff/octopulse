import type { ActorClass } from "./normalized-event-repository.js";

export interface ActivityFeedFilters {
  pullRequestState: "all" | "tracked" | "inactive";
  repository: string;
  actorClass: "" | ActorClass;
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
