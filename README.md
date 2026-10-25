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
npm run build
mkdir -p ~/.config/octopulse
cp -n config.example.toml ~/.config/octopulse/config.toml
```

Set `github.token` in `~/.config/octopulse/config.toml` to a GitHub token with access to the repositories you want to monitor. The copy command preserves an existing config; see [the example config](config.example.toml) for polling and retention settings.

## Use

```sh
npm start
```

Open [127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

Octopulse automatically discovers your open PRs and PRs requesting your review.

- Switch between **My PRs**, **Needs My Review**, and **Review Requests**, and filter by tracking status, PR state, or repository.
- Expand a PR to read activity and check reviews and CI. Use **Untrack** to stop monitoring it or **Retrack** to resume.
- Use **Track PR** to add another PR by its GitHub URL.
- Open **Notification History** to inspect past notifications or resend one; use **Logs** to investigate problems.

Keep the process running to receive desktop notifications. Ctrl+C stops it. Local data is stored in `~/.local/state/octopulse/`.
