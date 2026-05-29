import {
  DEFAULT_ACTIVITY_PAGE_SIZE,
  isAllPullRequestStateFilterSelection,
  normalizePullRequestStateFilters,
  type PullRequestStateFilter,
} from "./activity-feed.js";
import {
  DEFAULT_LANDING_UI_FILTERS,
  DEFAULT_UI_FILTERS,
  readUiFilterValues,
  type UiFilterValues,
} from "./ui-filters.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogLevelFilter = "all" | LogLevel;
export type AppPage = "pull-requests" | "logs" | "notification-history";
export type PrSubTab = "my-prs" | "review-requested";

export interface RouteState {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  logLevelFilter: LogLevelFilter;
  activityPage: number;
  prSubTab: PrSubTab;
}

type PageFilterField = keyof UiFilterValues;

const PULL_REQUEST_FILTER_FIELDS: readonly PageFilterField[] = ["pullRequestStates", "repository"];
const ACTIVITY_FILTER_FIELDS: readonly PageFilterField[] = ["pullRequestStates", "repository", "actorClass"];

export const APP_PAGES: readonly AppPage[] = [
  "pull-requests",
  "notification-history",
  "logs",
];
export const DEFAULT_ACTIVITY_PAGE = 1;
export const EMPTY_PAGINATION_STATE = {
  page: DEFAULT_ACTIVITY_PAGE,
  pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
  totalCount: 0,
  totalPages: 1,
};

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function readRouteState(url: URL): RouteState {
  return {
    currentPage: readDocumentPage(url.pathname),
    uiFilters: readUiFilterValues(url.searchParams, DEFAULT_LANDING_UI_FILTERS),
    logLevelFilter: readLogLevelFilter(url.searchParams),
    activityPage: readActivityPage(url.searchParams),
    prSubTab: readPrSubTab(url.searchParams),
  };
}

export function buildLogsApiPath(logLevelFilter: LogLevelFilter): string {
  return logLevelFilter === "all" ? "/api/logs" : `/api/logs?level=${logLevelFilter}`;
}

export function buildActivityApiPath(path: string, uiFilters: UiFilterValues, page: number): string {
  const searchParams = new URLSearchParams();

  appendUiFilters(searchParams, ACTIVITY_FILTER_FIELDS, uiFilters);

  if (page > DEFAULT_ACTIVITY_PAGE) {
    searchParams.set("page", String(page));
  }

  const search = searchParams.toString();

  return search.length > 0 ? `${path}?${search}` : path;
}

export function countActivePageFilters(
  filters: UiFilterValues,
  page: AppPage,
  logLevelFilter: LogLevelFilter,
): number {
  if (page === "logs") {
    return logLevelFilter === "all" ? 0 : 1;
  }

  let count = 0;

  for (const field of getPageFilterFields(page)) {
    if (field === "pullRequestStates") {
      if (!isAllPullRequestStateFilterSelection(filters.pullRequestStates)) {
        count += 1;
      }

      continue;
    }

    if (filters[field] !== DEFAULT_UI_FILTERS[field]) {
      count += 1;
    }
  }

  return count;
}

export function buildPageHref(
  page: AppPage,
  uiFilters: UiFilterValues,
  logLevelFilter: LogLevelFilter,
  prSubTab?: PrSubTab,
): string {
  if (page === "logs") {
    return buildLogViewerHref(logLevelFilter);
  }

  const searchParams = new URLSearchParams();

  appendUiFilters(searchParams, getPageFilterFields(page), uiFilters);

  if (page === "pull-requests" && prSubTab && prSubTab !== "my-prs") {
    searchParams.set("tab", prSubTab);
  }

  const pagePath = formatPagePath(page);
  const search = searchParams.toString();

  return search.length > 0 ? `${pagePath}?${search}` : pagePath;
}

export function buildActivityPageHref(
  page: "notification-history",
  uiFilters: UiFilterValues,
  activityPage: number,
): string {
  const searchParams = new URLSearchParams();

  appendUiFilters(searchParams, getPageFilterFields(page), uiFilters);

  if (activityPage > DEFAULT_ACTIVITY_PAGE) {
    searchParams.set("page", String(activityPage));
  }

  const pagePath = formatPagePath(page);
  const search = searchParams.toString();

  return search.length > 0 ? `${pagePath}?${search}` : pagePath;
}

export function buildLogViewerHref(logLevelFilter: LogLevelFilter): string {
  if (logLevelFilter === "all") {
    return "/logs";
  }

  return `/logs?level=${logLevelFilter}`;
}

export function formatPagePath(page: AppPage): string {
  if (page === "pull-requests") {
    return "/";
  }

  return `/${page}`;
}

export function formatPageLabel(page: AppPage): string {
  if (page === "pull-requests") {
    return "Pull Requests";
  }

  if (page === "logs") {
    return "Logs";
  }

  if (page === "notification-history") {
    return "Notification History";
  }

  return "Logs";
}

export function formatPullRequestEmptyMessage(
  uiFilters: UiFilterValues,
  hasActiveFilters: boolean,
): string {
  if (!hasActiveFilters) {
    return "No pull requests yet.";
  }

  const [selectedFilter] = uiFilters.pullRequestStates;

  if (uiFilters.pullRequestStates.length !== 1 || selectedFilter === undefined) {
    return "No pull requests match current filters.";
  }

  if (selectedFilter === "tracked") {
    return "No tracked pull requests match current filters.";
  }

  if (selectedFilter === "inactive") {
    return "No untracked pull requests match current filters.";
  }

  if (selectedFilter === "open") {
    return "No open pull requests match current filters.";
  }

  if (selectedFilter === "merged") {
    return "No merged pull requests match current filters.";
  }

  if (selectedFilter === "closed") {
    return "No closed pull requests match current filters.";
  }

  return "No pull requests match current filters.";
}

export function togglePullRequestStateSelection(
  selectedFilters: readonly PullRequestStateFilter[],
  filter: PullRequestStateFilter,
): PullRequestStateFilter[] {
  return normalizePullRequestStateFilters(
    selectedFilters.includes(filter)
      ? selectedFilters.filter((item) => item !== filter)
      : [...selectedFilters, filter],
  );
}

function readPrSubTab(searchParams: URLSearchParams): PrSubTab {
  return searchParams.get("tab") === "review-requested" ? "review-requested" : "my-prs";
}

function readDocumentPage(pathname: string): AppPage {
  if (pathname === "/logs") {
    return "logs";
  }

  if (pathname === "/notification-history") {
    return "notification-history";
  }

  return "pull-requests";
}

function readLogLevelFilter(searchParams: URLSearchParams): LogLevelFilter {
  const value = searchParams.get("level");

  if (value === null || value === "all") {
    return "all";
  }

  return isLogLevel(value) ? value : "all";
}

function readActivityPage(searchParams: URLSearchParams): number {
  const value = searchParams.get("page");

  if (value === null) {
    return DEFAULT_ACTIVITY_PAGE;
  }

  const numericValue = Number(value);

  return Number.isSafeInteger(numericValue) && numericValue > 0 ? numericValue : DEFAULT_ACTIVITY_PAGE;
}

function getPageFilterFields(page: AppPage): readonly PageFilterField[] {
  if (page === "pull-requests") {
    return PULL_REQUEST_FILTER_FIELDS;
  }

  if (page === "logs") {
    return [];
  }

  return ACTIVITY_FILTER_FIELDS;
}

function formatFilterSearchParamKey(field: PageFilterField): string {
  switch (field) {
    case "pullRequestStates":
      return "pr-state";
    case "repository":
      return "repo";
    case "actorClass":
      return "actor-type";
  }

  throw new Error(`Unsupported filter field: ${field}`);
}

function appendUiFilters(
  searchParams: URLSearchParams,
  fields: readonly PageFilterField[],
  uiFilters: UiFilterValues,
): void {
  let appendedFilter = false;

  for (const field of fields) {
    if (field === "pullRequestStates") {
      if (isAllPullRequestStateFilterSelection(uiFilters.pullRequestStates)) {
        continue;
      }

      for (const filter of uiFilters.pullRequestStates) {
        searchParams.append(formatFilterSearchParamKey(field), filter);
      }

      appendedFilter = true;
      continue;
    }

    const value = uiFilters[field];

    if (value === DEFAULT_UI_FILTERS[field]) {
      continue;
    }

    searchParams.set(formatFilterSearchParamKey(field), value);
    appendedFilter = true;
  }

  if (!appendedFilter && fields.includes("pullRequestStates")) {
    searchParams.set(formatFilterSearchParamKey("pullRequestStates"), "all");
  }
}
