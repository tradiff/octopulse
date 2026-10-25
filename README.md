<p align="center">
  <img src="assets/octopulse-mark-blue.svg" alt="Octopulse octopus logo" width="160">
</p>

# Octopulse

A Linux desktop app for tracking GitHub pull requests through a local web interface and desktop notifications.

- Paginated PR and review-request queues with search, on-demand activity timelines, rich comments, and current-head CI results.
- Desktop notifications with sounds, author avatars, and a system tray menu.
- Persistent notification history, retries, restart recovery, and resend actions.
- Cached startup, bounded GitHub polling, and redacted logs.
- SQLite storage with configurable retention and one process per profile.
- Linux x64/glibc packages with bundled Node.js and a config-preserving user-service installer.

## Configuration and startup

Copy `config.example.toml` to `~/.config/octopulse/config.toml` and set a GitHub token with access to the repositories you want to monitor. Data lives in `~/.local/state/octopulse/`; the web interface listens on `http://127.0.0.1:3000`.

From a checkout with dependencies installed:

```sh
npm run build
npm start
```

Use `[timings]`, `[logging]`, and `[history]` to configure polling and retention. System One bot-comment classification is optional; without it, the fallback policy applies.

### Offline maintenance

To prune expired raw payloads and reclaim SQLite storage, stop the service using the target profile, then run from a built checkout:

```sh
npm run maintenance -- --config "$HOME/.config/octopulse/config.toml" --profile "$HOME/.local/state/octopulse"
```

Both paths must be absolute. Maintenance requires exclusive profile access and refuses a profile in use. It makes no network requests. Restart the service afterward.

## Development and testing

Use Node.js 24+ and npm. Install dependencies with the Node runtime used for testing: SQLite requires a native module. Development is verified on Node.js 26.9.0; Linux packages bundle 24.22.1.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

`npm test` runs unit, integration, and Chromium browser tests. Linux tests require `dbus-run-session`. If browser libraries are missing, use `npx playwright install --with-deps chromium`.

`npm run test:browser` runs browser tests with fresh disposable fixtures. Set `OCTOPULSE_SCREENSHOTS=1` to save diagnostic screenshots in ignored `browser-captures/`; these are not visual snapshot comparisons.

`npm run replay` runs scenarios from `fixtures/` and writes `replay-results/report.json`. Builds clear generated output to prevent stale tests.

Tests use disposable profiles in the system's temporary `opencode/` directory, synthetic inputs, ephemeral loopback ports, private D-Bus sessions, and simulated service management. They clean up afterward without reading your default config/state, installing a live service, or sending desktop notifications.

## Preview

```sh
npm run preview
```

Open the printed localhost URL. The preview uses synthetic PRs, history, and logs in a disposable profile, with simulated tracking and delivery. Set `OCTOPULSE_RICH_COMMENTS=1` to include nested bot-review comments. Ctrl+C stops the server and removes the profile.

## Local deployment and Linux packages

### Fast local updates

For an existing managed `octopulse.service` on port 3000:

```sh
npm run deploy:user-service
```

This builds the checkout, checks SQLite/image dependencies, restarts only `octopulse.service`, and waits up to 90 seconds for local health. The first run points the managed service and launcher at this checkout, backing up their launch files in `/tmp/opencode/`. Later runs skip unchanged launch files and unnecessary service/desktop refreshes. No runtime downloads, dependency installation, or release archive are required.

Your config, rewrite profile, and other named instances are preserved. The service uses the deploying Node executable's absolute path, not shell shims. Run `npm ci` after changing Node versions. Local health and cached data are available before background GitHub verification and discovery.

This updates an existing managed installation without creating config or changing custom ports/profiles. It runs the working tree, including uncommitted changes. Failed health checks fail deployment; launch-file backups do not restore compiled code overwritten by the build.

**Legacy installations require a separate migration.** The installer and deployment refuse to overwrite unmanaged launch files. Back up existing config, state, and launch files before switching services. The legacy database is incompatible; use a fresh or existing rewrite profile.

### Release artifacts

```sh
npm run package
npm run check:package -- release/octopulse-0.1.0-linux-x64-glibc.tar.gz
```

Packages include checksum-pinned Node 24.22.1, locked production dependencies, compiled code, web assets, icons, audio, and an installer. The package check uses a disposable home and simulated service management, validates the unit with `systemd-analyze`, and checks SQLite/HTTP with an empty runtime PATH.

Extract the archive and run its installer with the bundled runtime:

```sh
./runtime/bin/node scripts/install.mjs --home "$HOME" --activate
```

Set the GitHub token, then run `systemctl --user start octopulse.service`. The installer preserves existing config and refuses to overwrite unrelated installations.

For a parallel instance, add `--instance octopulse-test --port 3001 --config "$HOME/.config/octopulse/config.toml"`. It shares config read-only but uses a separate service, profile, launcher, and desktop identity. The default service stays on port 3000.

`npm run smoke:plasma` opens an isolated Plasma/Wayland session for manual tray and notification checks. It requires KDE tools, a parent Wayland session, and Chromium, and leaves the installed app's config/state untouched. It is not part of the automated suite.

Desktop environments control notification display and lifetime, including sticky notifications. Delivery acceptance does not mean a popup was shown or read.
