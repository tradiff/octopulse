---
name: update-readme
description: Refresh Octopulse's sparse README and screenshot collage.
disable-model-invocation: true
---

# Update README

1. **Audit.** Read `README.md`, the working-tree diff, and recent commits. Check
   current behavior in the implementation, `config.example.toml`, `package.json`,
   and installer as relevant. Account for each existing README section and each
   user-facing change: keep, correct, remove, or omit under the scope below.
2. **Edit.** Keep the README sparse, covering only:
   - **Overview:** what the app does at a high level, in a short paragraph or a few bullets.
   - **Install:** prerequisites and the shortest supported installation and initial
     configuration path. Verify commands and defaults against their source.
   - **Use:** how to start and open the app and perform its main workflows.
   Preserve the logo and collage. Include a caveat only when needed for safe
   installation or use. Leave architecture, exhaustive settings, development,
   testing, packaging internals, and change history to their source or focused
   documentation; link existing docs only when useful. Completion means all
   retained claims match the current app and every remaining section serves
   overview, installation, or use.
3. **Capture.** From the repository root, run:

   ```sh
   npm run build
   node .agents/skills/update-readme/scripts/readme-screenshots.mjs
   ```

   The script requires `playwright-cli` and its Chromium browser; consult the
   `playwright-cli` skill for setup if missing. It uses synthetic data, a disposable
   profile, and an ephemeral localhost server, leaving the installed service and
   real GitHub data untouched. If UI or fixture APIs changed, adapt the bundled
   script to the current app while preserving that isolation. Completion means
   `assets/screenshots/collage.png` was regenerated successfully.
4. **Verify.** Open the generated collage and check that it shows populated,
   readable UI without loading errors or accidental clipping of featured content.
   Check README links and image paths and review the final diff for accuracy and
   scope. Report the text changes and capture result; identify any blocked check
   explicitly rather than claiming completion.
