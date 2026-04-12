# Octopulse User-Service Setup

This document covers persistent local setup, service management, logs, and the runtime files Octopulse uses.

## Install The User Service

From the repo root:

```bash
mise install
npm install
npm run install:user-service
```

The install helper:

- writes `octopulse.service` to `~/.config/systemd/user/octopulse.service`
- creates `~/.config/octopulse/config.toml` only if it does not already exist
- uses `mise exec -- npm run start` as the service command
- leaves runtime data under `~/.local/state/octopulse`

## Configure Octopulse

Required config:

```toml
[github]
token = "ghp_replace_with_your_token"
```

Optional config:

```toml
[logging]
level = "info"
retention = "14 days"

[openai]
api_key = "sk_replace_with_your_key"

[timings]
tracked_poll_interval = "1m"
discovery_poll_interval = "5m"
grace_period = "7 days"
```

Supported timing units include `ms`, `s`, `m`, `h`, and `day` or `days`.
Supported log levels are `debug`, `info`, `warn`, and `error`.

## Service Management

After the install helper runs:

```bash
systemctl --user daemon-reload
systemctl --user enable --now octopulse.service
```

Useful service commands:

```bash
systemctl --user status octopulse.service
systemctl --user restart octopulse.service
systemctl --user stop octopulse.service
systemctl --user disable octopulse.service
```

The service is configured with `Restart=on-failure`, so systemd will try to bring it back if the process exits unexpectedly.

Tray icon behavior:

- foreground runs in a graphical session show tray icon with `Open Octopulse`, `Open Logs`, and `Quit`
- `systemd --user` service runs usually do not expose tray icon unless the service inherits the desktop session environment

## Logs And Debugging

Follow the live logs:

```bash
journalctl --user -u octopulse.service -f
```

Octopulse also writes structured JSONL log files under `~/.local/state/octopulse/logs`.
The app mirrors the same entries to stdout and stderr, so journald still receives them.

Show recent logs:

```bash
journalctl --user -u octopulse.service -n 100
```

Inspect recent file-backed logs in the UI:

- open `http://127.0.0.1:3000/logs`
- use the level filter to narrow to `debug`, `info`, `warn`, or `error`
- use the Refresh action to reload recent entries from disk

Log retention defaults to `14 days`. Older daily log files are pruned automatically.

Common debugging checks:

- confirm the config file exists at `~/.config/octopulse/config.toml`
- confirm `[github].token` is set to a non-empty token
- check service status with `systemctl --user status octopulse.service`
- check startup failures in the journal if the UI is not reachable
- run `npm run start` from the repo root to reproduce startup issues in the foreground

When startup succeeds, Octopulse logs the localhost UI origin and the authenticated GitHub login.

## Runtime Locations

- user service unit: `~/.config/systemd/user/octopulse.service`
- config file: `~/.config/octopulse/config.toml`
- state directory: `~/.local/state/octopulse`
- SQLite database: `~/.local/state/octopulse/octopulse.db`
- log directory: `~/.local/state/octopulse/logs`

The app keeps raw GitHub payloads, normalized events, notification history, and tracked pull request state in the SQLite database.

## Runtime Behavior

The service runs a single local process that:

- starts a localhost-only web UI at `http://127.0.0.1:3000`
- exposes a health endpoint at `http://127.0.0.1:3000/health`
- performs first-run authored and review-requested pull request discovery
- continues recurring authored/review-requested PR discovery every 5 minutes by default
- polls tracked pull requests every minute by default
- stores data indefinitely unless you remove the state directory manually
