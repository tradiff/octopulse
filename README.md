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

Set `github.token` in `~/.config/octopulse/config.toml` to a GitHub token with access to the repositories you want to monitor. The copy command preserves an existing config.

## Use

```sh
npm start
```

Open [127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

- Switch between **My PRs**, **Needs My Review**, and **Review Requests**, and search or filter the queue.
- Expand a PR to read activity, check reviews and CI, or stop tracking it. Use **Track PR** to add a GitHub PR URL.
- Open **Notification History** to inspect past notifications or resend one; use **Logs** to investigate problems.

Keep the process running to receive desktop notifications. Ctrl+C stops it. Local data is stored in `~/.local/state/octopulse/`.
