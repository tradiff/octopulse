import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import { Highlight, themes } from "prism-react-renderer";

import {
  DEFAULT_ACTIVITY_PAGE_SIZE,
  isAllPullRequestStateFilterSelection,
  normalizePullRequestStateFilters,
  type PullRequestStateFilter,
} from "./activity-feed.js";
import type { RecentLogEntry } from "./logger.js";
import type { NotificationHistoryEntry } from "./notification-history.js";
import { resolvePullRequestStateAssetUrlPath } from "./pull-request-state.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { PullRequestReviewStateRecord, ReviewState } from "./pull-request-review-state-repository.js";
import type { PullRequestCiJobStateRecord } from "./pull-request-ci-job-state-repository.js";
import type { PullRequestTimeline, PullRequestTimelineEntry, PullRequestReviewStatesByPullRequest, PullRequestCiJobStatesByPullRequest } from "./raw-events.js";
import {
  DEFAULT_UI_FILTERS,
  buildUiFilterOptions,
  filterInactivePullRequests,
  filterNotificationHistory,
  filterTrackedPullRequests,
  readUiFilterValues,
  type UiFilterOptions,
  type UiFilterValues,
} from "./ui-filters.js";

interface AppFlashMessage {
  kind: "success" | "error";
  text: string;
}

interface PaginationState {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

type LogLevel = "debug" | "info" | "warn" | "error";
type LogLevelFilter = "all" | LogLevel;
type AppPage = "pull-requests" | "logs" | "notification-history";

type PrSubTab = "my-prs" | "review-requested";

interface RouteState {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  logLevelFilter: LogLevelFilter;
  activityPage: number;
  prSubTab: PrSubTab;
}

type PageFilterField = keyof UiFilterValues;

const ROOT = document.querySelector("#root");
const PULL_REQUEST_FILTER_FIELDS: readonly PageFilterField[] = ["pullRequestStates", "repository"];
const ACTIVITY_FILTER_FIELDS: readonly PageFilterField[] = ["pullRequestStates", "repository", "actorClass"];
const PULL_REQUEST_FILTER_PILLS: readonly { value: PullRequestStateFilter; label: string }[] = [
  { value: "tracked", label: "Tracked" },
  { value: "inactive", label: "Untracked" },
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
];
const APP_PAGES: readonly AppPage[] = [
  "pull-requests",
  "notification-history",
  "logs",
];
const DEFAULT_ACTIVITY_PAGE = 1;
const EMPTY_PAGINATION_STATE: PaginationState = {
  page: DEFAULT_ACTIVITY_PAGE,
  pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
  totalCount: 0,
  totalPages: 1,
};
const SQLITE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const NAIVE_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const HISTORY_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
const HISTORY_RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
  style: "long",
});
const RAW_EVENT_JSON_THEME = {
  ...themes.oneDark,
  plain: {
    ...themes.oneDark.plain,
    backgroundColor: "transparent",
    background: "transparent",
    color: "#cbd5e1",
  },
};
const PULL_REQUEST_COMMENTER_EVENT_TYPES = new Set([
  "issue_comment",
  "review_inline_comment",
  "review_submitted",
  "review_approved",
  "review_changes_requested",
]);

type PullRequestInteractionGroupKind = "approvers" | "commenters" | "decliners";

interface PullRequestInteractionActor {
  login: string;
  avatarUrl: string | null;
}

interface PullRequestInteractionGroup {
  kind: PullRequestInteractionGroupKind;
  label: string;
  actors: PullRequestInteractionActor[];
}

function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

if (!(ROOT instanceof HTMLElement)) {
  throw new Error("Missing root element");
}

createRoot(ROOT).render(<App />);

function App() {
  const [route, setRoute] = useState<RouteState>(() => readRouteState(new URL(window.location.href)));
  const [trackedPullRequests, setTrackedPullRequests] = useState<PullRequestRecord[]>([]);
  const [inactivePullRequests, setInactivePullRequests] = useState<PullRequestRecord[]>([]);
  const [notificationHistory, setNotificationHistory] = useState<NotificationHistoryEntry[]>([]);
  const [timelineByPullRequest, setTimelineByPullRequest] = useState<PullRequestTimeline>({});
  const [reviewStatesByPullRequest, setReviewStatesByPullRequest] = useState<PullRequestReviewStatesByPullRequest>({});
  const [ciJobStatesByPullRequest, setCiJobStatesByPullRequest] = useState<PullRequestCiJobStatesByPullRequest>({});
  const [notificationHistoryPagination, setNotificationHistoryPagination] =
    useState<PaginationState>(EMPTY_PAGINATION_STATE);
  const [recentLogs, setRecentLogs] = useState<RecentLogEntry[]>([]);
  const manualTrackDialogRef = useRef<HTMLDialogElement | null>(null);
  const [trackFormUrl, setTrackFormUrl] = useState("");
  const [isManualTrackDialogOpen, setIsManualTrackDialogOpen] = useState(false);
  const [trackFormMessage, setTrackFormMessage] = useState<AppFlashMessage | undefined>(undefined);
  const [flashMessage, setFlashMessage] = useState<AppFlashMessage | undefined>(undefined);
  const [currentUserLogin, setCurrentUserLogin] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{ login: string | null }>("/api/me").then((res) => {
      setCurrentUserLogin(res.login);
    });
  }, []);

  useEffect(() => {
    const handlePopState = (): void => {
      setRoute(readRouteState(new URL(window.location.href)));
      setFlashMessage(undefined);
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (route.currentPage === "logs") {
      void loadLogs(route.logLevelFilter);
      return;
    }

    void loadCurrentPageData(route);
  }, [route]);

  useEffect(() => {
    if (route.currentPage === "pull-requests") {
      return;
    }

    setIsManualTrackDialogOpen(false);
    setTrackFormMessage(undefined);
    setTrackFormUrl("");
  }, [route.currentPage]);

  useEffect(() => {
    const dialog = manualTrackDialogRef.current;

    if (dialog === null) {
      return;
    }

    if (isManualTrackDialogOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }

      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [isManualTrackDialogOpen]);

  const uiFilterOptions = useMemo(
    () =>
      buildUiFilterOptions({
        trackedPullRequests,
        inactivePullRequests,
        notificationHistory,
      }),
    [trackedPullRequests, inactivePullRequests, notificationHistory],
  );

  const filteredTrackedPullRequests = useMemo(
    () => filterTrackedPullRequests(trackedPullRequests, route.uiFilters),
    [trackedPullRequests, route.uiFilters],
  );
  const filteredInactivePullRequests = useMemo(
    () => filterInactivePullRequests(inactivePullRequests, route.uiFilters),
    [inactivePullRequests, route.uiFilters],
  );
  const sortedPullRequests = useMemo(
    () =>
      sortPullRequestsByLatestActivity(
        [...filteredTrackedPullRequests, ...filteredInactivePullRequests],
        timelineByPullRequest,
      ),
    [filteredTrackedPullRequests, filteredInactivePullRequests, timelineByPullRequest],
  );
  const subTabPullRequests = useMemo(() => {
    if (currentUserLogin === null) return sortedPullRequests;
    if (route.prSubTab === "review-requested") {
      return sortedPullRequests.filter((pr) => pr.authorLogin !== currentUserLogin);
    }
    return sortedPullRequests.filter((pr) => pr.authorLogin === currentUserLogin);
  }, [sortedPullRequests, route.prSubTab, currentUserLogin]);
  const subTabCounts = useMemo<Record<PrSubTab, number>>(() => {
    if (currentUserLogin === null) return { "my-prs": sortedPullRequests.length, "review-requested": 0 };
    return {
      "my-prs": sortedPullRequests.filter((pr) => pr.authorLogin === currentUserLogin).length,
      "review-requested": sortedPullRequests.filter((pr) => pr.authorLogin !== currentUserLogin).length,
    };
  }, [sortedPullRequests, currentUserLogin]);
  const filteredNotificationHistory = useMemo(
    () => filterNotificationHistory(notificationHistory, route.uiFilters),
    [notificationHistory, route.uiFilters],
  );

  const hasActiveFilters = countActivePageFilters(route.uiFilters, route.currentPage, route.logLevelFilter) > 0;
  const showTopFlashMessage = flashMessage !== undefined;

  function openManualTrackDialog(): void {
    setTrackFormMessage(undefined);
    setIsManualTrackDialogOpen(true);
  }

  function closeManualTrackDialog(): void {
    setIsManualTrackDialogOpen(false);
  }

  function handleManualTrackDialogClose(): void {
    setIsManualTrackDialogOpen(false);
    setTrackFormMessage(undefined);
    setTrackFormUrl("");
  }

  async function loadCurrentPageData(routeState: RouteState): Promise<void> {
    try {
      if (routeState.currentPage === "pull-requests") {
        const [trackedResponse, inactiveResponse, pullRequestTimelineResponse] = await Promise.all([
          apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/tracked-pull-requests"),
          apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/inactive-pull-requests"),
          apiFetch<{ timelineByPullRequest: PullRequestTimeline; reviewStatesByPullRequest: PullRequestReviewStatesByPullRequest; ciJobStatesByPullRequest: PullRequestCiJobStatesByPullRequest }>("/api/pull-request-timeline"),
        ]);

        setTrackedPullRequests(trackedResponse.pullRequests);
        setInactivePullRequests(inactiveResponse.pullRequests);
        setTimelineByPullRequest(pullRequestTimelineResponse.timelineByPullRequest);
        setReviewStatesByPullRequest(pullRequestTimelineResponse.reviewStatesByPullRequest);
        setCiJobStatesByPullRequest(pullRequestTimelineResponse.ciJobStatesByPullRequest);
        return;
      }

      if (routeState.currentPage === "notification-history") {
        const [trackedResponse, inactiveResponse, notificationHistoryResponse] = await Promise.all([
          apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/tracked-pull-requests"),
          apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/inactive-pull-requests"),
          apiFetch<{ notificationHistory: NotificationHistoryEntry[]; pagination: PaginationState }>(
            buildActivityApiPath("/api/notification-history", routeState.uiFilters, routeState.activityPage),
          ),
        ]);

        setTrackedPullRequests(trackedResponse.pullRequests);
        setInactivePullRequests(inactiveResponse.pullRequests);
        setNotificationHistory(notificationHistoryResponse.notificationHistory);
        setNotificationHistoryPagination(notificationHistoryResponse.pagination);
        return;
      }

      const [trackedResponse, inactiveResponse] = await Promise.all([
        apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/tracked-pull-requests"),
        apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/inactive-pull-requests"),
      ]);

      setTrackedPullRequests(trackedResponse.pullRequests);
      setInactivePullRequests(inactiveResponse.pullRequests);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  async function loadLogs(logLevelFilter: LogLevelFilter): Promise<void> {
    try {
      const response = await apiFetch<{ logs: RecentLogEntry[] }>(buildLogsApiPath(logLevelFilter));
      setRecentLogs(response.logs);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  function navigateToHref(href: string): void {
    const nextUrl = new URL(href, window.location.origin);
    const nextLocation = `${nextUrl.pathname}${nextUrl.search}`;
    const currentLocation = `${window.location.pathname}${window.location.search}`;

    if (nextLocation !== currentLocation) {
      window.history.pushState(undefined, "", nextLocation);
    }

    setRoute(readRouteState(nextUrl));
    setFlashMessage(undefined);
  }

  async function handleTrackSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    try {
      const result = await apiFetch<{ outcome: "tracked" | "already_tracked"; pullRequest: PullRequestRecord }>(
        "/api/tracked-pull-requests",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: trackFormUrl }),
        },
      );

      setTrackFormUrl("");
      setTrackFormMessage(undefined);
      setFlashMessage(createTrackFlashMessage(result));
      await loadCurrentPageData(route);
      setIsManualTrackDialogOpen(false);
    } catch (error) {
      setTrackFormMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  async function handleUntrack(githubPullRequestId: number): Promise<void> {
    try {
      const result = await apiFetch<{ outcome: "untracked" | "already_inactive"; pullRequest: PullRequestRecord }>(
        `/api/tracked-pull-requests/${githubPullRequestId}`,
        {
          method: "DELETE",
        },
      );

      setFlashMessage(createUntrackFlashMessage(result));
      await loadCurrentPageData(route);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  async function handleRetrack(pullRequestUrl: string): Promise<void> {
    try {
      const result = await apiFetch<{ outcome: "tracked" | "already_tracked"; pullRequest: PullRequestRecord }>(
        "/api/tracked-pull-requests",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: pullRequestUrl }),
        },
      );

      setFlashMessage(createTrackFlashMessage(result));
      await loadCurrentPageData(route);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  async function handleResendNotificationRecord(notificationRecordId: number): Promise<void> {
    try {
      await apiFetch(`/api/notification-records/${notificationRecordId}/resend`, {
        method: "POST",
      });

      setFlashMessage({
        kind: "success",
        text: "Notification resent.",
      });
      await loadCurrentPageData(route);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  function handleFilterChange(event: FormEvent<HTMLFormElement>): void {
    const formData = new FormData(event.currentTarget);
    const searchParams = new URLSearchParams();

    formData.forEach((value, key) => {
      if (typeof value !== "string") {
        return;
      }

      searchParams.append(key, value);
    });

    const nextFilters = readUiFilterValues(searchParams);
    navigateToHref(buildPageHref(route.currentPage, nextFilters, route.logLevelFilter));
  }

  function handleLogsFilterChange(event: FormEvent<HTMLFormElement>): void {
    const formData = new FormData(event.currentTarget);
    const nextValue = formData.get("level");
    const nextLogLevelFilter =
      typeof nextValue === "string" && nextValue !== "all" && isLogLevel(nextValue) ? nextValue : "all";
    const nextHref = buildLogViewerHref(nextLogLevelFilter);
    const currentHref = buildLogViewerHref(route.logLevelFilter);

    if (nextHref === currentHref) {
      void loadLogs(nextLogLevelFilter);
      return;
    }

    navigateToHref(nextHref);
  }

  function handleBaseDataRefresh(): void {
    void loadCurrentPageData(route);
  }

  function handleLogsRefresh(): void {
    void loadLogs(route.logLevelFilter);
  }

  return (
    <div id="app">
      <style>{APP_STYLES}</style>
      <main>
        <h1 className="app-title">OCTO.PULSE</h1>
        <PageNavigation
          currentPage={route.currentPage}
          uiFilters={route.uiFilters}
          logLevelFilter={route.logLevelFilter}
          onNavigate={navigateToHref}
        />
        {showTopFlashMessage ? <FlashMessage message={flashMessage} /> : null}
        <div className="page-content panel">
          <FilterPanel
            currentPage={route.currentPage}
            uiFilters={route.uiFilters}
            uiFilterOptions={uiFilterOptions}
            logLevelFilter={route.logLevelFilter}
            formKey={buildPageHref(route.currentPage, route.uiFilters, route.logLevelFilter)}
            onFormChange={route.currentPage === "logs" ? handleLogsFilterChange : handleFilterChange}
            onNavigate={navigateToHref}
          />
          {route.currentPage === "pull-requests" ? (
            <PullRequestList
              title="Pull Requests"
              emptyMessage={formatPullRequestEmptyMessage(route.uiFilters, hasActiveFilters)}
              pullRequests={subTabPullRequests}
              timelineByPullRequest={timelineByPullRequest}
              reviewStatesByPullRequest={reviewStatesByPullRequest}
              ciJobStatesByPullRequest={ciJobStatesByPullRequest}
              onRefresh={handleBaseDataRefresh}
              prSubTab={route.prSubTab}
              uiFilters={route.uiFilters}
              logLevelFilter={route.logLevelFilter}
              onNavigate={navigateToHref}
              onAddClick={openManualTrackDialog}
              subTabCounts={subTabCounts}
              renderAction={(pullRequest) =>
                renderPullRequestAction(pullRequest, {
                  onUntrack: handleUntrack,
                  onRetrack: handleRetrack,
                })
              }
            />
          ) : null}
          {route.currentPage === "notification-history" ? (
            <NotificationHistoryPanel
              notificationHistory={filteredNotificationHistory}
              pagination={notificationHistoryPagination}
              hasActiveFilters={hasActiveFilters}
              uiFilters={route.uiFilters}
              onResend={handleResendNotificationRecord}
              onNavigate={navigateToHref}
              onRefresh={handleBaseDataRefresh}
            />
          ) : null}
          {route.currentPage === "logs" ? (
            <LogsPanel recentLogs={recentLogs} logLevelFilter={route.logLevelFilter} onRefresh={handleLogsRefresh} />
          ) : null}
        </div>
        {route.currentPage === "pull-requests" ? (
          <dialog
            ref={manualTrackDialogRef}
            className="manual-track-dialog"
            onCancel={handleManualTrackDialogClose}
            onClose={handleManualTrackDialogClose}
          >
            <div className="manual-track-dialog-header">
              <div>
                <h2 className="manual-track-dialog-title">Add pull request</h2>
                <p className="manual-track-description">
                  Paste GitHub pull request URL to start tracking it locally.
                </p>
              </div>
              <button
                type="button"
                className="action-button clear-filters-link manual-track-dialog-close-button"
                onClick={closeManualTrackDialog}
              >
                Close
              </button>
            </div>
            {trackFormMessage ? <FlashMessage message={trackFormMessage} /> : null}
            <form
              method="post"
              action="/tracked-pull-requests/manual-track"
              className="track-form"
              onSubmit={(event) => void handleTrackSubmit(event)}
            >
              <label className="input-label" htmlFor="pull-request-url">
                Pull request URL
              </label>
              <div className="track-form-row">
                <input
                  id="pull-request-url"
                  name="url"
                  type="url"
                  required
                  autoFocus
                  placeholder="https://github.com/octo-org/octo-repo/pull/123"
                  className="text-input"
                  value={trackFormUrl}
                  onChange={(event) => setTrackFormUrl(event.target.value)}
                />
                <button type="submit" className="action-button primary-button">
                  Track PR
                </button>
              </div>
            </form>
          </dialog>
        ) : null}
      </main>
    </div>
  );
}

function FilterPanel({
  currentPage,
  uiFilters,
  uiFilterOptions,
  logLevelFilter,
  formKey,
  onFormChange,
  onNavigate,
}: {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  uiFilterOptions: UiFilterOptions;
  logLevelFilter: LogLevelFilter;
  formKey: string;
  onFormChange: (event: FormEvent<HTMLFormElement>) => void;
  onNavigate: (href: string) => void;
}) {
  const pagePath = formatPagePath(currentPage);
  const showsActivityFilters = currentPage !== "pull-requests";
  const showsLogFilters = currentPage === "logs";
  const filtersGridClassName =
    showsActivityFilters && !showsLogFilters ? "filters-grid filters-grid-activity" : "filters-grid";

  return (
    <section className="filters-panel">
      <form
        key={formKey}
        method="get"
        action={pagePath}
        className="filters-form"
        onChange={onFormChange}
      >
        <div className={filtersGridClassName}>
          {showsLogFilters ? (
            <label className="filter-field">
              <span className="input-label">Level</span>
              <select name="level" defaultValue={logLevelFilter} className="text-input">
                <option value="all">All levels</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </label>
          ) : (
            <>
              <div className="filter-field">
                <span className="input-label">Pull request filter</span>
                {uiFilters.pullRequestStates.map((filter) => (
                  <input key={filter} type="hidden" name="pr-state" value={filter} />
                ))}
                <div className="filter-pill-group" role="group" aria-label="Pull request filter">
                  {PULL_REQUEST_FILTER_PILLS.map((pill) => {
                    const isActive = uiFilters.pullRequestStates.includes(pill.value);
                    const nextFilters = {
                      ...uiFilters,
                      pullRequestStates: togglePullRequestStateSelection(
                        uiFilters.pullRequestStates,
                        pill.value,
                      ),
                    };
                    const href = buildPageHref(currentPage, nextFilters, logLevelFilter);

                    return (
                      <button
                        key={pill.value}
                        type="button"
                        className={`filter-pill-button ${isActive ? "filter-pill-button-active" : ""}`.trim()}
                        aria-pressed={isActive}
                        onClick={() => onNavigate(href)}
                      >
                        {pill.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="filter-field">
                <span className="input-label">Repository</span>
                <select name="repo" defaultValue={uiFilters.repository} className="text-input">
                  <option value="">All repositories</option>
                  {uiFilterOptions.repositories.map((repository) => (
                    <option key={repository} value={repository}>
                      {repository}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {showsActivityFilters && !showsLogFilters ? (
            <>
              <label className="filter-field filter-field-actor">
                <span className="input-label">Actor type</span>
                <select name="actor-type" defaultValue={uiFilters.actorClass} className="text-input">
                  <option value="">All actors</option>
                  {uiFilterOptions.actorClasses.map((actorClass) => (
                    <option key={actorClass} value={actorClass}>
                      {formatActorClassLabel(actorClass)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function PageNavigation({
  currentPage,
  uiFilters,
  logLevelFilter,
  onNavigate,
}: {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  logLevelFilter: LogLevelFilter;
  onNavigate: (href: string) => void;
}) {
  return (
    <nav className="page-nav" aria-label="Octopulse pages">
      <div className="page-nav-list">
        {APP_PAGES.map((page) => {
          const isCurrentPage = page === currentPage;
          const href = buildPageHref(page, uiFilters, logLevelFilter);

          return (
            <a
              key={page}
              href={href}
              className={`page-nav-link ${isCurrentPage ? "page-nav-link-current" : ""}`.trim()}
              aria-current={isCurrentPage ? "page" : undefined}
              onClick={(event) => handleClientNavigation(event, href, onNavigate)}
            >
              {formatPageLabel(page)}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function NotificationHistoryPanel({
  notificationHistory,
  pagination,
  hasActiveFilters,
  uiFilters,
  onResend,
  onNavigate,
  onRefresh,
}: {
  notificationHistory: NotificationHistoryEntry[];
  pagination: PaginationState;
  hasActiveFilters: boolean;
  uiFilters: UiFilterValues;
  onResend: (notificationRecordId: number) => Promise<void>;
  onNavigate: (href: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="notification-history-panel">
      <ActivityPagination
        currentPage="notification-history"
        uiFilters={uiFilters}
        pagination={pagination}
        onNavigate={onNavigate}
        onRefresh={onRefresh}
        position="top"
      />
      {notificationHistory.length === 0 ? (
        <p>
          {hasActiveFilters
            ? "No notification history matches current filters."
            : "No notification history yet."}
        </p>
      ) : (
        <ul className="notification-history-list">
          {notificationHistory.map((entry) => (
            <li key={entry.id} className="notification-history-item">
              <div className="notification-history-preview">
                <div className="notification-history-preview-header-row">
                  <div className="notification-history-preview-header">
                    {entry.author ? (
                      <GitHubAvatar login={entry.author.login} avatarUrl={entry.author.avatarUrl} />
                    ) : null}
                    {entry.pullRequestStateAssetUrlPath ? (
                      <img
                        className="state-pill-icon"
                        src={entry.pullRequestStateAssetUrlPath}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : null}
                    {entry.clickUrl ? (
                      <a
                        href={entry.clickUrl}
                        className="notification-history-preview-link"
                        title={entry.title}
                      >
                        {formatNotificationHistoryHeaderText(entry)}
                      </a>
                    ) : (
                      <strong className="notification-history-preview-title" title={entry.title}>
                        {formatNotificationHistoryHeaderText(entry)}
                      </strong>
                    )}
                  </div>
                  <span className={`delivery-pill delivery-${entry.deliveryStatus}`}>
                    {formatDeliveryStatusLabel(entry.deliveryStatus)}
                  </span>
                </div>
                <div className="notification-history-preview-body">
                  <NotificationSummaryContent entry={entry} />
                </div>
                <div className="notification-history-meta-row">
                  <span className="history-pill">{formatSourceKindLabel(entry.sourceKind)}</span>
                  {entry.decisionStates.map((decisionState) => (
                    <span key={`${entry.id}-${decisionState}`} className="history-pill">
                      {formatDecisionStateLabel(decisionState)}
                    </span>
                  ))}
                  {entry.deliveredAt ? (
                    <span className="history-pill notification-history-time-pill">
                      Delivered {formatHistoryTimestamp(entry.deliveredAt)}
                    </span>
                  ) : null}
                  <form
                    className="notification-history-resend-form"
                    method="post"
                    action={`/notification-records/${entry.id}/resend`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void onResend(entry.id);
                    }}
                  >
                    <button type="submit" className="action-button small-button">
                      Resend
                    </button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ActivityPagination
        currentPage="notification-history"
        uiFilters={uiFilters}
        pagination={pagination}
        onNavigate={onNavigate}
        position="bottom"
      />
    </section>
  );
}

function ActivityPagination({
  currentPage,
  uiFilters,
  pagination,
  onNavigate,
  onRefresh,
  position = "bottom",
}: {
  currentPage: "notification-history";
  uiFilters: UiFilterValues;
  pagination: PaginationState;
  onNavigate: (href: string) => void;
  onRefresh?: () => void;
  position?: "top" | "bottom";
}) {
  if (pagination.totalCount === 0) {
    return null;
  }

  const rangeStart = (pagination.page - 1) * pagination.pageSize + 1;
  const rangeEnd = Math.min(pagination.page * pagination.pageSize, pagination.totalCount);

  return (
    <div className={`pagination-footer pagination-footer-${position}`}>
      <p className="panel-description pagination-summary">
        Showing {rangeStart}-{rangeEnd} of {pagination.totalCount}
      </p>
      {pagination.totalPages > 1 || onRefresh ? (
        <div className="pagination-controls" aria-label="Activity pagination">
          {pagination.totalPages > 1 ? (
            <>
              <button
                type="button"
                className="action-button pagination-button"
                disabled={pagination.page <= 1}
                onClick={() => onNavigate(buildActivityPageHref(currentPage, uiFilters, pagination.page - 1))}
              >
                Previous
              </button>
              <span className="pagination-status">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                className="action-button pagination-button"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => onNavigate(buildActivityPageHref(currentPage, uiFilters, pagination.page + 1))}
              >
                Next
              </button>
            </>
          ) : null}
          {onRefresh ? <RefreshButton label="Refresh notification history" onClick={onRefresh} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function HighlightedJsonBlock({
  code,
  className,
}: {
  code: string;
  className: string;
}) {
  return (
    <Highlight theme={RAW_EVENT_JSON_THEME} code={code} language="json">
      {({ className: highlightClassName, style, tokens, getLineProps, getTokenProps }) => (
        <pre className={`${className} ${highlightClassName}`} style={style}>
          <code>
            {tokens.map((line, lineIndex) => (
              <span
                key={lineIndex}
                {...getLineProps({ line, className: "raw-event-json-line" })}
              >
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </span>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}

function formatJsonForDisplay(rawJson: string): string | null {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2);
  } catch {
    return null;
  }
}

function LogsPanel({
  recentLogs,
  logLevelFilter,
  onRefresh,
}: {
  recentLogs: RecentLogEntry[];
  logLevelFilter: LogLevelFilter;
  onRefresh: () => void;
}) {
  return (
    <section className="logs-panel">
      <div className="panel-header">
        <div className="panel-header-actions">
          <RefreshButton label="Refresh logs" onClick={onRefresh} />
        </div>
      </div>
      {recentLogs.length === 0 ? (
        <p>
          {logLevelFilter === "all"
            ? "No log entries yet."
            : `No ${formatLogLevelLabel(logLevelFilter)} log entries match current filter.`}
        </p>
      ) : (
        <ul className="logs-list">
          {recentLogs.map((entry) => (
            <li key={entry.id} className="logs-item">
              {entry.context ? (
                <>
                  <details className="logs-entry-details">
                    <summary
                      className="logs-disclosure-button"
                      aria-label={`Toggle log context for ${entry.message}`}
                    >
                      <span className="logs-disclosure-marker" aria-hidden="true" />
                    </summary>
                  </details>
                  <LogEntrySummary entry={entry} />
                  <HighlightedJsonBlock
                    code={JSON.stringify(entry.context, null, 2)}
                    className="raw-event-json logs-context-json"
                  />
                </>
              ) : (
                <>
                  <span className="logs-disclosure-spacer" aria-hidden="true" />
                  <LogEntrySummary entry={entry} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LogEntrySummary({ entry }: { entry: RecentLogEntry }) {
  return (
    <>
      <span className="logs-entry-time">{formatHistoryTimestamp(entry.timestamp)}</span>
      <span className={`log-level-pill log-level-${entry.level}`}>{formatLogLevelLabel(entry.level)}</span>
      <span className="logs-entry-message">{entry.message}</span>
    </>
  );
}

function PullRequestList({
  title,
  emptyMessage,
  pullRequests,
  timelineByPullRequest,
  reviewStatesByPullRequest,
  ciJobStatesByPullRequest,
  onRefresh,
  prSubTab,
  uiFilters,
  logLevelFilter,
  onNavigate,
  onAddClick,
  subTabCounts,
  renderAction,
}: {
  title: string;
  emptyMessage: string;
  pullRequests: PullRequestRecord[];
  timelineByPullRequest: PullRequestTimeline;
  reviewStatesByPullRequest: PullRequestReviewStatesByPullRequest;
  ciJobStatesByPullRequest: PullRequestCiJobStatesByPullRequest;
  onRefresh: () => void;
  prSubTab: PrSubTab;
  uiFilters: UiFilterValues;
  logLevelFilter: LogLevelFilter;
  onNavigate: (href: string) => void;
  onAddClick: () => void;
  subTabCounts: Record<PrSubTab, number>;
  renderAction?: (pullRequest: PullRequestRecord) => ReactNode;
}) {
  const subTabs: { id: PrSubTab; label: string }[] = [
    { id: "my-prs", label: "My PRs" },
    { id: "review-requested", label: "Review Requests" },
  ];

  return (
    <section className="pull-request-panel">
      <div className="pr-sub-tab-bar" role="tablist" aria-label="Pull request view">
        {subTabs.map((tab) => {
          const isActive = prSubTab === tab.id;
          const href = buildPageHref("pull-requests", uiFilters, logLevelFilter, tab.id);
          return (
            <a
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={`pr-sub-tab${isActive ? " pr-sub-tab-active" : ""}`}
              href={href}
              onClick={(e) => handleClientNavigation(e, href, onNavigate)}
            >
              {tab.label}
              <span className="pr-sub-tab-count">{subTabCounts[tab.id]}</span>
            </a>
          );
        })}
        <div className="pr-sub-tab-bar-actions">
          <button
            type="button"
            className="action-button add-pr-button"
            onClick={onAddClick}
            title="Track a pull request by URL"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="8" y1="2" x2="8" y2="14" />
              <line x1="2" y1="8" x2="14" y2="8" />
            </svg>
            Track PR
          </button>
          <RefreshButton label="Refresh pull requests" onClick={onRefresh} />
        </div>
      </div>
      {pullRequests.length === 0 ? (
        <p>{emptyMessage}</p>
      ) : (
        <ul className="pull-request-list">
          {pullRequests.map((pullRequest) => {
            const timelineEntries = timelineByPullRequest[String(pullRequest.githubPullRequestId)] ?? [];

            return (
              <PullRequestListItem
                key={pullRequest.id}
                pullRequest={pullRequest}
                timelineEntries={timelineEntries}
                reviewStates={reviewStatesByPullRequest[String(pullRequest.githubPullRequestId)] ?? []}
                ciJobStates={ciJobStatesByPullRequest[String(pullRequest.githubPullRequestId)] ?? []}
                renderAction={renderAction}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PullRequestListItem({
  pullRequest,
  timelineEntries,
  reviewStates,
  ciJobStates,
  renderAction,
}: {
  pullRequest: PullRequestRecord;
  timelineEntries: PullRequestTimelineEntry[];
  reviewStates: PullRequestReviewStateRecord[];
  ciJobStates: PullRequestCiJobStateRecord[];
  renderAction: ((pullRequest: PullRequestRecord) => ReactNode) | undefined;
}) {
  const [isTimelineExpanded, setIsTimelineExpanded] = useState(false);
  const timelineSectionId = `pull-request-timeline-${pullRequest.githubPullRequestId}`;

  const toggleTimeline = (): void => {
    setIsTimelineExpanded((currentValue) => !currentValue);
  };

  const handleRowClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.closest("a, button, input, select, textarea, label, form, summary")) {
      return;
    }

    toggleTimeline();
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.closest("a, button, input, select, textarea, label, form, summary") && target !== event.currentTarget) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    toggleTimeline();
  };

  return (
    <li className={`pull-request-item ${isTimelineExpanded ? "pull-request-item-expanded" : ""}`.trim()}>
      <div
        className="pull-request-row pull-request-row-expandable"
        role="button"
        tabIndex={0}
        aria-expanded={isTimelineExpanded}
        aria-controls={timelineSectionId}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
      >
        <span
          className={`pull-request-expander ${isTimelineExpanded ? "pull-request-expander-expanded" : ""}`.trim()}
          aria-hidden="true"
        />
        <GitHubAvatar
          login={pullRequest.authorLogin}
          avatarUrl={pullRequest.authorAvatarUrl}
          title={`@${pullRequest.authorLogin}`}
        />
        <img
          className="state-pill-icon"
          src={resolvePullRequestStateAssetUrlPath(pullRequest)}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <span className="pull-request-repo-pill">
          {pullRequest.repositoryOwner}/{pullRequest.repositoryName} #{pullRequest.number}
        </span>
        <div className="pull-request-title">
          <div className="pull-request-title-copy">
            <a
              href={pullRequest.url}
              className="pull-request-title-link"
              title={pullRequest.title}
              target="_blank"
              rel="noreferrer"
            >
              {pullRequest.title}
            </a>
          </div>
          <PullRequestMergeReadinessIndicator pullRequest={pullRequest} />
        </div>
        <PullRequestInteractionGroups entries={timelineEntries} reviewStates={reviewStates} />
        <span className="pull-request-timeline-summary">
          {formatPullRequestTimelineSummaryLabel(timelineEntries.length)}
          {timelineEntries[0] ? (
            <time
              className="pull-request-timeline-summary-age"
              dateTime={normalizeHistoryTimestamp(timelineEntries[0].occurredAt)}
              title={formatHistoryTimestamp(timelineEntries[0].occurredAt)}
            >
              {formatRelativeHistoryTimestamp(timelineEntries[0].occurredAt)}
            </time>
          ) : null}
          {ciJobStates.length > 0 ? <CiJobStatsSummary ciJobStates={ciJobStates} /> : null}
        </span>
      </div>
      {isTimelineExpanded ? (
        <div id={timelineSectionId} className="pull-request-timeline-section">
          {renderAction ? <div className="pull-request-expanded-actions">{renderAction(pullRequest)}</div> : null}
          <PullRequestTimelineContent
            entries={timelineEntries}
            pullRequestAuthorLogin={pullRequest.authorLogin}
            pullRequestAuthorAvatarUrl={pullRequest.authorAvatarUrl}
          />
          {ciJobStates.length > 0 ? <CiJobStateList ciJobStates={ciJobStates} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function formatPullRequestTimelineSummaryLabel(eventCount: number): string {
  if (eventCount === 0) {
    return "No activity";
  }

  return `${eventCount} ${eventCount === 1 ? "event" : "events"}`;
}

function PullRequestMergeReadinessIndicator({
  pullRequest,
}: {
  pullRequest: Pick<PullRequestRecord, "state" | "mergeableState" | "requestedReviewTeamSlugs">;
}) {
  const indicator = readPullRequestMergeReadinessIndicator(pullRequest);

  if (indicator === null) {
    return null;
  }

  return (
    <span
      className={`pull-request-merge-readiness pull-request-merge-readiness-${indicator.tone}`}
      role="img"
      aria-label={indicator.label}
      title={indicator.label}
    >
      <PullRequestMergeReadinessIcon kind={indicator.icon} />
    </span>
  );
}

function readPullRequestMergeReadinessIndicator(
  pullRequest: Pick<PullRequestRecord, "state" | "mergeableState" | "requestedReviewTeamSlugs">,
): {
  tone: "ready" | "attention" | "danger" | "info" | "muted";
  icon: "check" | "minus" | "x" | "arrow" | "clock";
  label: string;
} | null {
  if (pullRequest.state !== "open" || pullRequest.mergeableState === null) {
    return null;
  }

  switch (pullRequest.mergeableState) {
    case "clean":
      return { tone: "ready", icon: "check", label: "Ready to merge" };
    case "blocked":
      return {
        tone: "attention",
        icon: "minus",
        label: readBlockedMergeStateLabel(pullRequest.requestedReviewTeamSlugs),
      };
    case "behind":
      return { tone: "info", icon: "arrow", label: "Branch is behind the base branch" };
    case "dirty":
      return { tone: "danger", icon: "x", label: "Merge conflicts detected" };
    case "unstable":
      return {
        tone: "attention",
        icon: "clock",
        label: "Required merge checks are failing or still pending",
      };
    case "has_hooks":
      return {
        tone: "attention",
        icon: "clock",
        label: "Waiting on required merge hooks",
      };
    case "unknown":
      return {
        tone: "muted",
        icon: "clock",
        label: "Merge readiness is still being calculated",
      };
    case "draft":
      return { tone: "muted", icon: "clock", label: "Draft pull request" };
    default:
      return {
        tone: "muted",
        icon: "clock",
        label: `GitHub merge status: ${formatMergeableStateLabel(pullRequest.mergeableState)}`,
      };
  }
}

function PullRequestMergeReadinessIcon({
  kind,
}: {
  kind: "check" | "minus" | "x" | "arrow" | "clock";
}) {
  if (kind === "check") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6.8 10.3 8.9 12.4 13.2 8.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (kind === "minus") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6.7 10h6.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "x") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M7.3 7.3 12.7 12.7M12.7 7.3 7.3 12.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (kind === "arrow") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M7.2 12.8 12.8 7.2M9.1 7.2h3.7v3.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 6.4v4.1l2.4 1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatMergeableStateLabel(mergeableState: string): string {
  return mergeableState
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function readBlockedMergeStateLabel(requestedReviewTeamSlugs: string[]): string {
  if (requestedReviewTeamSlugs.length === 0) {
    return "Merge blocked by GitHub rules";
  }

  const teamLabel =
    requestedReviewTeamSlugs.length === 1
      ? `team ${requestedReviewTeamSlugs[0]}`
      : `teams ${requestedReviewTeamSlugs.join(", ")}`;

  return `Merge blocked: waiting on review from ${teamLabel}`;
}

function CiJobStatsSummary({ ciJobStates }: { ciJobStates: PullRequestCiJobStateRecord[] }) {
  const counts = readCiSummaryCounts(ciJobStates);
  const tooltip = buildCiSummaryTooltip(counts);
  const parts: React.ReactNode[] = [];

  if (counts.failing > 0) {
    parts.push(
      <span key="f" className="ci-job-stats-failing">
        {counts.failing}
      </span>,
    );
  }

  if (counts.pending > 0) {
    parts.push(
      <span key="p" className="ci-job-stats-pending">
        {counts.pending}
      </span>,
    );
  }

  if (counts.passing > 0) {
    parts.push(
      <span key="ok" className="ci-job-stats-passing">
        {counts.passing}
      </span>,
    );
  }

  if (counts.skipped > 0) {
    parts.push(
      <span key="s" className="ci-job-stats-skipped">
        {counts.skipped}
      </span>,
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <span className="ci-job-stats" title={tooltip} aria-label={tooltip}>
      <span className="ci-job-stats-label">CI:</span>
      {parts.reduce<React.ReactNode[]>((acc, part, index) => {
        if (index === 0) {
          return [part];
        }

        return [
          ...acc,
          <span key={`sep-${index}`} className="ci-job-stats-separator" aria-hidden="true">
            |
          </span>,
          part,
        ];
      }, [])}
    </span>
  );
}

function CiJobStateList({ ciJobStates }: { ciJobStates: PullRequestCiJobStateRecord[] }) {
  const grouped = new Map<string, PullRequestCiJobStateRecord[]>();

  for (const job of ciJobStates) {
    const existing = grouped.get(job.workflowRunName);
    if (existing) {
      existing.push(job);
    } else {
      grouped.set(job.workflowRunName, [job]);
    }
  }

  const groups = [...grouped.entries()]
    .map(([runName, jobs]) => ({ runName, jobs, outcome: resolveGroupOutcome(jobs) }))
    .sort((a, b) => (CI_GROUP_ORDER[a.outcome] ?? 4) - (CI_GROUP_ORDER[b.outcome] ?? 4));

  return (
    <div className="ci-job-list">
      <div className="ci-job-list-header">CI checks</div>
      {groups.map(({ runName, jobs, outcome }) => {
        const visibleItems = deduplicateJobs(jobs).filter((item) => item.outcome === "failing" || item.outcome === "pending");
        return (
          <div key={runName} className={`ci-job-group ci-job-group-${outcome}`}>
            <div className="ci-job-group-name">
              <span className="ci-job-group-name-text">{runName}</span>
              <span className="ci-job-group-summary">{buildCiSummaryNodes(jobs, "ci-job-group-summary")}</span>
            </div>
            {visibleItems.length > 0 ? (
              <ul className="ci-job-group-items">
                {visibleItems.map((item) => (
                  <li key={item.key} className={`ci-job-item ci-job-item-${item.outcome}`}>
                    <span className="ci-job-item-name">{item.job.jobName}{item.count > 1 ? <span className="ci-job-item-count"> ×{item.count}</span> : null}</span>
                    {item.job.isBlockingMerge === true ? <span className="ci-job-item-blocking" aria-label="required" title="Required for merge">●</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const CI_GROUP_ORDER: Record<string, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 };

function resolveGroupOutcome(jobs: PullRequestCiJobStateRecord[]): "failing" | "pending" | "passing" | "skipped" {
  let hasFailing = false;
  let hasPending = false;
  let hasPassing = false;

  for (const job of jobs) {
    const outcome = resolveCiJobOutcome(job);
    if (outcome === "failing") hasFailing = true;
    else if (outcome === "pending") hasPending = true;
    else if (outcome === "passing") hasPassing = true;
  }

  if (hasFailing) return "failing";
  if (hasPending) return "pending";
  if (hasPassing) return "passing";
  return "skipped";
}

function buildCiSummaryNodes(jobs: PullRequestCiJobStateRecord[], prefix: string): React.ReactNode {
  const { failing, pending, passing, skipped } = readCiSummaryCounts(jobs);

  const parts: React.ReactNode[] = [];

  if (failing > 0) parts.push(<span key="f" className={`${prefix}-failing`}>{failing} failing</span>);
  if (pending > 0) parts.push(<span key="p" className={`${prefix}-pending`}>{pending} pending</span>);
  if (passing > 0) parts.push(<span key="ok" className={`${prefix}-passing`}>{passing} passing</span>);
  if (skipped > 0) parts.push(<span key="s" className={`${prefix}-skipped`}>{skipped} skipped</span>);
  return parts.reduce<React.ReactNode[]>((acc, part, i) => (i === 0 ? [part] : [...acc, ", ", part]), []);
}

function readCiSummaryCounts(jobs: PullRequestCiJobStateRecord[]): {
  failing: number;
  pending: number;
  passing: number;
  skipped: number;
} {
  let failing = 0, pending = 0, passing = 0, skipped = 0;

  for (const job of jobs) {
    const o = resolveCiJobOutcome(job);
    if (o === "failing") failing++;
    else if (o === "pending") pending++;
    else if (o === "passing") passing++;
    else skipped++;
  }

  return { failing, pending, passing, skipped };
}

function buildCiSummaryTooltip(counts: {
  failing: number;
  pending: number;
  passing: number;
  skipped: number;
}): string {
  const parts: string[] = [];

  if (counts.failing > 0) {
    parts.push(`${counts.failing} failing`);
  }

  if (counts.pending > 0) {
    parts.push(`${counts.pending} pending`);
  }

  if (counts.passing > 0) {
    parts.push(`${counts.passing} passing`);
  }

  if (counts.skipped > 0) {
    parts.push(`${counts.skipped} skipped`);
  }

  return parts.length === 0 ? "CI checks" : `CI checks: ${parts.join(", ")}`;
}

function deduplicateJobs(jobs: PullRequestCiJobStateRecord[]): { key: string; job: PullRequestCiJobStateRecord; count: number; outcome: string }[] {
  const seen = new Map<string, { job: PullRequestCiJobStateRecord; count: number; outcome: string }>();
  for (const job of jobs) {
    const outcome = resolveCiJobOutcome(job);
    const key = `${job.jobName}::${outcome}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
    } else {
      seen.set(key, { job, count: 1, outcome });
    }
  }
  return [...seen.entries()].map(([key, { job, count, outcome }]) => ({ key, job, count, outcome }));
}

function resolveCiJobOutcome(job: PullRequestCiJobStateRecord): string {
  if (job.jobStatus !== "completed") return "pending";
  if (job.jobConclusion === "success") return "passing";
  if (job.jobConclusion === "skipped" || job.jobConclusion === "neutral") return "skipped";
  if (job.jobConclusion === "failure" || job.jobConclusion === "timed_out" || job.jobConclusion === "action_required") return "failing";
  return "pending";
}

function PullRequestInteractionGroups({
  entries,
  reviewStates,
}: {
  entries: PullRequestTimelineEntry[];
  reviewStates: PullRequestReviewStateRecord[];
}) {
  const groups = buildPullRequestInteractionGroups(entries, reviewStates);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="pull-request-interaction-groups" aria-label="Pull request interactions">
      {groups.map((group) => {
        return (
          <span
            key={group.kind}
            className={`pull-request-interaction-group pull-request-interaction-group-${group.kind}`}
            role="group"
            aria-label={group.label}
          >
            <span className="pull-request-interaction-group-icon" aria-hidden="true" title={group.label}>
              <PullRequestInteractionGroupIcon kind={group.kind} />
            </span>
            <span className="pull-request-interaction-avatar-stack" aria-hidden="true">
              {group.actors.map((actor) => (
                <span
                  key={`${group.kind}-${actor.login}`}
                  className="pull-request-interaction-avatar-stack-item"
                  title={`@${actor.login}`}
                >
                  <GitHubAvatar login={actor.login} avatarUrl={actor.avatarUrl} />
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function buildPullRequestInteractionGroups(
  entries: PullRequestTimelineEntry[],
  reviewStates: PullRequestReviewStateRecord[],
): PullRequestInteractionGroup[] {
  const approvers = collectActorsWithReviewState(reviewStates, "APPROVED");
  const decliners = collectActorsWithReviewState(reviewStates, "CHANGES_REQUESTED");

  const formalReviewerLogins = new Set([
    ...approvers.map((a) => a.login),
    ...decliners.map((d) => d.login),
  ]);

  const commenters = collectPullRequestInteractionActors(
    entries,
    PULL_REQUEST_COMMENTER_EVENT_TYPES,
    formalReviewerLogins,
  );

  const groups: PullRequestInteractionGroup[] = [];

  if (approvers.length > 0) {
    groups.push({ kind: "approvers", label: "Approvers", actors: approvers });
  }

  if (commenters.length > 0) {
    groups.push({ kind: "commenters", label: "Commenters / Reviewers", actors: commenters });
  }

  if (decliners.length > 0) {
    groups.push({ kind: "decliners", label: "Decliners", actors: decliners });
  }

  return groups;
}

function collectActorsWithReviewState(
  reviewStates: PullRequestReviewStateRecord[],
  state: ReviewState,
): PullRequestInteractionActor[] {
  return reviewStates
    .filter((r) => r.reviewState === state && !isBotActorLogin(r.reviewerLogin))
    .map((r) => ({ login: r.reviewerLogin, avatarUrl: r.reviewerAvatarUrl }));
}

function collectPullRequestInteractionActors(
  entries: PullRequestTimelineEntry[],
  eventTypes: ReadonlySet<string>,
  excludeLogins: ReadonlySet<string> = new Set(),
): PullRequestInteractionActor[] {
  const actors = new Map<string, PullRequestInteractionActor>();

  for (const entry of entries) {
    const actorLogin = entry.paragraph.actorLogin;

    if (actorLogin === null || !eventTypes.has(entry.eventType) || isBotActorLogin(actorLogin) || excludeLogins.has(actorLogin)) {
      continue;
    }

    const actorAvatarUrl = entry.paragraph.actorAvatarUrl;
    const existingActor = actors.get(actorLogin);

    if (existingActor === undefined) {
      actors.set(actorLogin, { login: actorLogin, avatarUrl: actorAvatarUrl });
      continue;
    }

    if (existingActor.avatarUrl === null && actorAvatarUrl !== null) {
      actors.set(actorLogin, { login: actorLogin, avatarUrl: actorAvatarUrl });
    }
  }

  return [...actors.values()];
}

function isBotActorLogin(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

function PullRequestInteractionGroupIcon({ kind }: { kind: PullRequestInteractionGroupKind }) {
  if (kind === "approvers") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M5.75 10.5 8.5 13.25 14.25 7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (kind === "commenters") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M5.5 6.25h9a1.75 1.75 0 0 1 1.75 1.75v4A1.75 1.75 0 0 1 14.5 13.75H10l-3.25 2v-2H5.5A1.75 1.75 0 0 1 3.75 12V8A1.75 1.75 0 0 1 5.5 6.25Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M7 7 13 13M13 7l-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NotificationSummaryContent({
  entry,
}: {
  entry: Pick<NotificationHistoryEntry, "id" | "summaryParagraphs" | "body">;
}) {
  return entry.summaryParagraphs.length > 0 ? (
    <div className="notification-history-summary-list">
      {entry.summaryParagraphs.map((paragraph, index) => (
        <p key={`${entry.id}-summary-${index}`} className="notification-history-summary-line">
          {paragraph.actorLogin ? (
            <>
              <GitHubAvatar login={paragraph.actorLogin} avatarUrl={paragraph.actorAvatarUrl} />
              <span className="notification-history-summary-actor">{paragraph.actorLogin}</span>
            </>
          ) : null}
          <span className="notification-history-summary-text">{paragraph.text}</span>
        </p>
      ))}
    </div>
  ) : (
    <p className="notification-history-body">{entry.body}</p>
  );
}

function PullRequestTimelineContent({
  entries,
  pullRequestAuthorLogin,
  pullRequestAuthorAvatarUrl,
}: {
  entries: PullRequestTimelineEntry[];
  pullRequestAuthorLogin: string;
  pullRequestAuthorAvatarUrl: string | null;
}) {
  const displayEntries = entries.map((entry) => ({
    entry,
    exactTimestamp: formatHistoryTimestamp(entry.occurredAt),
    relativeTimestamp: formatRelativeHistoryTimestamp(entry.occurredAt),
    actorLogin: entry.paragraph.actorLogin ?? pullRequestAuthorLogin,
    actorAvatarUrl: entry.paragraph.actorLogin ? entry.paragraph.actorAvatarUrl : pullRequestAuthorAvatarUrl,
  }));
  const timeColumnWidth = displayEntries.reduce(
    (largestWidth, displayEntry) => Math.max(largestWidth, displayEntry.relativeTimestamp.length),
    1,
  );
  const timelineListStyle: CSSProperties = {
    ["--pull-request-timeline-time-width" as string]: `${timeColumnWidth}ch`,
  };

  return (
    <div className="pull-request-timeline">
      {entries.length === 0 ? (
        <p className="pull-request-timeline-empty">No activity yet.</p>
      ) : null}
      {entries.length > 0 ? (
        <ol className="pull-request-timeline-list" style={timelineListStyle}>
          {displayEntries.map(({ entry, exactTimestamp, relativeTimestamp, actorLogin, actorAvatarUrl }) => {
            return (
              <li key={entry.id} className="pull-request-timeline-item">
                <span className="pull-request-timeline-dot" aria-hidden="true" />
                <div className="pull-request-timeline-entry">
                  <time
                    className="pull-request-timeline-time"
                    dateTime={normalizeHistoryTimestamp(entry.occurredAt)}
                    title={exactTimestamp}
                  >
                    {relativeTimestamp}
                  </time>
                  <div className="pull-request-timeline-author">
                    <GitHubAvatar login={actorLogin} avatarUrl={actorAvatarUrl} />
                    <span className="pull-request-timeline-actor" title={actorLogin}>
                      {actorLogin}
                    </span>
                  </div>
                  <span className="pull-request-timeline-text">{entry.paragraph.text}</span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function RefreshButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="action-button" aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 20 20" className="icon-button-svg" aria-hidden="true">
        <path
          d="M16.25 10A6.25 6.25 0 1 1 14.42 5.58M16.25 3.75v4.17h-4.17"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>&nbsp;
    </button>
  );
}

function FlashMessage({ message }: { message: AppFlashMessage }) {
  return <p className={`flash-message flash-${message.kind}`}>{message.text}</p>;
}

function GitHubIdentityPill({
  label,
  login,
  avatarUrl,
}: {
  label: string;
  login: string;
  avatarUrl: string | null;
}) {
  return (
    <span className="github-identity-pill" title={`${label} ${login}`}>
      <GitHubAvatar login={login} avatarUrl={avatarUrl} />
      <span className="github-identity-label">{label}</span>
      <span className="github-identity-login">{login}</span>
    </span>
  );
}

function GitHubAvatar({
  login,
  avatarUrl,
  title,
}: {
  login: string;
  avatarUrl: string | null;
  title?: string;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const fallback = login.slice(0, 1).toUpperCase() || "?";
  const showImage = avatarUrl !== null && avatarUrl.length > 0 && !hasImageError;

  return (
    <span className="github-avatar" aria-hidden="true" title={title}>
      {showImage ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <span className="github-avatar-fallback">{fallback}</span>
      )}
    </span>
  );
}

function renderPullRequestAction(
  pullRequest: PullRequestRecord,
  handlers: {
    onUntrack: (githubPullRequestId: number) => Promise<void>;
    onRetrack: (pullRequestUrl: string) => Promise<void>;
  },
): ReactNode {
  return <PullRequestTrackingControl pullRequest={pullRequest} handlers={handlers} />;
}

function PullRequestTrackingControl({
  pullRequest,
  handlers,
}: {
  pullRequest: PullRequestRecord;
  handlers: {
    onUntrack: (githubPullRequestId: number) => Promise<void>;
    onRetrack: (pullRequestUrl: string) => Promise<void>;
  };
}) {
  const statusLabel = formatTrackingStateLabel(pullRequest);
  const isTracked = pullRequest.isTracked;
  const actionLabel = isTracked ? "Untrack" : "Track again";
  const formAction = isTracked
    ? `/tracked-pull-requests/${pullRequest.githubPullRequestId}/untrack`
    : "/inactive-pull-requests/retrack";
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (isTracked) {
      void handlers.onUntrack(pullRequest.githubPullRequestId);
      return;
    }

    void handlers.onRetrack(pullRequest.url);
  };

  return (
    <form
      className="pull-request-tracking-control-form"
      method="post"
      action={formAction}
      onSubmit={handleSubmit}
    >
      <input type="hidden" name="url" value={pullRequest.url} />
      <div className={`tracking-toggle ${isTracked ? "tracking-toggle-tracked" : "tracking-toggle-untracked"}`.trim()}>
        <span className="tracking-toggle-label">Tracked</span>
        <button
          type="submit"
          className="tracking-toggle-button"
          role="switch"
          aria-checked={isTracked}
          aria-label={`${statusLabel} (${actionLabel})`}
          title={`${statusLabel} · ${actionLabel}`}
        >
          <span className="tracking-toggle-track" aria-hidden="true">
            <span className="tracking-toggle-thumb" />
          </span>
        </button>
      </div>
    </form>
  );
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
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

function readPrSubTab(searchParams: URLSearchParams): PrSubTab {
  return searchParams.get("tab") === "review-requested" ? "review-requested" : "my-prs";
}

function readRouteState(url: URL): RouteState {
  return {
    currentPage: readDocumentPage(url.pathname),
    uiFilters: readUiFilterValues(url.searchParams),
    logLevelFilter: readLogLevelFilter(url.searchParams),
    activityPage: readActivityPage(url.searchParams),
    prSubTab: readPrSubTab(url.searchParams),
  };
}

function buildLogsApiPath(logLevelFilter: LogLevelFilter): string {
  return logLevelFilter === "all" ? "/api/logs" : `/api/logs?level=${logLevelFilter}`;
}

function buildActivityApiPath(path: string, uiFilters: UiFilterValues, page: number): string {
  const searchParams = new URLSearchParams();

  appendUiFilters(searchParams, ACTIVITY_FILTER_FIELDS, uiFilters);

  if (page > DEFAULT_ACTIVITY_PAGE) {
    searchParams.set("page", String(page));
  }

  const search = searchParams.toString();

  return search.length > 0 ? `${path}?${search}` : path;
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

function countActivePageFilters(filters: UiFilterValues, page: AppPage, logLevelFilter: LogLevelFilter): number {
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

function getPageFilterFields(page: AppPage): readonly PageFilterField[] {
  if (page === "pull-requests") {
    return PULL_REQUEST_FILTER_FIELDS;
  }

  if (page === "logs") {
    return [];
  }

  return ACTIVITY_FILTER_FIELDS;
}

function buildPageHref(page: AppPage, uiFilters: UiFilterValues, logLevelFilter: LogLevelFilter, prSubTab?: PrSubTab): string {
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

function buildActivityPageHref(
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

function buildLogViewerHref(logLevelFilter: LogLevelFilter): string {
  if (logLevelFilter === "all") {
    return "/logs";
  }

  return `/logs?level=${logLevelFilter}`;
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
  for (const field of fields) {
    if (field === "pullRequestStates") {
      for (const filter of uiFilters.pullRequestStates) {
        searchParams.append(formatFilterSearchParamKey(field), filter);
      }

      continue;
    }

    const value = uiFilters[field];

    if (value === DEFAULT_UI_FILTERS[field]) {
      continue;
    }

    searchParams.set(formatFilterSearchParamKey(field), value);
  }
}

function formatPagePath(page: AppPage): string {
  if (page === "pull-requests") {
    return "/";
  }

  return `/${page}`;
}

function formatPageLabel(page: AppPage): string {
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

function formatPullRequestEmptyMessage(uiFilters: UiFilterValues, hasActiveFilters: boolean): string {
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

function togglePullRequestStateSelection(
  selectedFilters: readonly PullRequestStateFilter[],
  filter: PullRequestStateFilter,
): PullRequestStateFilter[] {
  return normalizePullRequestStateFilters(
    selectedFilters.includes(filter)
      ? selectedFilters.filter((value) => value !== filter)
      : [...selectedFilters, filter],
  );
}

function formatTrackingStateLabel(pullRequest: PullRequestRecord): string {
  return pullRequest.isTracked ? "Tracked" : "Untracked";
}

function formatNotificationHistoryHeaderText(entry: NotificationHistoryEntry): string {
  if (entry.pullRequestStateAssetUrlPath === null) {
    return entry.markupHeaderText;
  }

  return entry.markupHeaderText.replace(/ \((?:open|draft|merged|closed)\)$/, "");
}

function formatDeliveryStatusLabel(deliveryStatus: NotificationHistoryEntry["deliveryStatus"]): string {
  if (deliveryStatus === "sent") {
    return "Sent";
  }

  if (deliveryStatus === "failed") {
    return "Failed";
  }

  return "Pending";
}

function formatSourceKindLabel(sourceKind: NotificationHistoryEntry["sourceKind"]): string {
  return sourceKind === "bundle" ? "Bundled" : "Immediate";
}

function formatActorClassLabel(actorClass: "self" | "human_other" | "bot"): string {
  if (actorClass === "human_other") {
    return "Human";
  }

  return actorClass === "self" ? "Self" : "Bot";
}

function formatDecisionStateLabel(
  decisionState: NotificationHistoryEntry["decisionStates"][number],
): string {
  if (decisionState === "notified_ai") {
    return "AI notified";
  }

  if (decisionState === "notified_ai_fallback") {
    return "AI fallback";
  }

  if (decisionState === "suppressed_self_action") {
    return "Self suppressed";
  }

  if (decisionState === "suppressed_rule") {
    return "Rule suppressed";
  }

  if (decisionState === "error") {
    return "Decision error";
  }

  return "Notified";
}

function formatHistoryTimestamp(timestamp: string): string {
  const parsedTimestamp = parseHistoryTimestamp(timestamp);

  if (parsedTimestamp === null) {
    return timestamp;
  }

  const parts = Object.fromEntries(
    HISTORY_TIMESTAMP_FORMATTER.formatToParts(parsedTimestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = parts.hour;
  const minute = parts.minute;
  const second = parts.second;

  if (year && month && day && hour && minute && second) {
    const timeZoneName = parts.timeZoneName ? ` ${parts.timeZoneName}` : "";

    return `${year}-${month}-${day} ${hour}:${minute}:${second}${timeZoneName}`;
  }

  return HISTORY_TIMESTAMP_FORMATTER.format(parsedTimestamp);
}

function sortPullRequestsByLatestActivity(
  pullRequests: PullRequestRecord[],
  timelineByPullRequest: PullRequestTimeline,
): PullRequestRecord[] {
  return pullRequests
    .slice()
    .sort(
      (left, right) =>
        getPullRequestLatestActivitySortTime(right, timelineByPullRequest) -
          getPullRequestLatestActivitySortTime(left, timelineByPullRequest) ||
        right.id - left.id,
    );
}

function getPullRequestLatestActivitySortTime(
  pullRequest: PullRequestRecord,
  timelineByPullRequest: PullRequestTimeline,
): number {
  const timelineEntries = timelineByPullRequest[String(pullRequest.githubPullRequestId)] ?? [];

  for (const entry of timelineEntries) {
    const parsedOccurredAt = parseHistoryTimestamp(entry.occurredAt);

    if (parsedOccurredAt !== null) {
      return parsedOccurredAt.getTime();
    }
  }

  const fallbackTimestamp = parseHistoryTimestamp(pullRequest.updatedAt);
  return fallbackTimestamp?.getTime() ?? 0;
}

function formatRelativeHistoryTimestamp(timestamp: string): string {
  const parsedTimestamp = parseHistoryTimestamp(timestamp);

  if (parsedTimestamp === null) {
    return timestamp;
  }

  const elapsedMilliseconds = parsedTimestamp.getTime() - Date.now();
  const absoluteElapsedMilliseconds = Math.abs(elapsedMilliseconds);

  if (absoluteElapsedMilliseconds < 60_000) {
    return HISTORY_RELATIVE_TIME_FORMATTER.format(Math.round(elapsedMilliseconds / 1_000), "second");
  }

  if (absoluteElapsedMilliseconds < 3_600_000) {
    return HISTORY_RELATIVE_TIME_FORMATTER.format(Math.round(elapsedMilliseconds / 60_000), "minute");
  }

  if (absoluteElapsedMilliseconds < 86_400_000) {
    return HISTORY_RELATIVE_TIME_FORMATTER.format(Math.round(elapsedMilliseconds / 3_600_000), "hour");
  }

  if (absoluteElapsedMilliseconds < 2_592_000_000) {
    return HISTORY_RELATIVE_TIME_FORMATTER.format(Math.round(elapsedMilliseconds / 86_400_000), "day");
  }

  if (absoluteElapsedMilliseconds < 31_536_000_000) {
    return HISTORY_RELATIVE_TIME_FORMATTER.format(Math.round(elapsedMilliseconds / 2_592_000_000), "month");
  }

  return HISTORY_RELATIVE_TIME_FORMATTER.format(Math.round(elapsedMilliseconds / 31_536_000_000), "year");
}

function parseHistoryTimestamp(timestamp: string): Date | null {
  const normalizedTimestamp = normalizeHistoryTimestamp(timestamp);
  const parsedTimestamp = new Date(normalizedTimestamp);

  if (Number.isNaN(parsedTimestamp.getTime())) {
    return null;
  }

  return parsedTimestamp;
}

function normalizeHistoryTimestamp(timestamp: string): string {
  if (SQLITE_TIMESTAMP_PATTERN.test(timestamp)) {
    return `${timestamp.replace(" ", "T")}Z`;
  }

  if (NAIVE_ISO_TIMESTAMP_PATTERN.test(timestamp)) {
    return `${timestamp}Z`;
  }

  return timestamp;
}

function formatEventTypeLabel(eventType: string): string {
  return eventType
    .split("_")
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function formatNotificationTimingLabel(notificationTiming: "immediate"): string {
  return notificationTiming === "immediate" ? "Immediate timing" : notificationTiming;
}

function formatLogLevelLabel(level: LogLevelFilter): string {
  if (level === "all") {
    return "All";
  }

  return level.toUpperCase();
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number}`;
}

function createTrackFlashMessage(result: {
  outcome: "tracked" | "already_tracked";
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">;
}): AppFlashMessage {
  const pullRequestLabel = formatPullRequestLabel(result.pullRequest);

  return {
    kind: "success",
    text:
      result.outcome === "tracked"
        ? `Now tracking ${pullRequestLabel}.`
        : `${pullRequestLabel} is already tracked.`,
  };
}

function createUntrackFlashMessage(result: {
  outcome: "untracked" | "already_inactive";
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">;
}): AppFlashMessage {
  const pullRequestLabel = formatPullRequestLabel(result.pullRequest);

  return {
    kind: "success",
    text:
      result.outcome === "untracked"
        ? `Stopped tracking ${pullRequestLabel}.`
        : `${pullRequestLabel} is already inactive.`,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function handleClientNavigation(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate: (href: string) => void,
): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
    return;
  }

  event.preventDefault();
  onNavigate(href);
}

const APP_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0a0a0a;
    --bg-elevated: #0f0f0f;
    --surface: #111111;
    --surface-hover: #161616;
    --border: #1f1f1f;
    --border-strong: #2a2a2a;
    --text: #ededed;
    --text-secondary: #a1a1a1;
    --text-muted: #6b6b6b;
    --accent: #5b8bf0;
    --accent-soft: rgba(91, 139, 240, 0.12);
    --timeline-line: rgba(91, 139, 240, 0.22);
    --timeline-dot: var(--accent);
    --success: #4ade80;
    --warn: #facc15;
    --danger: #f87171;
    --pr-approved: #4ade80;
    --pr-changes-requested: #f87171;
    --pr-commented: #7aa4f0;
    font-family:
      "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
      Arial, sans-serif;
    font-feature-settings: "cv11", "ss01";
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    line-height: 1.5;
  }

  #app {
    min-height: 100vh;
  }

  main {
    max-width: 1440px;
    margin: 0 auto;
    padding: 32px 32px 64px;
  }

  h1 {
    margin: 0 0 24px;
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .app-title {
    display: inline-block;
    margin: 0 0 24px;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text);
  }

  p {
    margin: 0;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  a {
    color: inherit;
  }

  .page-nav {
    margin: 0 0 24px;
    border-bottom: 1px solid var(--border);
  }

  .page-nav-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .page-nav-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 8px 12px;
    margin-bottom: -1px;
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.9375rem;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease;
  }

  .page-nav-link:hover {
    color: var(--text);
  }

  .page-nav-link-current {
    border-bottom-color: var(--accent);
    color: #cdddff;
  }

  .page-content {
    display: flex;
    flex-direction: column;
    margin-top: 24px;
    padding: 0;
    overflow: hidden;
  }

  .filters-panel {
    padding: 16px 20px;
  }


  .manual-track-description {
    margin: 6px 0 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
  }

  .manual-track-dialog {
    width: min(520px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  }

  .manual-track-dialog::backdrop {
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(2px);
  }

  .manual-track-dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 20px 20px 0;
  }

  .manual-track-dialog-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .manual-track-dialog-close-button {
    flex-shrink: 0;
  }

  .filters-panel {
  }

  .panel {
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }

  h2 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text);
    text-transform: uppercase;
  }

  strong {
    font-weight: 600;
    color: var(--text);
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 0;
  }

  .panel-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .state-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 4px;
    font-weight: 500;
  }

  .pull-request-list {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .notification-history-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .logs-list {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }

  .pagination-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .pagination-footer-bottom {
    margin-top: 16px;
  }

  .pagination-summary {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
  }

  .pagination-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pagination-status {
    color: var(--text-muted);
    font-size: 0.9375rem;
    white-space: nowrap;
  }

  .pull-request-panel {
    grid-column: 1 / -1;
    padding: 0;
    overflow: hidden;
  }

  .pull-request-panel > .panel-header {
    padding: 14px 20px;
    border-bottom: none;
  }

  .pr-sub-tab-bar {
    display: flex;
    align-items: center;
    padding: 0 12px 0 20px;
    gap: 0;
    border-bottom: 1px solid var(--border);
  }

  .pr-sub-tab-bar-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }

  .pr-sub-tab {
    padding: 8px 14px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 100ms ease, border-color 100ms ease;
    white-space: nowrap;
  }

  .pr-sub-tab:hover {
    color: var(--text);
  }

  .pr-sub-tab-active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .pr-sub-tab-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    padding: 0 5px;
    height: 16px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    line-height: 1;
    margin-left: 6px;
  }

  .pr-sub-tab-active .pr-sub-tab-count {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text-muted);
  }

  .action-button.add-pr-button svg {
    width: 11px;
    height: 11px;
    flex-shrink: 0;
  }

  .pull-request-panel > p {
    padding: 24px 20px;
    color: var(--text-secondary);
  }

  .pull-request-item {
    padding: 0;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    border-radius: 0;
    transition: background-color 100ms ease;
  }

  .pull-request-item:last-child {
    border-bottom: 0;
  }

  .pull-request-item:hover {
    background: var(--surface-hover);
  }

  .pull-request-item-expanded {
    background: var(--surface-hover);
  }

  .pull-request-row {
    display: grid;
    grid-template-columns: 12px auto auto auto minmax(0, 1fr) 180px 128px;
    grid-template-areas: "expander avatar state repo title interactions timeline";
    align-items: center;
    gap: 14px;
    padding: 14px 20px;
    min-width: 0;
  }

  .pull-request-row-expandable {
    cursor: pointer;
  }

  .pull-request-row-expandable:focus-visible {
    outline: 1px solid var(--border-strong);
    outline-offset: -1px;
  }

  .pull-request-expander {
    grid-area: expander;
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-left: 6px solid var(--text-muted);
    transition: transform 100ms ease, border-left-color 100ms ease;
  }

  .pull-request-row-expandable:hover .pull-request-expander,
  .pull-request-item-expanded .pull-request-expander {
    border-left-color: var(--text);
  }

  .pull-request-expander-expanded {
    transform: rotate(90deg);
  }

  .pull-request-row > .github-avatar {
    grid-area: avatar;
    width: 24px;
    height: 24px;
  }

  .pull-request-row > .state-pill-icon {
    grid-area: state;
    width: 18px;
    height: 18px;
  }

  .pull-request-title {
    grid-area: title;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .pull-request-title-copy {
    min-width: 0;
    flex: 1 1 auto;
  }

  .pull-request-title-link {
    display: inline-block;
    color: var(--text);
    text-decoration: none;
    font-weight: 500;
    font-size: 1rem;
    line-height: 1.4;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pull-request-title-link:hover {
    color: var(--accent);
  }

  .pull-request-merge-readiness {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  .pull-request-merge-readiness svg {
    width: 18px;
    height: 18px;
  }

  .pull-request-merge-readiness-ready {
    color: var(--success);
  }

  .pull-request-merge-readiness-attention {
    color: var(--warn);
  }

  .pull-request-merge-readiness-danger {
    color: var(--danger);
  }

  .pull-request-merge-readiness-info {
    color: var(--accent);
  }

  .pull-request-merge-readiness-muted {
    color: var(--text-muted);
  }

  .pull-request-repo-pill {
    grid-area: repo;
    display: inline-flex;
    align-items: center;
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .pull-request-timeline-section {
    display: flow-root;
    padding: 8px 20px 14px;
    border-top: 1px solid var(--border);
  }

  .pull-request-expanded-actions {
    float: right;
    margin: 0 0 8px 16px;
  }

  .notification-history-item {
    padding: 14px 16px;
    border-radius: 6px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
  }

  .logs-item {
    padding: 6px 0;
    display: grid;
    grid-template-columns: 32px auto auto minmax(0, 1fr);
    align-items: start;
    column-gap: 12px;
  }

  .logs-item + .logs-item {
    border-top: 1px solid var(--border);
  }

  .notification-history-panel {
    grid-column: 1 / -1;
    padding: 16px 20px;
  }

  .logs-panel {
    grid-column: 1 / -1;
    padding: 16px 20px;
  }

  .track-form {
    margin-top: 16px;
    padding: 0 20px 20px;
  }

  .filters-form {
    margin-top: 12px;
  }

  .filters-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  }

  .filters-grid-activity {
    grid-template-columns: 456px minmax(180px, 1fr) auto;
  }

  .filter-field {
    display: grid;
    gap: 6px;
  }

  .filter-field-actor {
    width: 132px;
  }

  .panel-description {
    margin: 4px 0 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
  }

  .track-form-row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .input-label {
    display: block;
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .text-input {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.9375rem;
    transition: border-color 120ms ease;
  }

  .text-input::placeholder {
    color: var(--text-muted);
  }

  .text-input:focus {
    outline: none;
    border-color: rgba(91, 139, 240, 0.55);
    box-shadow: 0 0 0 1px rgba(91, 139, 240, 0.2);
  }

  .filter-pill-group {
    display: flex;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: rgba(6, 8, 12, 0.9);
    overflow: hidden;
  }

  .filter-pill-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 0 auto;
    padding: 8px 12px;
    border: 0;
    border-right: 1px solid var(--border);
    background: transparent;
    color: #676d7b;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 100ms ease, color 100ms ease, box-shadow 100ms ease;
  }

  .filter-pill-button:last-child {
    border-right: 0;
  }

  .filter-pill-button:hover {
    background: rgba(91, 139, 240, 0.14);
    color: #d7e3ff;
  }

  .filter-pill-button-active {
    background: rgba(91, 139, 240, 0.72);
    color: #ffffff;
    font-weight: 600;
    box-shadow:
      inset 0 0 0 1px rgba(222, 233, 255, 0.34),
      0 0 0 1px rgba(91, 139, 240, 0.18);
  }

  .filter-pill-button-active:hover {
    background: rgba(91, 139, 240, 0.82);
  }

  .filter-pill-button:focus-visible {
    position: relative;
    outline: 1px solid rgba(91, 139, 240, 0.6);
    outline-offset: -1px;
  }

  .pull-request-link {
    color: var(--text);
    text-decoration: none;
    word-break: break-word;
  }

  .pull-request-link:hover {
    color: var(--accent);
  }

  .notification-history-preview {
    padding: 0;
    background: none;
    border: 0;
  }

  .notification-history-preview-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .notification-history-preview-header {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .notification-history-preview-header .github-avatar {
    width: 22px;
    height: 22px;
  }

  .notification-history-preview-link,
  .notification-history-preview-title {
    display: block;
    min-width: 0;
    color: var(--text);
    font-weight: 500;
    font-size: 0.875rem;
    line-height: 1.4;
    word-break: break-word;
  }

  .notification-history-preview-link {
    text-decoration: none;
  }

  .notification-history-preview-link:hover {
    color: var(--accent);
  }

  .notification-history-preview-body {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .notification-history-body {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.5;
    white-space: pre-line;
  }

  .notification-history-summary-list {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .notification-history-summary-line {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
  }

  .notification-history-summary-actor {
    flex-shrink: 0;
    color: var(--text);
    font-weight: 500;
  }

  .notification-history-summary-text {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-secondary);
    line-height: 1.5;
    word-break: break-word;
  }

  .notification-history-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .pull-request-interaction-groups {
    grid-area: interactions;
    display: inline-flex;
    flex-wrap: nowrap;
    gap: 6px;
    min-width: 0;
    width: 100%;
    justify-content: flex-end;
    justify-self: stretch;
  }

  .pull-request-interaction-group {
    --interaction-group-accent: var(--text-secondary);
    --interaction-group-border: color-mix(in srgb, var(--interaction-group-accent) 30%, var(--border));
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 2px 2px 7px;
    border: 1.5px solid var(--interaction-group-border);
    border-radius: 999px;
    background: var(--bg);
  }

  .pull-request-interaction-group-approvers {
    --interaction-group-accent: var(--pr-approved);
  }

  .pull-request-interaction-group-commenters {
    --interaction-group-accent: var(--pr-commented);
  }

  .pull-request-interaction-group-decliners {
    --interaction-group-accent: var(--pr-changes-requested);
  }

  .pull-request-interaction-group-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--interaction-group-accent);
    flex: 0 0 auto;
  }

  .pull-request-interaction-group-icon svg {
    width: 13px;
    height: 13px;
  }

  .pull-request-interaction-avatar-stack {
    display: inline-flex;
    align-items: center;
  }

  .pull-request-interaction-avatar-stack-item {
    display: inline-flex;
  }

  .pull-request-interaction-avatar-stack-item + .pull-request-interaction-avatar-stack-item {
    margin-left: -8px;
  }

  .pull-request-interaction-avatar-stack .github-avatar {
    width: 24px;
    height: 24px;
    border: 1.5px solid var(--bg);
    background: var(--surface);
  }

  .pull-request-timeline-summary {
    grid-area: timeline;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    justify-self: end;
    color: #93a6d6;
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .pull-request-timeline-summary-age {
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 400;
    white-space: nowrap;
  }

  .notification-history-time-pill {
    font-variant-numeric: tabular-nums;
  }

  .pull-request-timeline {
    padding-top: 0;
  }

  .pull-request-timeline-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.9375rem;
  }

  .pull-request-timeline-list {
    display: block;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .pull-request-timeline-item {
    position: relative;
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    gap: 10px;
    padding: 4px 0;
  }

  .pull-request-timeline-item::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--timeline-line);
  }

  .pull-request-timeline-item:first-child::before {
    top: 9px;
  }

  .pull-request-timeline-item:last-child::before {
    bottom: 9px;
  }

  .pull-request-timeline-dot {
    position: relative;
    z-index: 1;
    width: 6px;
    height: 6px;
    margin-top: 7px;
    margin-left: 1px;
    border-radius: 999px;
    background: var(--timeline-dot);
    box-shadow: 0 0 0 2px var(--surface);
  }

  .pull-request-item:hover .pull-request-timeline-dot {
    box-shadow: 0 0 0 2px var(--surface-hover);
  }

  .pull-request-timeline-entry {
    display: grid;
    grid-template-columns: var(--pull-request-timeline-time-width, max-content) minmax(0, 10rem) minmax(0, 1fr);
    gap: 12px;
    min-width: 0;
    align-items: start;
    font-size: 0.9375rem;
  }

  .pull-request-timeline-author {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .pull-request-timeline-author .github-avatar {
    width: 16px;
    height: 16px;
  }

  .pull-request-timeline-actor {
    min-width: 0;
    color: var(--text);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pull-request-timeline-text {
    min-width: 0;
    color: var(--text-secondary);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .pull-request-timeline-time {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    align-self: start;
  }

  .notification-history-resend-form {
    margin-left: auto;
  }

  .pull-request-tracking-control-form {
    margin: 0;
  }

  .tracking-toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  .tracking-toggle-label {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .tracking-toggle-button {
    display: inline-flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
  }

  .tracking-toggle-button:hover {
    color: var(--text);
  }

  .tracking-toggle-button:focus-visible {
    outline: 1px solid rgba(91, 139, 240, 0.6);
    outline-offset: 4px;
    border-radius: 999px;
  }

  .tracking-toggle-track {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 34px;
    height: 20px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    transition: background-color 100ms ease, border-color 100ms ease;
  }

  .tracking-toggle-thumb {
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: var(--text-muted);
    transition: transform 100ms ease, background-color 100ms ease;
  }

  .tracking-toggle-tracked .tracking-toggle-track {
    border-color: rgba(91, 139, 240, 0.45);
    background: rgba(91, 139, 240, 0.18);
  }

  .tracking-toggle-tracked .tracking-toggle-thumb {
    transform: translateX(14px);
    background: var(--accent);
  }

  .tracking-toggle-untracked .tracking-toggle-track {
    border-color: rgba(120, 127, 143, 0.35);
    background: rgba(120, 127, 143, 0.12);
  }

  .tracking-toggle-untracked .tracking-toggle-thumb {
    background: #80879a;
  }

  .tracking-toggle-tracked .tracking-toggle-label {
    color: #dfe8ff;
  }

  .tracking-toggle-untracked .tracking-toggle-label {
    color: var(--text-secondary);
  }

  .logs-entry-time {
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .logs-entry-message {
    min-width: 0;
    font-size: 0.9375rem;
    font-weight: 400;
    line-height: 1.5;
    word-break: break-word;
  }

  .logs-entry-details {
    margin: 0;
  }

  .logs-entry-details:not([open]) ~ .logs-context-json {
    display: none;
  }

  .logs-disclosure-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    padding: 0;
    list-style: none;
    cursor: pointer;
  }

  .logs-entry-details > summary::-webkit-details-marker {
    display: none;
  }

  .logs-disclosure-marker,
  .logs-disclosure-spacer {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.2;
  }

  .logs-disclosure-button .logs-disclosure-marker {
    width: auto;
  }

  .logs-disclosure-marker::before {
    content: "▸";
  }

  .logs-entry-details[open] .logs-disclosure-marker::before {
    content: "▾";
  }

  .logs-context-json {
    grid-column: 2 / -1;
    margin: 6px 0 0;
    padding: 8px 10px;
    border-radius: 6px;
  }

  .raw-event-json {
    overflow-x: auto;
    margin: 12px 0 0;
    padding: 12px;
    border-radius: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    line-height: 1.5;
    font-size: 0.8125rem;
  }

  .raw-event-json code {
    display: block;
  }

  .raw-event-json-line {
    display: block;
  }

  .state-pill-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 auto;
  }

  .history-pill,
  .github-identity-pill,
  .delivery-pill,
  .log-level-pill {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 7px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .history-pill {
    color: var(--text-secondary);
  }

  .github-identity-pill {
    gap: 6px;
  }

  .github-identity-label {
    color: var(--text-muted);
  }

  .github-identity-login {
    color: var(--text);
  }

  .github-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface);
    flex-shrink: 0;
  }

  .github-avatar img,
  .github-avatar-fallback {
    width: 100%;
    height: 100%;
  }

  .github-avatar img {
    display: block;
    object-fit: cover;
  }

  .github-avatar-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    line-height: 1;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .log-level-debug {
    color: var(--text-muted);
  }

  .log-level-info {
    color: var(--accent);
  }

  .log-level-warn {
    color: var(--warn);
  }

  .log-level-error {
    color: var(--danger);
  }

  .delivery-pending {
    color: var(--warn);
  }

  .delivery-sent {
    color: var(--success);
  }

  .delivery-failed {
    color: var(--danger);
  }

  .notification-history-time {
    color: var(--text-muted);
  }

  .pull-request-subtle {
    display: block;
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 7px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    transition: background-color 100ms ease, border-color 100ms ease;
  }

  .action-button:hover {
    background: var(--surface-hover);
    border-color: var(--border-strong);
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .pagination-button {
    min-width: 72px;
  }

  .icon-button-svg {
    width: 12px;
    height: 12px;
  }

  .primary-button {
    border-color: rgba(91, 139, 240, 0.5);
    background: rgba(91, 139, 240, 0.18);
    color: #dfe8ff;
  }

  .primary-button:hover {
    background: rgba(91, 139, 240, 0.24);
    border-color: rgba(91, 139, 240, 0.7);
  }

  .clear-filters-link {
    padding: 4px 10px;
    color: var(--text-secondary);
  }

  .flash-message {
    margin-top: 12px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.9375rem;
  }

  .flash-success {
    border-color: rgba(74, 222, 128, 0.3);
    background: rgba(74, 222, 128, 0.05);
    color: var(--success);
  }

  .flash-error {
    border-color: rgba(248, 113, 113, 0.3);
    background: rgba(248, 113, 113, 0.05);
    color: var(--danger);
  }

  .ci-job-stats {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    margin-top: 1px;
    white-space: nowrap;
  }

  .ci-job-stats-label,
  .ci-job-stats-separator,
  .ci-job-stats-skipped {
    color: var(--text-muted);
  }

  .ci-job-stats-failing {
    color: var(--danger);
  }

  .ci-job-stats-pending {
    color: var(--warn);
  }

  .ci-job-stats-passing {
    color: var(--success);
  }

  .ci-job-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 0 14px;
  }

  .ci-job-list-header {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 0 4px;
  }

  .ci-job-group {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .ci-job-group-failing {
    border-color: rgba(248, 113, 113, 0.3);
  }

  .ci-job-group-pending {
    border-color: rgba(250, 204, 21, 0.25);
  }

  .ci-job-group-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
    padding: 5px 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .ci-job-group-failing > .ci-job-group-name {
    background: rgba(248, 113, 113, 0.06);
    border-bottom-color: rgba(248, 113, 113, 0.2);
  }

  .ci-job-group-name-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ci-job-group-summary {
    font-size: 0.6875rem;
    font-weight: 400;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .ci-job-group-summary-failing {
    color: var(--danger);
  }

  .ci-job-group-summary-pending {
    color: var(--warn);
  }

  .ci-job-group-summary-passing {
    color: var(--success);
  }

  .ci-job-group-summary-skipped {
    color: var(--text-muted);
  }

  .ci-job-group-items {
    list-style: none;
    margin: 0;
    padding: 3px 0;
    display: flex;
    flex-direction: column;
  }

  .ci-job-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75rem;
    color: var(--text-secondary);
    padding: 3px 10px;
  }

  .ci-job-item:hover {
    background: var(--surface-hover);
  }

  .ci-job-item::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-muted);
  }

  .ci-job-item-failing {
    color: var(--text);
  }

  .ci-job-item-failing::before {
    background: var(--danger);
  }

  .ci-job-item-pending::before {
    background: var(--warn);
  }

  .ci-job-item-passing::before {
    background: var(--success);
  }

  .ci-job-item-skipped {
    color: var(--text-muted);
  }

  .ci-job-item-skipped::before {
    background: var(--border-strong);
  }

  .ci-job-item-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ci-job-item-count {
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .ci-job-item-blocking {
    font-size: 0.5625rem;
    color: var(--accent);
    flex-shrink: 0;
    line-height: 1;
    opacity: 0.8;
  }

  @media (max-width: 1024px) {
    .pull-request-row {
      grid-template-columns: 12px auto auto auto minmax(0, 1fr);
      grid-template-areas:
        "expander avatar state repo title"
        "interactions interactions interactions timeline timeline";
      row-gap: 8px;
    }
    .pull-request-row > .pull-request-expander { grid-area: expander; }
    .pull-request-row > .github-avatar { grid-area: avatar; }
    .pull-request-row > .state-pill-icon { grid-area: state; }
    .pull-request-row > .pull-request-repo-pill { grid-area: repo; }
    .pull-request-row > .pull-request-title { grid-area: title; }
    .pull-request-row > .pull-request-interaction-groups { grid-area: interactions; }
    .pull-request-row > .pull-request-timeline-summary { grid-area: timeline; justify-self: start; align-items: flex-start; }

    .pull-request-timeline-section {
      padding: 8px 16px 14px;
    }

    .filters-grid-activity {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .filter-field-actor {
      width: auto;
    }
  }

  @media (max-width: 640px) {
    main {
      padding: 24px 16px 48px;
    }

    .pull-request-row {
      grid-template-columns: 12px auto auto minmax(0, 1fr);
      grid-template-areas:
        "expander avatar state title"
        "repo repo repo repo"
        "interactions interactions timeline timeline";
      align-items: start;
      padding: 12px 16px;
    }

    .pull-request-row > .pull-request-repo-pill {
      grid-area: repo;
      justify-self: start;
    }

    .pull-request-row > .pull-request-interaction-groups {
      justify-self: start;
    }

    .pull-request-title-link {
      white-space: normal;
    }

    .pull-request-title {
      align-items: flex-start;
    }

    .pull-request-panel > .panel-header {
      padding: 12px 16px;
    }

    .track-form-row {
      flex-direction: column;
    }

    .manual-track-dialog {
      width: calc(100vw - 24px);
    }

    .manual-track-dialog-header {
      flex-direction: column;
      align-items: stretch;
    }

    .notification-history-preview-header-row {
      flex-direction: column;
    }

    .pull-request-timeline-entry {
      grid-template-columns: var(--pull-request-timeline-time-width, max-content) minmax(0, 7.5rem) minmax(0, 1fr);
      gap: 10px;
    }

    .pagination-footer {
      align-items: flex-start;
      flex-direction: column;
    }

    .pagination-controls {
      width: 100%;
      justify-content: space-between;
    }
  }
`;
