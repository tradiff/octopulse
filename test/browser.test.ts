import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { webFixture } from './web-fixture.js';
import { navigation } from './browser/navigation.js';
import { repositories } from './browser/repositories.js';
import { prSummary } from './browser/pr-summary.js';
import { reviewers } from './browser/reviewers.js';
import { commentRendering } from './browser/comments/rendering.js';
import { commentAvatars } from './browser/comments/avatars.js';
import { focusAndRecovery } from './browser/recovery/focus.js';
import { loadingRecovery } from './browser/recovery/loading.js';
import { filterLayout } from './browser/layout/filters.js';
import { queueLayout } from './browser/layout/queue.js';
import { themeAndAccessibility } from './browser/layout/theme.js';
import { pagination } from './browser/pagination.js';
import { identity } from './browser/identity.js';
import { settings, settingsWithoutEnvironment, systemOneSettings, intervalPresets } from './browser/settings.js';
import { monitoringHealth } from './browser/monitoring-health.js';
import { autoRefresh } from './browser/auto-refresh.js';
import { conditionalRefresh } from './browser/conditional-refresh.js';
import { githubRefresh } from './browser/github-refresh.js';
import { trackingFooter } from './browser/tracking-footer.js';

type Capture = (name: string, options?: { fullPage?: boolean }) => Promise<void>;
const cases: [string, (page: Page, capture: Capture) => Promise<{ checks: number; status: string }>, NodeJS.ProcessEnv?][] = [
  ['quiet automatic updates', autoRefresh],
  ['conditional background requests', conditionalRefresh],
  ['manual GitHub refresh', githubRefresh],
  ['subtle tracking footer', trackingFooter],
  ['monitoring credential warnings', monitoringHealth],
  ['settings and credential sources', settings],
  ['settings without environment credentials', settingsWithoutEnvironment, {}],
  ['System One API key settings', systemOneSettings],
  ['interval and retention presets', intervalPresets],
  ['current user avatar and fallback', identity],
  ['navigation, mutations and request races', navigation],
  ['repository search and keyboard interaction', repositories],
  ['shared PR summaries', prSummary],
  ['reviewer status groups and wrapping', reviewers],
  ['comment Markdown and disclosures', commentRendering],
  ['commenter avatars and fallbacks', commentAvatars],
  ['storage pages and lazy activity', pagination],
  ['focus continuity and failed reads', focusAndRecovery],
  ['independent request recovery', loadingRecovery],
  ['filter hierarchy and wrapping', filterLayout],
  ['responsive queues and contrast', queueLayout],
  ['theme and accessibility', themeAndAccessibility],
];

test('browser interface', { timeout: 180_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [name, run, environment] of cases) {
    await t.test(name, { timeout: 30_000 }, async child => {
      const fixture = await webFixture(true, environment);
      child.after(() => fixture.close());
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
      child.after(() => context.close());
      await context.route('**/*', route => new URL(route.request().url()).origin === fixture.local.origin ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const capture: Capture = async (file, options = {}) => {
        if (process.env.OCTOPULSE_SCREENSHOTS !== '1') return;
        const directory = join('browser-captures', name.replaceAll(/[^a-z0-9]+/g, '-'));
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: join(directory, file), fullPage: options.fullPage ?? true });
      };
      await page.goto(fixture.local.origin);
      const result = await run(page, capture);
      assert.equal(result.status, 'pass');
      assert.ok(result.checks > 0);
      assert.deepEqual(errors, [], 'Browser execution has no uncaught errors');
      child.diagnostic(`${result.checks} checks passed`);
    });
  }
});
