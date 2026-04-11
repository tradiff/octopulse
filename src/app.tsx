import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { NotificationHistoryEntry } from "./notification-history.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { RawEventsEntry } from "./raw-events.js";
import {
  DEFAULT_UI_FILTERS,
  type UiFilterOptions,
  type UiFilterValues,
} from "./ui-filters.js";

export interface AppFlashMessage {
  kind: "success" | "error";
  text: string;
}

export type AppPage = "pull-requests" | "notification-history" | "raw-events";

interface RenderAppDocumentOptions {
  trackedPullRequests?: PullRequestRecord[];
  inactivePullRequests?: PullRequestRecord[];
  notificationHistory?: NotificationHistoryEntry[];
  rawEvents?: RawEventsEntry[];
  flashMessage?: AppFlashMessage | undefined;
  uiFilters?: UiFilterValues;
  uiFilterOptions?: UiFilterOptions;
  currentPage?: AppPage;
}

type PageFilterField = keyof UiFilterValues;

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
const APP_PAGES: readonly AppPage[] = ["pull-requests", "notification-history", "raw-events"];

function AppShell({
  trackedPullRequests,
  inactivePullRequests,
  notificationHistory,
  rawEvents,
  flashMessage,
  uiFilters,
  uiFilterOptions,
  currentPage,
}: Required<RenderAppDocumentOptions>) {
  const hasActiveFilters = countActivePageFilters(uiFilters, currentPage) > 0;
  const pullRequests = [...trackedPullRequests, ...inactivePullRequests];

  return (
    <main>
      <h1>Octopulse</h1>
      <PageNavigation currentPage={currentPage} uiFilters={uiFilters} />
      {currentPage === "pull-requests" ? (
        <section className="panel manual-track-panel">
          <div className="panel-header">
            <h2>Track Pull Request</h2>
          </div>
          <p>Paste a GitHub pull request URL to start tracking it locally.</p>
          <form method="post" action="/tracked-pull-requests/manual-track" className="track-form">
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
              />
              <button type="submit" className="action-button primary-button">
                Track PR
              </button>
            </div>
          </form>
          {flashMessage ? <FlashMessage message={flashMessage} /> : null}
        </section>
      ) : null}
      <FilterPanel currentPage={currentPage} uiFilters={uiFilters} uiFilterOptions={uiFilterOptions} />
      <div className="page-content">
        {currentPage === "pull-requests" ? (
          <PullRequestList
            title="Pull Requests"
            emptyMessage={formatPullRequestEmptyMessage(uiFilters, hasActiveFilters)}
            pullRequests={pullRequests}
            renderAction={renderPullRequestAction}
          />
        ) : null}
        {currentPage === "notification-history" ? (
          <NotificationHistoryPanel
            notificationHistory={notificationHistory}
            hasActiveFilters={hasActiveFilters}
          />
        ) : null}
        {currentPage === "raw-events" ? (
          <RawEventsPanel rawEvents={rawEvents} hasActiveFilters={hasActiveFilters} />
        ) : null}
      </div>
    </main>
  );
}

function FilterPanel({
  currentPage,
  uiFilters,
  uiFilterOptions,
}: {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
  uiFilterOptions: UiFilterOptions;
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
      <form method="get" action={pagePath} className="filters-form">
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
          <a href={pagePath} className="action-button clear-filters-link">
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
}: {
  currentPage: AppPage;
  uiFilters: UiFilterValues;
}) {
  return (
    <nav className="page-nav" aria-label="Octopulse pages">
      <div className="page-nav-list">
        {APP_PAGES.map((page) => {
          const isCurrentPage = page === currentPage;

          return (
            <a
              key={page}
              href={buildPageHref(page, uiFilters)}
              className={`page-nav-link ${isCurrentPage ? "page-nav-link-current" : ""}`.trim()}
              aria-current={isCurrentPage ? "page" : undefined}
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
}: {
  notificationHistory: NotificationHistoryEntry[];
  hasActiveFilters: boolean;
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
                  <span className="history-pill">
                    {formatSourceKindLabel(entry.notificationSourceKind)}
                  </span>
                ) : null}
                {entry.notificationDeliveryStatus ? (
                  <span className={`delivery-pill delivery-${entry.notificationDeliveryStatus}`}>
                    {formatDeliveryStatusLabel(entry.notificationDeliveryStatus)}
                  </span>
                ) : null}
              </div>
              <details className="raw-event-details">
                <summary>Raw JSON</summary>
                <pre className="raw-event-json">{entry.rawPayloadJson ?? "No stored raw payload."}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
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

function formatPullRequestEmptyMessage(
  uiFilters: UiFilterValues,
  hasActiveFilters: boolean,
): string {
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

function renderPullRequestAction(pullRequest: PullRequestRecord): ReactNode {
  if (pullRequest.isTracked) {
    return (
      <form method="post" action={`/tracked-pull-requests/${pullRequest.githubPullRequestId}/untrack`}>
        <button type="submit" className="action-button">
          Untrack
        </button>
      </form>
    );
  }

  return (
    <form method="post" action="/inactive-pull-requests/retrack">
      <input type="hidden" name="url" value={pullRequest.url} />
      <button type="submit" className="action-button primary-button">
        Track Again
      </button>
    </form>
  );
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

export function renderAppDocument(options: RenderAppDocumentOptions = {}): string {
  const trackedPullRequests = options.trackedPullRequests ?? [];
  const inactivePullRequests = options.inactivePullRequests ?? [];
  const notificationHistory = options.notificationHistory ?? [];
  const rawEvents = options.rawEvents ?? [];
  const flashMessage = options.flashMessage;
  const currentPage = options.currentPage ?? "pull-requests";
  const uiFilters: UiFilterValues = options.uiFilters ?? DEFAULT_UI_FILTERS;
  const uiFilterOptions: UiFilterOptions = options.uiFilterOptions ?? {
    repositories: [],
    eventTypes: [],
    decisionStates: [],
    actorClasses: [],
  };

  return [
    "<!DOCTYPE html>",
    renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Octopulse</title>
          <style>{`
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
               border-bottom: 2px solid transparent;
               background: transparent;
               color: #94a3b8;
               font-size: 0.95rem;
               font-weight: 600;
               text-decoration: none;
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
              margin-top: 32px;
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

            .notification-history-panel {
              grid-column: 1 / -1;
            }

            .raw-events-panel {
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
            .delivery-pill {
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
          `}</style>
        </head>
        <body>
          <div id="app">
              <AppShell
                trackedPullRequests={trackedPullRequests}
                inactivePullRequests={inactivePullRequests}
                notificationHistory={notificationHistory}
                rawEvents={rawEvents}
                flashMessage={flashMessage}
                uiFilters={uiFilters}
                uiFilterOptions={uiFilterOptions}
                currentPage={currentPage}
              />
            </div>
          </body>
        </html>,
    ),
  ].join("");
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
  return page === "pull-requests" ? PULL_REQUEST_FILTER_FIELDS : ACTIVITY_FILTER_FIELDS;
}

function buildPageHref(page: AppPage, uiFilters: UiFilterValues): string {
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

  if (page === "notification-history") {
    return "Notification History";
  }

  return "Raw Events";
}

function formatFilterDescription(page: AppPage): string {
  if (page === "pull-requests") {
    return "Refine tracked and untracked pull requests.";
  }

  if (page === "notification-history") {
    return "Refine notification history.";
  }

  return "Refine normalized raw events.";
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
  if (timestamp.includes("T")) {
    return timestamp.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
  }

  return `${timestamp} UTC`;
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
