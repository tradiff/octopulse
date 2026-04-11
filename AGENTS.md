# AGENTS.md

## Project
- Octopulse is a local Linux app for tracking GitHub pull request activity and surfacing noteworthy events.
- The intended stack is Node.js with TypeScript, React for the local UI, SQLite for persistence, Octokit for GitHub access, OpenAI for limited bot-comment classification, and DBus or `libnotify` for desktop notifications.

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
- Run the repo's `test`, `typecheck`, and `build` commands when those commands exist and are relevant to the change.
- Keep automated test coverage aligned with the current implementation.
