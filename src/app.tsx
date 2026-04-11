import { renderToStaticMarkup } from "react-dom/server";

import type { PullRequestRecord } from "./pull-request-repository.js";

interface RenderAppDocumentOptions {
  trackedPullRequests?: PullRequestRecord[];
  inactivePullRequests?: PullRequestRecord[];
}

function AppShell({ trackedPullRequests, inactivePullRequests }: Required<RenderAppDocumentOptions>) {
  return (
    <main>
      <span className="eyebrow">Local GitHub PR pulse</span>
      <h1>Octopulse</h1>
      <p>
        Local pull request state is rendered from the persisted Octopulse database so tracked and
        inactive work is visible at a glance.
      </p>
      <div className="grid">
        <PullRequestList
          title="Tracked Pull Requests"
          emptyMessage="No tracked pull requests yet."
          pullRequests={trackedPullRequests}
        />
        <PullRequestList
          title="Inactive Pull Requests"
          emptyMessage="No inactive pull requests yet."
          pullRequests={inactivePullRequests}
        />
        <section className="panel">
          <h2>Notification History</h2>
          <p>Bundled notifications and delivery records will appear here.</p>
        </section>
        <section className="panel">
          <h2>Raw Events</h2>
          <p>Normalized activity and raw GitHub payloads will be available here.</p>
        </section>
      </div>
    </main>
  );
}

function PullRequestList({
  title,
  emptyMessage,
  pullRequests,
}: {
  title: string;
  emptyMessage: string;
  pullRequests: PullRequestRecord[];
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
                <span className="state-pill">{formatStateLabel(pullRequest)}</span>
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

            .grid {
              display: grid;
              gap: 16px;
              margin-top: 32px;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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

            .pull-request-item {
              padding: 14px;
              border-radius: 12px;
              background: rgba(30, 41, 59, 0.72);
              border: 1px solid rgba(148, 163, 184, 0.18);
            }

            .pull-request-meta {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
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

            .state-pill {
              padding: 4px 8px;
              background: rgba(148, 163, 184, 0.14);
              color: #cbd5e1;
              white-space: nowrap;
            }

            .pull-request-subtle {
              display: block;
              margin-top: 6px;
              font-size: 0.875rem;
              color: #94a3b8;
            }

            @media (max-width: 640px) {
              main {
                padding: 32px 16px 48px;
              }

              .pull-request-meta {
                align-items: flex-start;
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
            />
          </div>
        </body>
      </html>,
    ),
  ].join("");
}
