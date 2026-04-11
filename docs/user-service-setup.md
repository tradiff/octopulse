# Octopulse User-Service Setup

Run install helper from repo root:

```bash
npm run install:user-service
```

What helper does:
- installs `octopulse.service` at `~/.config/systemd/user/octopulse.service`
- creates example config at `~/.config/octopulse/config.toml` only when file does not already exist
- leaves runtime data in `~/.local/state/octopulse/octopulse.db`

After helper runs:

```bash
systemctl --user daemon-reload
systemctl --user enable --now octopulse.service
systemctl --user status octopulse.service
journalctl --user -u octopulse.service -f
```

Required config:

```toml
[github]
token = "ghp_replace_with_your_token"
```

Optional config:

```toml
[openai]
api_key = "sk_replace_with_your_key"

[timings]
tracked_poll_interval = "1m"
discovery_poll_interval = "5m"
debounce_window = "1m"
grace_period = "7 days"
```
