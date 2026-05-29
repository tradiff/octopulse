import type { RecentLogEntry } from "./logger.js";
import type { NotificationHistoryEntry } from "./notification-history.js";
import type { PullRequestCiJobStatesByPullRequest, PullRequestReviewStatesByPullRequest, PullRequestTimeline } from "./raw-events.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import {
  buildActivityApiPath,
  buildLogsApiPath,
  type LogLevelFilter,
  type RouteState,
} from "./client-route-state.js";

export interface PaginationState {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface PullRequestBasePageData {
  trackedPullRequests: PullRequestRecord[];
  inactivePullRequests: PullRequestRecord[];
}

export interface PullRequestsPageData extends PullRequestBasePageData {
  timelineByPullRequest: PullRequestTimeline;
  reviewStatesByPullRequest: PullRequestReviewStatesByPullRequest;
  ciJobStatesByPullRequest: PullRequestCiJobStatesByPullRequest;
}

export interface NotificationHistoryPageData extends PullRequestBasePageData {
  notificationHistory: NotificationHistoryEntry[];
  pagination: PaginationState;
}

export async function loadPullRequestBasePageData(
  fetcher: typeof apiFetch = apiFetch,
): Promise<PullRequestBasePageData> {
  const [trackedResponse, inactiveResponse] = await Promise.all([
    fetcher<{ pullRequests: PullRequestRecord[] }>("/api/tracked-pull-requests"),
    fetcher<{ pullRequests: PullRequestRecord[] }>("/api/inactive-pull-requests"),
  ]);

  return {
    trackedPullRequests: trackedResponse.pullRequests,
    inactivePullRequests: inactiveResponse.pullRequests,
  };
}

export async function loadPullRequestsPageData(
  fetcher: typeof apiFetch = apiFetch,
): Promise<PullRequestsPageData> {
  const [baseData, pullRequestTimelineResponse] = await Promise.all([
    loadPullRequestBasePageData(fetcher),
    fetcher<{
      timelineByPullRequest: PullRequestTimeline;
      reviewStatesByPullRequest: PullRequestReviewStatesByPullRequest;
      ciJobStatesByPullRequest: PullRequestCiJobStatesByPullRequest;
    }>("/api/pull-request-timeline"),
  ]);

  return {
    ...baseData,
    timelineByPullRequest: pullRequestTimelineResponse.timelineByPullRequest,
    reviewStatesByPullRequest: pullRequestTimelineResponse.reviewStatesByPullRequest,
    ciJobStatesByPullRequest: pullRequestTimelineResponse.ciJobStatesByPullRequest,
  };
}

export async function loadNotificationHistoryPageData(
  routeState: Pick<RouteState, "uiFilters" | "activityPage">,
  fetcher: typeof apiFetch = apiFetch,
): Promise<NotificationHistoryPageData> {
  const [baseData, notificationHistoryResponse] = await Promise.all([
    loadPullRequestBasePageData(fetcher),
    fetcher<{ notificationHistory: NotificationHistoryEntry[]; pagination: PaginationState }>(
      buildActivityApiPath("/api/notification-history", routeState.uiFilters, routeState.activityPage),
    ),
  ]);

  return {
    ...baseData,
    notificationHistory: notificationHistoryResponse.notificationHistory,
    pagination: notificationHistoryResponse.pagination,
  };
}

export async function loadLogsData(
  logLevelFilter: LogLevelFilter,
  fetcher: typeof apiFetch = apiFetch,
): Promise<RecentLogEntry[]> {
  const response = await fetcher<{ logs: RecentLogEntry[] }>(buildLogsApiPath(logLevelFilter));
  return response.logs;
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as unknown;

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed: ${response.status}`;

    throw new Error(message);
  }

  return body as T;
}
