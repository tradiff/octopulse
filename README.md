<p align="center">
  <img src="assets/octopulse-readme.png" alt="Octopulse octopus logo" width="280">
</p>

# Octopulse

A Linux desktop app for tracking GitHub pull requests through a local web interface and desktop notifications.

Keep up with your PRs and review requests, check reviews and CI, and get notified about noteworthy activity.

![Collage of Octopulse screenshots](assets/screenshots/collage.png)

## Install

Requires Linux, Node.js 24+, npm, and a desktop session with D-Bus for desktop notifications and tray integration.

From a checkout:

```sh
npm ci
npm run user-service:install
```

This builds the app and creates missing user service, launcher, desktop identity, and config files without overwriting existing files. It does not start or enable the service.

Set `github.token` in `~/.config/octopulse/config.toml` to a GitHub token with access to the repositories you want to monitor; see [the example config](config.example.toml) for polling and retention settings. Then enable and start the service:

```sh
systemctl --user enable --now octopulse.service
```

The service runs from this checkout using the current Node executable. After updating the checkout, use `npm run user-service:restart` to rebuild and restart an existing managed installation.

## Use

Open [127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

Octopulse automatically discovers your open PRs and PRs requesting your review.

- Switch between **My PRs**, **Needs My Review**, and **Review Requests**, and filter by tracking status, PR state, or repository.
- Expand a PR to read activity and check reviews and CI. Use **Untrack** to stop monitoring it or **Retrack** to resume.
- Use **Track PR** to add another PR by its GitHub URL.
- Open **Notification History** to inspect past notifications or resend one; use **Logs** to investigate problems.

Local data is stored in `~/.local/state/octopulse/`. To run in the foreground instead of using the service, stop the service with `systemctl --user stop octopulse.service` and run `npm start`. Ctrl+C stops the foreground process.

## Uninstall

```sh
npm run user-service:uninstall
```

This stops and disables the user service, removes Octopulse-managed service, launcher, and desktop identity files, and reloads systemd. Unmanaged files are left untouched and cause the command to stop rather than partially uninstall.

In an interactive terminal, it asks whether to delete **all Octopulse data**, defaulting to **No**. Confirming removes `~/.config/octopulse/` and `~/.local/state/octopulse/` entirely, including configuration, database, history, logs, caches, and the directories themselves. Stop any foreground Octopulse process before deleting its data.

Non-interactive runs keep all config and data. The checkout, shared parent directories, and other named instances are preserved.
