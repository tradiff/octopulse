# Octopulse

Octopulse is a local Linux app that tracks GitHub pull request activity, stores a local history, shows a localhost UI, and sends desktop notifications for notable PR events.

## What It Does

- auto-discovers open pull requests authored by the configured GitHub user
- auto-discovers open pull requests where the configured GitHub user is requested as a reviewer
- keeps discovering newly opened authored and review-requested pull requests on a recurring interval
- lets you manually track any `github.com` pull request by URL
- keeps inactive pull requests and notification history visible in the local UI
- polls GitHub for comments, reviews, PR state changes, commits, and GitHub Actions workflow outcomes
- polls closed PRs every 15 minutes during their configured grace period; post-close notifications can be delayed by up to 15 minutes
- bundles most notifications per pull request while sending review approvals and change requests immediately
- sends immediate desktop notifications when newly discovered pull requests request your review
- optionally uses Jev through a System One compatible provider to classify bot-authored comments and reviews before notifying

## Requirements

- Linux
- `systemd --user` for the managed service flow
- `mise`
- Node.js 22 via `mise`
- a GitHub personal access token that can read the repositories you want to track
- optional: a System One compatible provider's base URL and API key (such as OpenRouter or TypeSafe) for bot-comment and bot-review classification
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

# Optional file logging settings.
#[logging]
#level = "info"
#retention = "14 days"

# Optional raw GitHub payload retention. Normalized events and notifications remain.
#[history]
#raw_payload_retention = "30 days"

# Optional. Used only for bot-authored comment/review classification.
#[system_one]
#base_url = "https://openrouter.ai/api/v1"
#api_key = "replace_with_your_provider_key"
#model = "jev-latest"

# Optional timing overrides.
#[timings]
#tracked_poll_interval = "1m"
#discovery_poll_interval = "5m"
#grace_period = "7 days"
```

### Bot activity classification

Uncomment `[system_one]`, `base_url`, and `api_key` to enable classification. Any provider implementing the [TypeSafe System One API](https://docs.typesafe.ai/api) is supported through the official `@typesafe-ai/sdk`; this is not the OpenAI chat-completions API.

- OpenRouter: `base_url = "https://openrouter.ai/api/v1"`, with an OpenRouter API key.
- TypeSafe directly: `base_url = "https://api.typesafe.ai/v1"`, with a TypeSafe API key.
- API roots without `/v1` are also accepted (for example, `https://openrouter.ai/api`). Requests append `/v1/systemone` to the API root; trailing slashes are accepted.
- `model` is optional and defaults to `jev-latest`, supported by both providers. Override it to pin a version or use another System One model.

Only bot comment/review text is sent as state. A typed Choice answer selects `notify` or `suppress`; the selected probability and confidence are stored as the decision summary instead of generated prose. Confidence is recorded, not used as an additional suppression threshold. Missing configuration, request failures, or malformed responses keep the existing fallback: notify rather than silently suppress. Requests time out after 10 seconds with no retries.

**Migrating:** replace the old `[openai]` section with `[system_one]`, set the provider's base URL, and use its API key. Existing `[openai]` configuration is rejected with a migration message; keys are not reused for a different provider. Restart the app after editing the config. Keys remain in the local config file; restrict its permissions with `chmod 600 ~/.config/octopulse/config.toml`.

Default paths:

- config: `~/.config/octopulse/config.toml`
- state directory: `~/.local/state/octopulse`
- database: `~/.local/state/octopulse/octopulse.db`
- logs: `~/.local/state/octopulse/logs/*.jsonl`

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
- runs recurring authored/review-requested PR discovery and tracked-PR polling in the same process
- shows tray icon with `Open Octopulse`, `Open Logs`, and `Quit` menu actions when started in graphical session

For active development:

```bash
npm run dev
```

## UI Overview

The UI includes pages for:

- tracked pull requests
- inactive pull requests
- recent file-backed logs with level filtering
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

To reclaim database disk space after raw payloads expire, stop the service and run:

```bash
systemctl --user stop octopulse.service
npm run maintain:database
systemctl --user start octopulse.service
```
