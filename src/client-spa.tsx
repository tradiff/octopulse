import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
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
import type { PullRequestTimeline, PullRequestTimelineEntry, RawEventsEntry } from "./raw-events.js";
import {
  DEFAULT_UI_FILTERS,
  buildUiFilterOptions,
  filterInactivePullRequests,
  filterNotificationHistory,
  filterRawEvents,
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
type AppPage = "pull-requests" | "logs" | "notification-history" | "raw-events";

interface RouteState {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  logLevelFilter: LogLevelFilter;
  activityPage: number;
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
  "raw-events",
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
  const [notificationHistoryPagination, setNotificationHistoryPagination] =
    useState<PaginationState>(EMPTY_PAGINATION_STATE);
  const [rawEvents, setRawEvents] = useState<RawEventsEntry[]>([]);
  const [rawEventsPagination, setRawEventsPagination] = useState<PaginationState>(EMPTY_PAGINATION_STATE);
  const [recentLogs, setRecentLogs] = useState<RecentLogEntry[]>([]);
  const manualTrackDialogRef = useRef<HTMLDialogElement | null>(null);
  const [trackFormUrl, setTrackFormUrl] = useState("");
  const [isManualTrackDialogOpen, setIsManualTrackDialogOpen] = useState(false);
  const [trackFormMessage, setTrackFormMessage] = useState<AppFlashMessage | undefined>(undefined);
  const [flashMessage, setFlashMessage] = useState<AppFlashMessage | undefined>(undefined);

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
        rawEvents,
      }),
    [trackedPullRequests, inactivePullRequests, notificationHistory, rawEvents],
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
  const filteredNotificationHistory = useMemo(
    () => filterNotificationHistory(notificationHistory, route.uiFilters),
    [notificationHistory, route.uiFilters],
  );
  const filteredRawEvents = useMemo(
    () => filterRawEvents(rawEvents, route.uiFilters),
    [rawEvents, route.uiFilters],
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
          apiFetch<{ timelineByPullRequest: PullRequestTimeline }>("/api/pull-request-timeline"),
        ]);

        setTrackedPullRequests(trackedResponse.pullRequests);
        setInactivePullRequests(inactiveResponse.pullRequests);
        setTimelineByPullRequest(pullRequestTimelineResponse.timelineByPullRequest);
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

      const [trackedResponse, inactiveResponse, rawEventsResponse] = await Promise.all([
        apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/tracked-pull-requests"),
        apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/inactive-pull-requests"),
        apiFetch<{ rawEvents: RawEventsEntry[]; pagination: PaginationState }>(
          buildActivityApiPath("/api/raw-events", routeState.uiFilters, routeState.activityPage),
        ),
      ]);

      setTrackedPullRequests(trackedResponse.pullRequests);
      setInactivePullRequests(inactiveResponse.pullRequests);
      setRawEvents(rawEventsResponse.rawEvents);
      setRawEventsPagination(rawEventsResponse.pagination);
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
        <FilterPanel
          currentPage={route.currentPage}
          uiFilters={route.uiFilters}
          uiFilterOptions={uiFilterOptions}
          logLevelFilter={route.logLevelFilter}
          formKey={buildPageHref(route.currentPage, route.uiFilters, route.logLevelFilter)}
          onFormChange={route.currentPage === "logs" ? handleLogsFilterChange : handleFilterChange}
          onNavigate={navigateToHref}
        />
        <div className="page-content">
          {route.currentPage === "pull-requests" ? (
            <PullRequestList
              title="Pull Requests"
              emptyMessage={formatPullRequestEmptyMessage(route.uiFilters, hasActiveFilters)}
              pullRequests={sortedPullRequests}
              timelineByPullRequest={timelineByPullRequest}
              onRefresh={handleBaseDataRefresh}
              headerAction={
                <button
                  type="button"
                  className="action-button primary-button"
                  onClick={openManualTrackDialog}
                >
                  Add
                </button>
              }
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
          {route.currentPage === "raw-events" ? (
            <RawEventsPanel
              rawEvents={filteredRawEvents}
              pagination={rawEventsPagination}
              hasActiveFilters={hasActiveFilters}
              uiFilters={route.uiFilters}
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
  const activeFilterCount = countActivePageFilters(uiFilters, currentPage, logLevelFilter);
  const pagePath = formatPagePath(currentPage);
  const showsActivityFilters = currentPage !== "pull-requests";
  const showsLogFilters = currentPage === "logs";
  const filtersGridClassName =
    showsActivityFilters && !showsLogFilters ? "filters-grid filters-grid-activity" : "filters-grid";

  return (
    <section className="panel filters-panel">
      <div className="panel-header">
        <div>
          <h2>Filters</h2>
        </div>
        <div className="panel-header-actions">
          {activeFilterCount > 0 ? (
            <a
              href={pagePath}
              className="action-button clear-filters-link"
              onClick={(event) => handleClientNavigation(event, pagePath, onNavigate)}
            >
              Clear
            </a>
          ) : null}
          <span className="count">{activeFilterCount}</span>
        </div>
      </div>
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
    <section className="panel notification-history-panel">
      <div className="panel-header">
        <h2>Notification History</h2>
        <div className="panel-header-actions">
          <RefreshButton label="Refresh notification history" onClick={onRefresh} />
          <span className="count">{pagination.totalCount}</span>
        </div>
      </div>
      <ActivityPagination
        currentPage="notification-history"
        uiFilters={uiFilters}
        pagination={pagination}
        onNavigate={onNavigate}
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

function RawEventsPanel({
  rawEvents,
  pagination,
  hasActiveFilters,
  uiFilters,
  onNavigate,
  onRefresh,
}: {
  rawEvents: RawEventsEntry[];
  pagination: PaginationState;
  hasActiveFilters: boolean;
  uiFilters: UiFilterValues;
  onNavigate: (href: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="panel raw-events-panel">
      <div className="panel-header">
        <h2>Raw Events</h2>
        <div className="panel-header-actions">
          <RefreshButton label="Refresh raw events" onClick={onRefresh} />
          <span className="count">{pagination.totalCount}</span>
        </div>
      </div>
      <ActivityPagination
        currentPage="raw-events"
        uiFilters={uiFilters}
        pagination={pagination}
        onNavigate={onNavigate}
        position="top"
      />
      {rawEvents.length === 0 ? (
        <p>
          {hasActiveFilters
            ? "No normalized events match current filters."
            : "No normalized events yet."}
        </p>
      ) : (
        <ul className="raw-events-list">
          {rawEvents.map((entry) => (
            <li key={entry.id} className="raw-events-item">
              <div className="raw-events-header">
                <a href={entry.pullRequestUrl} className="pull-request-link">
                  {entry.pullRequestLabel}
                </a>
                <span className="notification-history-time">
                  {formatHistoryTimestamp(entry.occurredAt)}
                </span>
              </div>
              <strong>{formatEventTypeLabel(entry.eventType)}</strong>
              <span className="pull-request-subtle">{entry.pullRequestTitle}</span>
              <div className="notification-history-meta-row raw-events-meta-row">
                {entry.actorLogin ? (
                  <GitHubIdentityPill
                    label="Actor"
                    login={entry.actorLogin}
                    avatarUrl={readRawEventActorAvatarUrl(entry.rawPayloadJson)}
                  />
                ) : null}
                {entry.actorClass ? (
                  <span className="history-pill">{formatActorClassLabel(entry.actorClass)}</span>
                ) : null}
                {entry.decisionState ? (
                  <span className="history-pill">{formatDecisionStateLabel(entry.decisionState)}</span>
                ) : null}
                {entry.notificationTiming ? (
                  <span className="history-pill">
                    {formatNotificationTimingLabel(entry.notificationTiming)}
                  </span>
                ) : null}
                {entry.notificationSourceKind ? (
                  <span className="history-pill">{formatSourceKindLabel(entry.notificationSourceKind)}</span>
                ) : null}
                {entry.notificationDeliveryStatus ? (
                  <span className={`delivery-pill delivery-${entry.notificationDeliveryStatus}`}>
                    {formatDeliveryStatusLabel(entry.notificationDeliveryStatus)}
                  </span>
                ) : null}
              </div>
              <RawEventJsonDetails rawPayloadJson={entry.rawPayloadJson} />
            </li>
          ))}
        </ul>
      )}
      <ActivityPagination
        currentPage="raw-events"
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
  position = "bottom",
}: {
  currentPage: "notification-history" | "raw-events";
  uiFilters: UiFilterValues;
  pagination: PaginationState;
  onNavigate: (href: string) => void;
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
      {pagination.totalPages > 1 ? (
        <div className="pagination-controls" aria-label="Activity pagination">
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
        </div>
      ) : null}
    </div>
  );
}

function RawEventJsonDetails({ rawPayloadJson }: { rawPayloadJson: string | null }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <details
      className="raw-event-details"
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
    >
      <summary>Raw JSON</summary>
      {isOpen ? <RawEventJsonBlock rawPayloadJson={rawPayloadJson} /> : null}
    </details>
  );
}

function RawEventJsonBlock({ rawPayloadJson }: { rawPayloadJson: string | null }) {
  if (rawPayloadJson === null) {
    return <pre className="raw-event-json">No stored raw payload.</pre>;
  }

  const formattedJson = formatJsonForDisplay(rawPayloadJson);

  if (formattedJson === null) {
    return <pre className="raw-event-json">{rawPayloadJson}</pre>;
  }

  return <HighlightedJsonBlock code={formattedJson} className="raw-event-json" />;
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

function readRawEventActorAvatarUrl(rawPayloadJson: string | null): string | null {
  if (rawPayloadJson === null) {
    return null;
  }

  try {
    const payload = JSON.parse(rawPayloadJson) as unknown;

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }

    const actorAvatarUrl = (payload as Record<string, unknown>).actorAvatarUrl;

    return typeof actorAvatarUrl === "string" && actorAvatarUrl.length > 0 ? actorAvatarUrl : null;
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
    <section className="panel logs-panel">
      <div className="panel-header">
        <div>
          <h2>Logs</h2>
          <p className="panel-description">Recent flat-file logs from local runtime.</p>
        </div>
        <div className="panel-header-actions">
          <RefreshButton label="Refresh logs" onClick={onRefresh} />
          <span className="count">{recentLogs.length}</span>
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
  onRefresh,
  headerAction,
  renderAction,
}: {
  title: string;
  emptyMessage: string;
  pullRequests: PullRequestRecord[];
  timelineByPullRequest: PullRequestTimeline;
  onRefresh: () => void;
  headerAction?: ReactNode;
  renderAction?: (pullRequest: PullRequestRecord) => ReactNode;
}) {
  return (
    <section className="panel pull-request-panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <div className="panel-header-actions">
          {headerAction}
          <RefreshButton label="Refresh pull requests" onClick={onRefresh} />
          <span className="count">{pullRequests.length}</span>
        </div>
      </div>
      {pullRequests.length === 0 ? (
        <p>{emptyMessage}</p>
      ) : (
        <ul className="pull-request-list">
          {pullRequests.map((pullRequest) => (
            <li key={pullRequest.id} className="pull-request-item">
              <div className="notification-history-preview">
                <div className="notification-history-preview-header-row">
                  <div className="notification-history-preview-header">
                    <GitHubAvatar login={pullRequest.authorLogin} avatarUrl={pullRequest.authorAvatarUrl} />
                    <img
                      className="state-pill-icon"
                      src={resolvePullRequestStateAssetUrlPath(pullRequest)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                    <a
                      href={pullRequest.url}
                      className="notification-history-preview-link"
                      title={`${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number}`}
                    >
                      [{pullRequest.repositoryName}] {pullRequest.title}
                    </a>
                  </div>
                </div>
                <div className="notification-history-meta-row">
                  <span className="history-pill">
                    {pullRequest.repositoryOwner}/{pullRequest.repositoryName} #{pullRequest.number}
                  </span>
                  <span className="history-pill">@{pullRequest.authorLogin}</span>
                  {renderAction ? renderAction(pullRequest) : null}
                </div>
                <PullRequestTimelineDropdown
                  entries={timelineByPullRequest[String(pullRequest.githubPullRequestId)] ?? []}
                  pullRequestAuthorLogin={pullRequest.authorLogin}
                  pullRequestAuthorAvatarUrl={pullRequest.authorAvatarUrl}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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

function PullRequestTimelineDropdown({
  entries,
  pullRequestAuthorLogin,
  pullRequestAuthorAvatarUrl,
}: {
  entries: PullRequestTimelineEntry[];
  pullRequestAuthorLogin: string;
  pullRequestAuthorAvatarUrl: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
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
  const hiddenEntryCount = Math.max(displayEntries.length - 1, 0);
  const visibleEntries = isExpanded ? displayEntries : displayEntries.slice(0, 1);

  return (
    <div className="pull-request-timeline">
      {entries.length === 0 ? (
        <p className="pull-request-timeline-empty">No activity yet.</p>
      ) : (
        <>
          <ol className="pull-request-timeline-list" style={timelineListStyle}>
            {visibleEntries.map(({ entry, exactTimestamp, relativeTimestamp, actorLogin, actorAvatarUrl }) => {
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
          {!isExpanded && hiddenEntryCount > 0 ? (
            <button
              type="button"
              className="pull-request-timeline-toggle pull-request-timeline-toggle-expand"
              aria-label={`Show ${hiddenEntryCount} more timeline ${hiddenEntryCount === 1 ? "event" : "events"}`}
              onClick={() => setIsExpanded(true)}
            >
              {hiddenEntryCount} more
            </button>
          ) : null}
          {isExpanded && hiddenEntryCount > 0 ? (
            <button
              type="button"
              className="pull-request-timeline-toggle pull-request-timeline-toggle-collapse"
              onClick={() => setIsExpanded(false)}
            >
              Collapse
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function RefreshButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="action-button icon-button" aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 20 20" className="icon-button-svg" aria-hidden="true">
        <path
          d="M16.25 10A6.25 6.25 0 1 1 14.42 5.58M16.25 3.75v4.17h-4.17"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
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

function GitHubAvatar({ login, avatarUrl }: { login: string; avatarUrl: string | null }) {
  const [hasImageError, setHasImageError] = useState(false);
  const fallback = login.slice(0, 1).toUpperCase() || "?";
  const showImage = avatarUrl !== null && avatarUrl.length > 0 && !hasImageError;

  return (
    <span className="github-avatar" aria-hidden="true">
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

  if (pullRequest.isTracked) {
    return (
      <form
        className="pull-request-tracking-control-form"
        method="post"
        action={`/tracked-pull-requests/${pullRequest.githubPullRequestId}/untrack`}
        onSubmit={(event) => {
          event.preventDefault();
          void handlers.onUntrack(pullRequest.githubPullRequestId);
        }}
      >
        <div className="tracking-control tracking-control-tracked">
          <span className="tracking-control-segment tracking-control-segment-active">{statusLabel}</span>
          <button
            type="submit"
            className="tracking-control-button tracking-control-segment tracking-control-segment-inactive"
          >
            Untrack
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="pull-request-tracking-control-form"
      method="post"
      action="/inactive-pull-requests/retrack"
      onSubmit={(event) => {
        event.preventDefault();
        void handlers.onRetrack(pullRequest.url);
      }}
    >
      <input type="hidden" name="url" value={pullRequest.url} />
      <div className="tracking-control tracking-control-untracked">
        <button
          type="submit"
          className="tracking-control-button tracking-control-segment tracking-control-segment-inactive"
        >
          Track Again
        </button>
        <span className="tracking-control-segment tracking-control-segment-active">{statusLabel}</span>
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

function readRouteState(url: URL): RouteState {
  return {
    currentPage: readDocumentPage(url.pathname),
    uiFilters: readUiFilterValues(url.searchParams),
    logLevelFilter: readLogLevelFilter(url.searchParams),
    activityPage: readActivityPage(url.searchParams),
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

  if (pathname === "/raw-events") {
    return "raw-events";
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

function buildPageHref(page: AppPage, uiFilters: UiFilterValues, logLevelFilter: LogLevelFilter): string {
  if (page === "logs") {
    return buildLogViewerHref(logLevelFilter);
  }

  const searchParams = new URLSearchParams();

  appendUiFilters(searchParams, getPageFilterFields(page), uiFilters);

  const pagePath = formatPagePath(page);
  const search = searchParams.toString();

  return search.length > 0 ? `${pagePath}?${search}` : pagePath;
}

function buildActivityPageHref(
  page: "notification-history" | "raw-events",
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

  return "Raw Events";
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
  @import url("https://fonts.googleapis.com/css2?family=Orbitron:wght@600;700;800&display=swap");

  :root {
    color-scheme: dark;
    font-family: Inter, system-ui, sans-serif;
  }

  body {
    margin: 0;
    background:
      radial-gradient(circle at top, rgba(56, 189, 248, 0.08), transparent 32%),
      linear-gradient(180deg, #222a33 0%, #141a20 100%);
    color: #e2e8f0;
  }

  #app {
    min-height: 100vh;
  }

  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 0 24px 64px;
  }

  .eyebrow {
    display: inline-block;
    margin-bottom: 16px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.12);
    color: #7dd3fc;
  }

  h1 {
    margin: 0 0 12px;
    font-size: clamp(2rem, 5vw, 3rem);
  }

  .app-title {
    display: inline-block;
    margin-bottom: 16px;
    font-family: "Orbitron", "Segoe UI", sans-serif;
    font-size: clamp(2.75rem, 6vw, 3.5rem);
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    background: linear-gradient(90deg, #2af5c8 0%, #22d3ee 54%, #38bdf8 100%);
    color: transparent;
    -webkit-background-clip: text;
    background-clip: text;
    text-shadow: none;
    filter:
      drop-shadow(0 0 2px rgba(42, 245, 200, 0.18))
      drop-shadow(0 0 6px rgba(34, 211, 238, 0.1));
  }

  p {
    margin: 0;
    line-height: 1.6;
    color: #cbd5e1;
  }

  .page-nav {
    margin-top: 0;
    border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  }

  .page-nav-list {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
  }

  .page-nav-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: #94a3b8;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }

  .page-nav-link:hover {
    color: #e2e8f0;
  }

  .page-nav-link-current {
    border-bottom-color: #38bdf8;
    color: #e2e8f0;
  }

  .page-content {
    margin-top: 32px;
  }

  .manual-track-description {
    margin: 8px 0 0;
    color: #94a3b8;
  }

  .manual-track-dialog {
    width: min(560px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 18px;
    background: rgba(28, 34, 42, 0.98);
    color: #e2e8f0;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
  }

  .manual-track-dialog::backdrop {
    background: rgba(9, 12, 16, 0.7);
    backdrop-filter: blur(4px);
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
    font-size: 1.1rem;
  }

  .manual-track-dialog-close-button {
    flex-shrink: 0;
  }

  .filters-panel {
    margin-top: 32px;
  }

  .panel {
    padding: 18px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 16px;
    background: rgba(28, 34, 42, 0.92);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
  }

  h2 {
    margin: 0 0 8px;
    font-size: 1rem;
  }

  strong {
    display: block;
    margin-top: 8px;
    font-size: 1rem;
    line-height: 1.4;
  }

  a {
    color: inherit;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .panel-header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .count,
  .state-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-weight: 600;
  }

  .count {
    padding: 4px 10px;
    background: rgba(56, 189, 248, 0.16);
    color: #7dd3fc;
  }

  .pull-request-list {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .notification-history-list {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .raw-events-list {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .logs-list {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }

  .pagination-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .pagination-footer-top {
    margin: 12px 0 16px;
  }

  .pagination-footer-bottom {
    margin-top: 16px;
  }

  .pagination-summary {
    margin: 0;
  }

  .pagination-controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pagination-status {
    color: #94a3b8;
    white-space: nowrap;
  }

  .pull-request-item {
    padding: 14px;
    border-radius: 12px;
    background: rgba(39, 46, 56, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.16);
  }

  .notification-history-item,
  .raw-events-item {
    padding: 14px;
    border-radius: 12px;
    background: rgba(39, 46, 56, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.16);
  }

  .logs-item {
    padding: 6px 0;
    display: grid;
    grid-template-columns: 32px auto auto minmax(0, 1fr);
    align-items: start;
    column-gap: 12px;
  }

  .logs-item + .logs-item {
    border-top: 1px solid rgba(148, 163, 184, 0.14);
  }

  .notification-history-panel {
    grid-column: 1 / -1;
  }

  .raw-events-panel {
    grid-column: 1 / -1;
  }

  .logs-panel {
    grid-column: 1 / -1;
  }

  .pull-request-panel {
    grid-column: 1 / -1;
  }

  .track-form {
    margin-top: 16px;
    padding: 0 20px 20px;
  }

  .filters-form {
    margin-top: 16px;
  }

  .filters-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }

  .filters-grid-activity {
    grid-template-columns: 456px minmax(180px, 1fr) auto;
  }

  .filter-field {
    display: grid;
    gap: 8px;
  }

  .filter-field-actor {
    width: 132px;
  }

  .panel-description {
    margin-top: 4px;
  }

  .track-form-row {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }

  .input-label {
    display: block;
    font-weight: 600;
    color: #cbd5e1;
  }

  .text-input {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 12px;
    background: rgba(23, 28, 35, 0.96);
    color: #e2e8f0;
    font: inherit;
  }

  .text-input::placeholder {
    color: #7b8797;
  }

  .text-input:focus {
    outline: 2px solid rgba(56, 189, 248, 0.4);
    outline-offset: 2px;
  }

  .filter-pill-group {
    display: flex;
    width: 100%;
    border-radius: 14px;
    border: 1px solid rgba(148, 163, 184, 0.22);
    background: rgba(28, 32, 38, 0.9);
    overflow: hidden;
  }

  .filter-pill-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 0 auto;
    padding: 8px 12px;
    border: 0;
    border-right: 1px solid rgba(148, 163, 184, 0.16);
    background: transparent;
    color: #94a3b8;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }

  .filter-pill-button:last-child {
    border-right: 0;
  }

  .filter-pill-button:hover {
    background: rgba(58, 66, 76, 0.5);
    color: #e2e8f0;
  }

  .filter-pill-button-active {
    background: rgba(56, 189, 248, 0.16);
    color: #bae6fd;
  }

  .filter-pill-button-active:hover {
    background: rgba(56, 189, 248, 0.22);
    color: #e0f2fe;
  }

  .filter-pill-button:focus-visible {
    position: relative;
    outline: 2px solid rgba(56, 189, 248, 0.45);
    outline-offset: -2px;
  }

  .pull-request-link {
    color: #7dd3fc;
    text-decoration: none;
    word-break: break-word;
  }

  .pull-request-link:hover {
    text-decoration: underline;
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
    width: 24px;
    height: 24px;
  }

  .notification-history-preview-header .github-avatar-fallback {
  }

  .notification-history-preview-link,
  .notification-history-preview-title {
    display: block;
    min-width: 0;
    color: #f8fafc;
    font-weight: 600;
    line-height: 1.45;
    word-break: break-word;
  }

  .notification-history-preview-link {
    text-decoration: none;
  }

  .notification-history-preview-link:hover {
    text-decoration: underline;
  }

  .notification-history-preview-body {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(148, 163, 184, 0.14);
  }

  .raw-events-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .notification-history-body {
    margin: 0;
    color: #e2e8f0;
    line-height: 1.5;
    white-space: pre-line;
  }

  .notification-history-summary-list {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .notification-history-summary-line {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 0;
  }

  .notification-history-summary-actor {
    flex-shrink: 0;
    color: #f8fafc;
    font-weight: 600;
  }

  .notification-history-summary-text {
    flex: 1 1 auto;
    min-width: 0;
    color: #dbe7f3;
    line-height: 1.5;
    word-break: break-word;
  }

  .notification-history-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .notification-history-time-pill {
    font-variant-numeric: tabular-nums;
  }

  .pull-request-timeline {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(148, 163, 184, 0.14);
  }

  .pull-request-timeline-empty {
    margin: 0;
    color: #94a3b8;
  }

  .pull-request-timeline-list {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .pull-request-timeline-item {
    position: relative;
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    gap: 10px;
    padding: 6px 0;
  }

  .pull-request-timeline-item::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgba(148, 163, 184, 0.18);
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
    width: 8px;
    height: 8px;
    margin-top: 6px;
    border-radius: 999px;
    background: #7dd3fc;
    box-shadow: 0 0 0 3px rgba(15, 23, 42, 1);
  }

  .pull-request-timeline-entry {
    display: grid;
    grid-template-columns: var(--pull-request-timeline-time-width, max-content) minmax(0, 10rem) minmax(0, 1fr);
    gap: 12px;
    min-width: 0;
    align-items: start;
  }

  .pull-request-timeline-author {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .pull-request-timeline-author .github-avatar {
    width: 16px;
    height: 16px;
  }

  .pull-request-timeline-author .github-avatar-fallback {
  }

  .pull-request-timeline-actor {
    min-width: 0;
    color: #f8fafc;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pull-request-timeline-text {
    min-width: 0;
    color: #dbe7f3;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .pull-request-timeline-time {
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    align-self: start;
  }

  .pull-request-timeline-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    box-sizing: border-box;
    width: 100%;
    margin: 8px 0 0;
    padding: 8px 12px;
    border: 1px dashed rgba(148, 163, 184, 0.22);
    border-radius: 10px;
    background: rgba(15, 23, 42, 0.36);
    color: #cbd5e1;
    font: inherit;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .pull-request-timeline-toggle:hover {
    background: rgba(15, 23, 42, 0.36);
    border-color: rgba(148, 163, 184, 0.3);
    color: #e2e8f0;
  }

  .pull-request-timeline-toggle-expand::after,
  .pull-request-timeline-toggle-collapse::after {
    color: #7dd3fc;
    line-height: 1;
  }

  .pull-request-timeline-toggle-expand::after {
    content: "▾";
  }

  .pull-request-timeline-toggle-collapse::after {
    content: "▴";
  }

  .pull-request-timeline-toggle:focus-visible {
    outline: 2px solid rgba(56, 189, 248, 0.4);
    outline-offset: 2px;
  }

  .notification-history-resend-form {
    margin-left: auto;
  }

  .pull-request-tracking-control-form {
    margin-left: auto;
  }

  .tracking-control {
    display: inline-flex;
    gap: 4px;
    padding: 3px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.75);
    border: 1px solid rgba(148, 163, 184, 0.22);
  }

  .tracking-control-segment {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px 10px;
    border-radius: 999px;
    font-weight: 700;
    white-space: nowrap;
  }

  .tracking-control-segment-active {
    cursor: default;
  }

  .tracking-control-segment-inactive {
    color: #94a3b8;
  }

  .tracking-control-tracked .tracking-control-segment-active {
    background: rgba(34, 197, 94, 0.12);
    color: #86efac;
  }

  .tracking-control-untracked .tracking-control-segment-active {
    background: rgba(250, 204, 21, 0.14);
    color: #fde68a;
  }

  .tracking-control-button {
    border: 0;
    background: transparent;
    cursor: pointer;
    color: inherit;
    font-family: inherit;
    line-height: inherit;
  }

  .tracking-control-tracked .tracking-control-button:hover {
    color: #bbf7d0;
  }

  .tracking-control-untracked .tracking-control-button:hover {
    color: #fef08a;
  }

  .tracking-control-button:focus-visible {
    outline: 2px solid rgba(56, 189, 248, 0.4);
    outline-offset: 2px;
  }

  .raw-events-meta-row {
    margin-bottom: 12px;
  }

  .logs-entry-time {
    color: #94a3b8;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .logs-entry-message {
    min-width: 0;
    font-size: 1rem;
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
    color: #94a3b8;
    font-size: 1rem;
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
    border-radius: 10px;
  }

  .raw-event-details {
    margin-top: 10px;
  }

  .raw-event-details summary {
    cursor: pointer;
    color: #7dd3fc;
    user-select: none;
  }

  .raw-event-json {
    overflow-x: auto;
    margin: 12px 0 0;
    padding: 12px;
    border-radius: 12px;
    background: rgba(23, 28, 35, 0.96);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: #cbd5e1;
    line-height: 1.5;
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
    border-radius: 999px;
    padding: 4px 8px;
    font-weight: 600;
    white-space: nowrap;
  }

  .history-pill {
    background: rgba(148, 163, 184, 0.14);
    color: #cbd5e1;
  }

  .github-identity-pill {
    gap: 6px;
    background: rgba(148, 163, 184, 0.14);
    color: #cbd5e1;
  }

  .github-identity-label {
    color: #94a3b8;
  }

  .github-identity-login {
    color: #e2e8f0;
  }

  .github-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.14);
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
    color: #7dd3fc;
    line-height: 1;
  }

  .log-level-debug {
    background: rgba(148, 163, 184, 0.14);
    color: #cbd5e1;
  }

  .log-level-info {
    background: rgba(56, 189, 248, 0.16);
    color: #7dd3fc;
  }

  .log-level-warn {
    background: rgba(250, 204, 21, 0.14);
    color: #fde68a;
  }

  .log-level-error {
    background: rgba(248, 113, 113, 0.12);
    color: #fca5a5;
  }

  .delivery-pending {
    background: rgba(250, 204, 21, 0.14);
    color: #fde68a;
  }

  .delivery-sent {
    background: rgba(34, 197, 94, 0.12);
    color: #86efac;
  }

  .delivery-failed {
    background: rgba(248, 113, 113, 0.12);
    color: #fca5a5;
  }

  .notification-history-time {
    color: #94a3b8;
  }

  .pull-request-subtle {
    display: block;
    margin-top: 6px;
    color: #94a3b8;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 8px 12px;
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 999px;
    background: rgba(25, 30, 38, 0.98);
    color: #e2e8f0;
    font: inherit;
    cursor: pointer;
    text-decoration: none;
  }

  .action-button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .pagination-button {
    min-width: 88px;
  }

  .icon-button {
    width: 34px;
    height: 34px;
    padding: 0;
    color: #cbd5e1;
  }

  .icon-button-svg {
    width: 16px;
    height: 16px;
  }

  .primary-button {
    border-color: rgba(56, 189, 248, 0.4);
    background: rgba(20, 40, 54, 0.94);
    color: #7dd3fc;
  }

  .clear-filters-link {
    padding: 4px 10px;
    font-weight: 600;
    color: #cbd5e1;
  }

  .flash-message {
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 12px;
  }

  .flash-success {
    background: rgba(34, 197, 94, 0.12);
    color: #86efac;
  }

  .flash-error {
    background: rgba(248, 113, 113, 0.12);
    color: #fca5a5;
  }

  @media (max-width: 900px) {
    .filters-grid-activity {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .filter-field-actor {
      width: auto;
    }
  }

  @media (max-width: 640px) {
    main {
      padding: 32px 16px 48px;
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

    .raw-events-header {
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
