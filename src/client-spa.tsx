import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Highlight, themes } from "prism-react-renderer";

import type { RecentLogEntry } from "./logger.js";
import type { NotificationHistoryEntry } from "./notification-history.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { RawEventsEntry } from "./raw-events.js";
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

type LogLevel = "debug" | "info" | "warn" | "error";
type LogLevelFilter = "all" | LogLevel;
type AppPage = "pull-requests" | "logs" | "notification-history" | "raw-events";

interface RouteState {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  logLevelFilter: LogLevelFilter;
}

type PageFilterField = keyof UiFilterValues;

const ROOT = document.querySelector("#root");
const PULL_REQUEST_FILTER_FIELDS: readonly PageFilterField[] = ["pullRequestState", "repository"];
const ACTIVITY_FILTER_FIELDS: readonly PageFilterField[] = [
  "pullRequestState",
  "repository",
  "eventType",
  "decisionState",
  "actorClass",
  "startDate",
  "endDate",
];
const APP_PAGES: readonly AppPage[] = [
  "pull-requests",
  "notification-history",
  "raw-events",
  "logs",
];
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
  const [rawEvents, setRawEvents] = useState<RawEventsEntry[]>([]);
  const [recentLogs, setRecentLogs] = useState<RecentLogEntry[]>([]);
  const [trackFormUrl, setTrackFormUrl] = useState("");
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

    void loadBaseData();
  }, [route.currentPage, route.logLevelFilter]);

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
  const filteredNotificationHistory = useMemo(
    () => filterNotificationHistory(notificationHistory, route.uiFilters),
    [notificationHistory, route.uiFilters],
  );
  const filteredRawEvents = useMemo(
    () => filterRawEvents(rawEvents, route.uiFilters),
    [rawEvents, route.uiFilters],
  );

  const hasActiveFilters = countActivePageFilters(route.uiFilters, route.currentPage) > 0;
  const showTopFlashMessage = flashMessage && route.currentPage !== "pull-requests";

  async function loadBaseData(): Promise<void> {
    try {
      const [trackedResponse, inactiveResponse, notificationHistoryResponse, rawEventsResponse] =
        await Promise.all([
          apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/tracked-pull-requests"),
          apiFetch<{ pullRequests: PullRequestRecord[] }>("/api/inactive-pull-requests"),
          apiFetch<{ notificationHistory: NotificationHistoryEntry[] }>("/api/notification-history"),
          apiFetch<{ rawEvents: RawEventsEntry[] }>("/api/raw-events"),
        ]);

      setTrackedPullRequests(trackedResponse.pullRequests);
      setInactivePullRequests(inactiveResponse.pullRequests);
      setNotificationHistory(notificationHistoryResponse.notificationHistory);
      setRawEvents(rawEventsResponse.rawEvents);
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
      setFlashMessage(createTrackFlashMessage(result));
      await loadBaseData();
    } catch (error) {
      setFlashMessage({
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
      await loadBaseData();
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
      await loadBaseData();
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
      await loadBaseData();
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: getErrorMessage(error),
      });
    }
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const searchParams = new URLSearchParams();

    formData.forEach((value, key) => {
      if (typeof value !== "string") {
        return;
      }

      searchParams.set(key, value);
    });

    const nextFilters = readUiFilterValues(searchParams);
    navigateToHref(buildPageHref(route.currentPage, nextFilters, route.logLevelFilter));
  }

  function handleLogsSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

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

  function handleLogsRefresh(event: ReactMouseEvent<HTMLAnchorElement>): void {
    event.preventDefault();
    void loadLogs(route.logLevelFilter);
  }

  return (
    <div id="app">
      <style>{APP_STYLES}</style>
      <main>
        <h1>Octopulse</h1>
        <PageNavigation
          currentPage={route.currentPage}
          uiFilters={route.uiFilters}
          logLevelFilter={route.logLevelFilter}
          onNavigate={navigateToHref}
        />
        {showTopFlashMessage ? <FlashMessage message={flashMessage} /> : null}
        {route.currentPage === "pull-requests" ? (
          <section className="manual-track-panel">
            <details className="manual-track-details">
              <summary className="manual-track-summary">Manually track PR</summary>
              <p className="manual-track-description">
                Paste GitHub pull request URL to start tracking it locally.
              </p>
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
                    placeholder="https://github.com/octo-org/octo-repo/pull/123"
                    className="text-input"
                    value={trackFormUrl}
                    onChange={(event) => setTrackFormUrl(event.target.value)}
                  />
                  <button type="submit" className="action-button">
                    Track PR
                  </button>
                </div>
              </form>
            </details>
            {flashMessage ? <FlashMessage message={flashMessage} /> : null}
          </section>
        ) : null}
        {route.currentPage !== "logs" ? (
          <FilterPanel
            currentPage={route.currentPage}
            uiFilters={route.uiFilters}
            uiFilterOptions={uiFilterOptions}
            formKey={buildPageHref(route.currentPage, route.uiFilters, route.logLevelFilter)}
            onSubmit={handleFilterSubmit}
            onNavigate={navigateToHref}
          />
        ) : null}
        <div className="page-content">
          {route.currentPage === "pull-requests" ? (
            <PullRequestList
              title="Pull Requests"
              emptyMessage={formatPullRequestEmptyMessage(route.uiFilters, hasActiveFilters)}
              pullRequests={[...filteredTrackedPullRequests, ...filteredInactivePullRequests]}
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
              hasActiveFilters={hasActiveFilters}
              onResend={handleResendNotificationRecord}
            />
          ) : null}
          {route.currentPage === "raw-events" ? (
            <RawEventsPanel rawEvents={filteredRawEvents} hasActiveFilters={hasActiveFilters} />
          ) : null}
          {route.currentPage === "logs" ? (
            <LogsPanel
              recentLogs={recentLogs}
              logLevelFilter={route.logLevelFilter}
              formKey={route.logLevelFilter}
              onSubmit={handleLogsSubmit}
              onRefresh={handleLogsRefresh}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function FilterPanel({
  currentPage,
  uiFilters,
  uiFilterOptions,
  formKey,
  onSubmit,
  onNavigate,
}: {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  uiFilterOptions: UiFilterOptions;
  formKey: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onNavigate: (href: string) => void;
}) {
  const activeFilterCount = countActivePageFilters(uiFilters, currentPage);
  const pagePath = formatPagePath(currentPage);
  const showsActivityFilters = currentPage !== "pull-requests";

  return (
    <section className="panel filters-panel">
      <div className="panel-header">
        <div>
          <h2>Filters</h2>
          <p className="panel-description">{formatFilterDescription(currentPage)}</p>
        </div>
        <span className="count">{activeFilterCount}</span>
      </div>
      <form
        key={formKey}
        method="get"
        action={pagePath}
        className="filters-form"
        onSubmit={onSubmit}
      >
        <div className="filters-grid">
          <label className="filter-field">
            <span className="input-label">Tracked state</span>
            <select name="pr-state" defaultValue={uiFilters.pullRequestState} className="text-input">
              <option value="all">All pull requests</option>
              <option value="tracked">Tracked only</option>
              <option value="inactive">Untracked only</option>
            </select>
          </label>
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
          {showsActivityFilters ? (
            <>
              <label className="filter-field">
                <span className="input-label">Event type</span>
                <select name="event-type" defaultValue={uiFilters.eventType} className="text-input">
                  <option value="">All event types</option>
                  {uiFilterOptions.eventTypes.map((eventType) => (
                    <option key={eventType} value={eventType}>
                      {formatEventTypeLabel(eventType)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-field">
                <span className="input-label">Decision state</span>
                <select
                  name="decision-state"
                  defaultValue={uiFilters.decisionState}
                  className="text-input"
                >
                  <option value="">All decision states</option>
                  {uiFilterOptions.decisionStates.map((decisionState) => (
                    <option key={decisionState} value={decisionState}>
                      {formatDecisionStateLabel(decisionState)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-field">
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
              <label className="filter-field">
                <span className="input-label">Start date</span>
                <input
                  name="start-date"
                  type="date"
                  defaultValue={uiFilters.startDate}
                  className="text-input"
                />
              </label>
              <label className="filter-field">
                <span className="input-label">End date</span>
                <input
                  name="end-date"
                  type="date"
                  defaultValue={uiFilters.endDate}
                  className="text-input"
                />
              </label>
            </>
          ) : null}
        </div>
        <div className="filters-actions">
          <button type="submit" className="action-button primary-button">
            Apply Filters
          </button>
          <a
            href={pagePath}
            className="action-button clear-filters-link"
            onClick={(event) => handleClientNavigation(event, pagePath, onNavigate)}
          >
            Clear
          </a>
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
  hasActiveFilters,
  onResend,
}: {
  notificationHistory: NotificationHistoryEntry[];
  hasActiveFilters: boolean;
  onResend: (notificationRecordId: number) => Promise<void>;
}) {
  return (
    <section className="panel notification-history-panel">
      <div className="panel-header">
        <h2>Notification History</h2>
        <span className="count">{notificationHistory.length}</span>
      </div>
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
              <div className="notification-history-header">
                {entry.clickUrl ? (
                  <a href={entry.clickUrl} className="pull-request-link">
                    {entry.title}
                  </a>
                ) : (
                  <strong className="notification-history-title">{entry.title}</strong>
                )}
                <span className={`delivery-pill delivery-${entry.deliveryStatus}`}>
                  {formatDeliveryStatusLabel(entry.deliveryStatus)}
                </span>
              </div>
              <p className="notification-history-body">{entry.body}</p>
              <div className="notification-history-meta-row">
                <span className="history-pill">{formatSourceKindLabel(entry.sourceKind)}</span>
                {entry.decisionStates.map((decisionState) => (
                  <span key={`${entry.id}-${decisionState}`} className="history-pill">
                    {formatDecisionStateLabel(decisionState)}
                  </span>
                ))}
                <span className="notification-history-time">
                  Created {formatHistoryTimestamp(entry.createdAt)}
                </span>
                {entry.deliveredAt ? (
                  <span className="notification-history-time">
                    Delivered {formatHistoryTimestamp(entry.deliveredAt)}
                  </span>
                ) : null}
                <form
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RawEventsPanel({
  rawEvents,
  hasActiveFilters,
}: {
  rawEvents: RawEventsEntry[];
  hasActiveFilters: boolean;
}) {
  return (
    <section className="panel raw-events-panel">
      <div className="panel-header">
        <h2>Raw Events</h2>
        <span className="count">{rawEvents.length}</span>
      </div>
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
                {entry.actorLogin ? <span className="history-pill">Actor {entry.actorLogin}</span> : null}
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
    </section>
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

function LogsPanel({
  recentLogs,
  logLevelFilter,
  formKey,
  onSubmit,
  onRefresh,
}: {
  recentLogs: RecentLogEntry[];
  logLevelFilter: LogLevelFilter;
  formKey: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRefresh: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <section className="panel logs-panel">
      <div className="panel-header">
        <div>
          <h2>Logs</h2>
          <p className="panel-description">Recent flat-file logs from local runtime.</p>
        </div>
        <span className="count">{recentLogs.length}</span>
      </div>
      <form key={formKey} method="get" action="/logs" className="logs-toolbar" onSubmit={onSubmit}>
        <label className="filter-field logs-filter-field">
          <span className="input-label">Level</span>
          <select name="level" defaultValue={logLevelFilter} className="text-input">
            <option value="all">All levels</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
        <div className="logs-toolbar-actions">
          <button type="submit" className="action-button primary-button">
            Apply
          </button>
          <a href={buildLogViewerHref(logLevelFilter)} className="action-button clear-filters-link" onClick={onRefresh}>
            Refresh
          </a>
        </div>
      </form>
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
  renderAction,
}: {
  title: string;
  emptyMessage: string;
  pullRequests: PullRequestRecord[];
  renderAction?: (pullRequest: PullRequestRecord) => ReactNode;
}) {
  return (
    <section className="panel pull-request-panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <span className="count">{pullRequests.length}</span>
      </div>
      {pullRequests.length === 0 ? (
        <p>{emptyMessage}</p>
      ) : (
        <ul className="pull-request-list">
          {pullRequests.map((pullRequest) => (
            <li key={pullRequest.id} className="pull-request-item">
              <div className="pull-request-meta">
                <a href={pullRequest.url} className="pull-request-link">
                  {pullRequest.repositoryOwner}/{pullRequest.repositoryName} #{pullRequest.number}
                </a>
                <div className="pull-request-controls">
                  <span
                    className={`tracking-pill ${pullRequest.isTracked ? "tracking-pill-tracked" : "tracking-pill-untracked"}`}
                  >
                    {formatTrackingStateLabel(pullRequest)}
                  </span>
                  <span className="state-pill">{formatStateLabel(pullRequest)}</span>
                  {renderAction ? renderAction(pullRequest) : null}
                </div>
              </div>
              <strong>{pullRequest.title}</strong>
              <span className="pull-request-subtle">Author: {pullRequest.authorLogin}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FlashMessage({ message }: { message: AppFlashMessage }) {
  return <p className={`flash-message flash-${message.kind}`}>{message.text}</p>;
}

function renderPullRequestAction(
  pullRequest: PullRequestRecord,
  handlers: {
    onUntrack: (githubPullRequestId: number) => Promise<void>;
    onRetrack: (pullRequestUrl: string) => Promise<void>;
  },
): ReactNode {
  if (pullRequest.isTracked) {
    return (
      <form
        method="post"
        action={`/tracked-pull-requests/${pullRequest.githubPullRequestId}/untrack`}
        onSubmit={(event) => {
          event.preventDefault();
          void handlers.onUntrack(pullRequest.githubPullRequestId);
        }}
      >
        <button type="submit" className="action-button">
          Untrack
        </button>
      </form>
    );
  }

  return (
    <form
      method="post"
      action="/inactive-pull-requests/retrack"
      onSubmit={(event) => {
        event.preventDefault();
        void handlers.onRetrack(pullRequest.url);
      }}
    >
      <input type="hidden" name="url" value={pullRequest.url} />
      <button type="submit" className="action-button primary-button">
        Track Again
      </button>
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
  };
}

function buildLogsApiPath(logLevelFilter: LogLevelFilter): string {
  return logLevelFilter === "all" ? "/api/logs" : `/api/logs?level=${logLevelFilter}`;
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

function countActivePageFilters(filters: UiFilterValues, page: AppPage): number {
  let count = 0;

  for (const field of getPageFilterFields(page)) {
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

  for (const field of getPageFilterFields(page)) {
    if (uiFilters[field] === DEFAULT_UI_FILTERS[field]) {
      continue;
    }

    searchParams.set(formatFilterSearchParamKey(field), uiFilters[field]);
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
    case "pullRequestState":
      return "pr-state";
    case "repository":
      return "repo";
    case "eventType":
      return "event-type";
    case "decisionState":
      return "decision-state";
    case "actorClass":
      return "actor-type";
    case "startDate":
      return "start-date";
    case "endDate":
      return "end-date";
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

function formatFilterDescription(page: AppPage): string {
  if (page === "pull-requests") {
    return "Refine tracked and untracked pull requests.";
  }

  if (page === "logs") {
    return "Refine recent logs.";
  }

  if (page === "notification-history") {
    return "Refine notification history.";
  }

  return "Refine normalized raw events.";
}

function formatPullRequestEmptyMessage(uiFilters: UiFilterValues, hasActiveFilters: boolean): string {
  if (!hasActiveFilters) {
    return "No pull requests yet.";
  }

  if (uiFilters.pullRequestState === "tracked") {
    return "No tracked pull requests match current filters.";
  }

  if (uiFilters.pullRequestState === "inactive") {
    return "No untracked pull requests match current filters.";
  }

  return "No pull requests match current filters.";
}

function formatTrackingStateLabel(pullRequest: PullRequestRecord): string {
  return pullRequest.isTracked ? "Tracked" : "Untracked";
}

function formatStateLabel(pullRequest: PullRequestRecord): string {
  if (pullRequest.isDraft) {
    return "Draft";
  }

  if (pullRequest.state.length === 0) {
    return "Unknown";
  }

  return `${pullRequest.state[0]!.toUpperCase()}${pullRequest.state.slice(1)}`;
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
  const normalizedTimestamp = normalizeHistoryTimestamp(timestamp);
  const parsedTimestamp = new Date(normalizedTimestamp);

  if (Number.isNaN(parsedTimestamp.getTime())) {
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
    font-family: Inter, system-ui, sans-serif;
  }

  body {
    margin: 0;
    background: #0f172a;
    color: #e2e8f0;
  }

  #app {
    min-height: 100vh;
  }

  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 48px 24px 64px;
  }

  .eyebrow {
    display: inline-block;
    margin-bottom: 16px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.12);
    color: #7dd3fc;
    font-size: 0.875rem;
  }

  h1 {
    margin: 0 0 12px;
    font-size: clamp(2rem, 5vw, 3rem);
  }

  p {
    margin: 0;
    line-height: 1.6;
    color: #cbd5e1;
  }

  .page-nav {
    margin-top: 32px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
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
    font-size: 0.95rem;
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

  .manual-track-panel {
    margin-top: 24px;
  }

  .manual-track-details {
    padding: 12px 14px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 12px;
    background: rgba(15, 23, 42, 0.42);
  }

  .manual-track-summary {
    color: #cbd5e1;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }

  .manual-track-summary::-webkit-details-marker {
    display: none;
  }

  .manual-track-summary::before {
    content: "+";
    display: inline-block;
    width: 16px;
    color: #94a3b8;
  }

  .manual-track-details[open] .manual-track-summary::before {
    content: "-";
  }

  .manual-track-description {
    margin: 12px 0 0;
    font-size: 0.875rem;
    color: #94a3b8;
  }

  .filters-panel {
    margin-top: 32px;
  }

  .panel {
    padding: 18px;
    border: 1px solid rgba(148, 163, 184, 0.24);
    border-radius: 16px;
    background: rgba(15, 23, 42, 0.88);
    box-shadow: 0 16px 48px rgba(15, 23, 42, 0.2);
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

  .count,
  .state-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 0.75rem;
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

  .pull-request-item {
    padding: 14px;
    border-radius: 12px;
    background: rgba(30, 41, 59, 0.72);
    border: 1px solid rgba(148, 163, 184, 0.18);
  }

  .notification-history-item {
    padding: 14px;
    border-radius: 12px;
    background: rgba(30, 41, 59, 0.72);
    border: 1px solid rgba(148, 163, 184, 0.18);
  }

  .raw-events-item {
    padding: 14px;
    border-radius: 12px;
    background: rgba(30, 41, 59, 0.72);
    border: 1px solid rgba(148, 163, 184, 0.18);
  }

  .logs-item {
    padding: 6px 0;
    display: grid;
    grid-template-columns: 32px auto auto minmax(0, 1fr);
    align-items: start;
    column-gap: 12px;
  }

  .logs-item + .logs-item {
    border-top: 1px solid rgba(148, 163, 184, 0.16);
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
  }

  .filters-form {
    margin-top: 16px;
  }

  .logs-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 16px;
  }

  .filters-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }

  .filter-field {
    display: grid;
    gap: 8px;
  }

  .filters-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }

  .logs-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logs-filter-field {
    min-width: 180px;
  }

  .panel-description {
    margin-top: 4px;
    font-size: 0.875rem;
  }

  .track-form-row {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }

  .input-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: #cbd5e1;
  }

  .text-input {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid rgba(148, 163, 184, 0.24);
    border-radius: 12px;
    background: rgba(15, 23, 42, 0.92);
    color: #e2e8f0;
    font: inherit;
  }

  .text-input::placeholder {
    color: #64748b;
  }

  .text-input:focus {
    outline: 2px solid rgba(56, 189, 248, 0.4);
    outline-offset: 2px;
  }

  .pull-request-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .pull-request-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pull-request-link {
    font-size: 0.9rem;
    color: #7dd3fc;
    text-decoration: none;
    word-break: break-word;
  }

  .pull-request-link:hover {
    text-decoration: underline;
  }

  .notification-history-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .raw-events-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .notification-history-title {
    margin: 0;
  }

  .notification-history-body {
    margin-top: 10px;
    white-space: pre-line;
  }

  .notification-history-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .raw-events-meta-row {
    margin-bottom: 12px;
  }

  .logs-entry-time {
    color: #94a3b8;
    font-size: 0.875rem;
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
    font-size: 0.75rem;
  }

  .raw-event-details {
    margin-top: 10px;
  }

  .raw-event-details summary {
    cursor: pointer;
    color: #7dd3fc;
    font-size: 0.875rem;
    user-select: none;
  }

  .raw-event-json {
    overflow-x: auto;
    margin: 12px 0 0;
    padding: 12px;
    border-radius: 12px;
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.18);
    color: #cbd5e1;
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .raw-event-json code {
    display: block;
  }

  .raw-event-json-line {
    display: block;
  }

  .state-pill {
    padding: 4px 8px;
    background: rgba(148, 163, 184, 0.14);
    color: #cbd5e1;
    white-space: nowrap;
  }

  .tracking-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 4px 8px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .tracking-pill-tracked {
    background: rgba(34, 197, 94, 0.12);
    color: #86efac;
  }

  .tracking-pill-untracked {
    background: rgba(250, 204, 21, 0.14);
    color: #fde68a;
  }

  .history-pill,
  .delivery-pill,
  .log-level-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 4px 8px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .history-pill {
    background: rgba(148, 163, 184, 0.14);
    color: #cbd5e1;
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
    font-size: 0.8rem;
  }

  .pull-request-subtle {
    display: block;
    margin-top: 6px;
    font-size: 0.875rem;
    color: #94a3b8;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 8px 12px;
    border: 1px solid rgba(148, 163, 184, 0.24);
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.96);
    color: #e2e8f0;
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
    text-decoration: none;
  }

  .primary-button {
    border-color: rgba(56, 189, 248, 0.4);
    background: rgba(8, 47, 73, 0.92);
    color: #7dd3fc;
  }

  .clear-filters-link {
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

  @media (max-width: 640px) {
    main {
      padding: 32px 16px 48px;
    }

    .track-form-row {
      flex-direction: column;
    }

    .filters-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .logs-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .logs-toolbar-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .pull-request-meta {
      align-items: flex-start;
      flex-direction: column;
    }

    .pull-request-controls {
      align-items: flex-start;
      flex-direction: column;
    }

    .notification-history-header {
      flex-direction: column;
    }

    .raw-events-header {
      flex-direction: column;
    }
  }
`;
