export async function queueLayout(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (origin === 'http://127.0.0.1:3001') throw Error('Use a disposable web preview, not the installed service');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const go = async path => { await page.goto(origin + path); await ready(); };
  const errors = [];
  let stress = false;
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const route = async route => {
    const response = await route.fetch();
    const data = await response.json();
    const base = data.items.find(pr => pr.id === 'A');
    const titles = ['Make workflow retries reliable', 'Isolate discovery enrichment from full-import backlogs', 'Improve review routing and preserve requested-team responsibility'];
    data.items = titles.map((title, index) => {
      const pr = JSON.parse(JSON.stringify(base));
      pr.id = `design-${index}`;
      pr.snapshot.title = title;
      pr.snapshot.repository = index === 2 ? 'acme/review-platform' : 'acme/widget';
      pr.snapshot.number = 42 + index;
      pr.snapshot.authorAvatar = 'https://avatar.invalid/broken.png';
      pr.state = index === 1 ? 'draft' : 'open';
      pr.snapshot.draft = index === 1;
      pr.merge = index === 1 ? 'Blocked by rules' : index === 2 ? 'Merge conflicts' : 'No merge conflicts';
      pr.ci.outcome = index === 2 ? 'failure' : index === 0 ? 'success' : null;
      pr.ci.counts = { passing: index === 2 ? 8 : 12, pending: index === 1 ? 3 : 0, failing: index === 2 ? 2 : 0, skipped: 1, terminal: 0, unknown: 0 };
      pr.ci.uncertain = index === 1;
      pr.latestAt = new Date(Date.now() - (index + 1) * 3600000).toISOString();
      pr.queue = 'my-prs';
      if (stress) {
        pr.snapshot.title = 'VeryLongUnbrokenPullRequestTitle'.repeat(8);
        pr.snapshot.repository = 'organization/' + 'long-repository-name-'.repeat(6);
        pr.snapshot.author = 'long-author-'.repeat(5);
        pr.pendingTeams = ['organization/' + 'long-team-name-'.repeat(6)];
        pr.groups.requested = Array.from({ length: 16 }, (_, i) => ({ login: `reviewer-${i}`, avatar: null }));
      }
      return pr;
    });
    data.counts['my-prs'] = data.items.length;
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/pull-request-timeline*', route);
  await page.route('https://avatar.invalid/**', route => route.abort());
  try {
    for (const colorScheme of ['dark']) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1440, height: 1080 }); await go('/');
      check(await page.getByRole('button', { name: 'My PRs (3)', exact: true }).getAttribute('aria-pressed') === 'true', 'Queue count and selected state stay accessible');
      check(await page.locator('#result-summary').textContent() === '3 pull requests', 'Visible result count matches rows');
      check(await page.getByText('CI passed', { exact: true }).isVisible(), 'Success is labeled, not color-only');
      check(await page.getByText('CI failed', { exact: true }).isVisible(), 'Failure is labeled, not color-only');
      check(await page.getByText('ordering uncertain', { exact: true }).isVisible(), 'Uncertain CI remains visible');
      await page.waitForFunction(() => !document.querySelector('.pr-summary > .avatar img'));
      check(await page.locator('.pr-summary > .avatar').first().textContent() === 'A', 'Broken avatar falls back to an initial');
      const contrast = await page.evaluate(() => {
        const luminance = rgb => {
          const values = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
            value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
          });
          return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
        };
        return ['.row-title', '.repository', '.primary', '#tabs [aria-pressed=true]', '#filters [aria-pressed=true]'].map(selector => {
          const element = document.querySelector(selector);
          const style = getComputedStyle(element);
          let parent = element;
          while (parent.parentElement && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
          const a = luminance(style.color), b = luminance(getComputedStyle(parent).backgroundColor);
          return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
      for (const result of contrast) check(result.ratio >= 4.5, `${colorScheme} text contrast: ${result.selector} (${result.ratio.toFixed(2)})`);
      await capture(`queue-${colorScheme}.png`);
      const summary = page.locator('.pr summary').first(); await summary.focus(); await page.keyboard.press('Enter');
      check(await page.locator('.pr[open]').count() === 1, 'Keyboard expands the PR');
      check(await page.getByRole('heading', { name: 'Activity timeline' }).first().isVisible(), 'Expanded activity section is visible');
      check(await page.getByRole('heading', { name: 'Current-head CI' }).first().isVisible(), 'Expanded CI section is visible');
      await capture(`queue-${colorScheme}-expanded.png`);
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${colorScheme}/${width}: no horizontal overflow`);
        const repository = await page.getByRole('combobox', { name: 'Repository', exact: true }).boundingBox();
        check(repository.width >= 140, `${width}: repository filter has usable width`);
      }
      await summary.focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => !document.querySelector('.pr[open]'));
      check(await page.locator('.pr[open]').count() === 0, 'Keyboard collapses the PR');
      stress = true;
      await page.setViewportSize({ width: 1280, height: 900 }); await go('/');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${colorScheme}: long titles, repositories, authors, teams and sixteen reviewers fit desktop`);
      stress = false;
    }
    await page.unroute('**/api/pull-request-timeline*', route);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await go('/?repo=missing/repo');
    check(await page.getByRole('heading', { name: 'No matching pull requests' }).isVisible(), 'Empty state explains the result');
    check(await page.getByRole('button', { name: 'Clear filters', exact: true }).isVisible(), 'Empty state keeps its recovery controls');
    await page.getByRole('button', { name: '＋ Track PR', exact: true }).click();
    check(await page.getByLabel('GitHub pull request URL', { exact: true }).evaluate(el => el === document.activeElement), 'Dialog focuses its URL field');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Tracking dialog fits viewport');
    await page.keyboard.press('Escape');
    check(await page.getByRole('button', { name: '＋ Track PR', exact: true }).evaluate(el => el === document.activeElement), 'Dialog restores focus to trigger');
    check(errors.length === 0, `No runtime errors: ${errors.join('; ')}`);
    return { checks, status: 'pass', theme: 'dark', widths: [1280, 1440, 1920] };
  } finally {
    await page.unroute('**/api/pull-request-timeline*', route);
    await page.unroute('https://avatar.invalid/**');
    page.off('pageerror', onError);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
