import { renderToStaticMarkup } from "react-dom/server";

function AppShell() {
  return (
    <main>
      <span className="eyebrow">Local GitHub PR pulse</span>
      <h1>Octopulse</h1>
      <p>
        GitHub activity will appear here once authentication, discovery, and polling are wired
        in.
      </p>
      <div className="grid">
        <section className="panel">
          <h2>Tracked Pull Requests</h2>
          <p>No tracked pull requests yet.</p>
        </section>
        <section className="panel">
          <h2>Inactive Pull Requests</h2>
          <p>Closed and untracked pull requests will show up here.</p>
        </section>
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

export function renderAppDocument(): string {
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
          `}</style>
        </head>
        <body>
          <div id="app">
            <AppShell />
          </div>
        </body>
      </html>,
    ),
  ].join("");
}
