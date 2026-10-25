---
name: update-readme
description: Refresh Octopulse's sparse README and screenshot collage.
disable-model-invocation: true
---

# Update README

1. **Audit.** Read the whole `README.md` and verify its claims against the current
   app. Keep, correct, or remove each section under the scope below, and add
   missing essentials. Map retained claims to their authoritative source, batch
   independent lookups, and stop investigating each claim once verified.
2. **Edit.** Keep the README sparse, covering only:
   - **Overview:** what the app does at a high level, in a short paragraph or a few bullets.
   - **Install:** prerequisites and the shortest supported installation and initial
     configuration path. Verify commands and defaults against their source.
   - **Use:** how to start and open the app and perform its main workflows.
   Keep accurate, appropriately scoped text unchanged; a screenshot-only refresh
   is valid. Preserve the logo and collage. Include a caveat only when needed for safe
   installation or use. Leave architecture, exhaustive settings, development,
   testing, packaging internals, and change history to their source or focused
   documentation; link existing docs only when useful. Completion means all
   retained claims match the current app and every remaining section serves
   overview, installation, or use.
3. **Capture.** From the repository root, run:

   ```sh
   node .agents/skills/update-readme/scripts/readme-screenshots.mjs
   ```

   The script builds the app before capture. Run it as-is. Read or adapt it only if capture fails or relevant
   UI or fixture changes warrant inspection. The script requires `playwright-cli`
   and its Chromium browser; consult the `playwright-cli` skill for setup if missing.
   It uses synthetic data, a disposable
   profile, and an ephemeral localhost server, leaving the installed service and
   real GitHub data untouched. It checks uncaught browser errors and failed local
   requests, captures to a temporary file, and compares decoded pixels and dimensions
   with the existing PNG (including uncommitted changes). It leaves the original
   bytes untouched for an identical recapture and reports `changed`, `identical`,
   or `created`. A failed capture leaves the existing collage untouched.
   If UI or fixture APIs changed, adapt the bundled
   script to the current app while preserving that isolation. Completion means
   `assets/screenshots/collage.png` was regenerated successfully.
4. **Verify.** Open the generated collage and check that it shows populated,
   readable UI without loading errors or accidental clipping of featured content.
   Use the script's comparison result; no manual PNG backup or comparison is needed.
   Preserve README edits and pre-existing changes; do not revert commits.
   Check local link targets and image paths, and verify the localhost URL against
   source without probing the installed app. Review the final diff for accuracy
   and scope. For README/image-only changes, build and capture suffice;
   implementation changes follow repository verification requirements. Report the
   text changes and capture result; identify any blocked check explicitly rather
   than claiming completion.
