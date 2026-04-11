# Octopulse

Octopulse is a local Linux app that tracks GitHub pull request activity, stores a local history, shows a localhost UI, and sends desktop notifications for notable PR events.

## What It Does

- auto-discovers open pull requests authored by the configured GitHub user
- keeps discovering newly opened authored pull requests on a recurring interval
- lets you manually track any `github.com` pull request by URL
- keeps inactive pull requests and notification history visible in the local UI
- polls GitHub for comments, reviews, PR state changes, commits, and GitHub Actions workflow outcomes
- bundles most notifications per pull request while sending review approvals and change requests immediately
- optionally uses OpenAI to classify bot-authored comments and reviews before notifying

## Requirements

- Linux
- `systemd --user` for the managed service flow
- `mise`
- Node.js 22 via `mise`
- a GitHub personal access token that can read the repositories you want to track
- optional: an OpenAI API key for bot-comment and bot-review classification
- optional: `notify-send` support for desktop notifications

## Local Setup

From the repo root:

```bash
mise install
npm install
```

Create the config file at `~/.config/octopulse/config.toml`:

```toml
[github]
token = "ghp_replace_with_your_token"

# Optional. Used only for bot-authored comment/review classification.
#[openai]
#api_key = "sk_replace_with_your_key"

# Optional timing overrides.
#[timings]
#tracked_poll_interval = "1m"
#discovery_poll_interval = "5m"
#debounce_window = "1m"
#grace_period = "7 days"
```

Default paths:

- config: `~/.config/octopulse/config.toml`
- state directory: `~/.local/state/octopulse`
- database: `~/.local/state/octopulse/octopulse.db`

## Running Locally

Start the app in the foreground:

```bash
npm run start
```

The app:

- validates the config and GitHub token on startup
- initializes the SQLite database and applies migrations
- starts a localhost-only UI at `http://127.0.0.1:3000`
- exposes a health endpoint at `http://127.0.0.1:3000/health`
- runs recurring authored-PR discovery and tracked-PR polling in the same process

For active development:

```bash
npm run dev
```

## UI Overview

The root page shows:

- tracked pull requests
- inactive pull requests
- notification history
- normalized raw events with expandable stored payloads
- filters for PR state, repository, event type, decision state, actor type, and date range

Manual actions in the UI:

- track a pull request by URL
- untrack an active pull request
- re-track an inactive pull request

## Verification

Run the repo checks:

```bash
npm test
npm run typecheck
npm run build
```

## Operations

For persistent local service setup, service management, logs, and runtime data locations, see `docs/user-service-setup.md`.
