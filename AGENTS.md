# AGENTS.md

## Project
- Octopulse is a local Linux app for tracking GitHub pull request activity and surfacing noteworthy events.
- The stack is Node.js with TypeScript, a static browser UI, `better-sqlite3` for persistence, direct GitHub HTTP access, optional System One bot-comment classification, and `@jellybrick/dbus-next` for desktop notifications and StatusNotifierItem/DBusMenu tray integration.

## Runtime Targets
- Linux only
- `systemd --user` service model
- localhost-only web UI
- single-process application

## Tooling
- Use `mise` for repo-managed tool versions.
- Prefer the repo's declared scripts and toolchain over ad hoc commands.

## Repository Conventions
- Keep this file focused on durable repo facts and conventions.
- Update this file when the stack, project structure, core commands, or long-lived engineering conventions change.
- Do not use this file as a temporary backlog, implementation diary, or planning scratchpad.

## Verification
- Run `npm run check`, `npm test`, and `npm run build` for implementation changes. Browser tests require Playwright Chromium; desktop integration tests require `dbus-run-session`.
- Keep automated test coverage aligned with the current implementation.
- Use disposable profiles and simulated service management for verification. Live deployment and legacy state migration are separate operations; the rewrite cannot open the legacy database schema.
