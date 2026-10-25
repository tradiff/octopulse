export async function themeAndAccessibility(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable web preview, not an installed service');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const go = async path => { await page.goto(origin + path); await ready(); };
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    // The application stays dark even when the desktop requests a light theme.
    await page.emulateMedia({ colorScheme: 'light' });
    for (const path of ['/', '/notification-history', '/logs']) {
      await page.setViewportSize({ width: 1440, height: 1000 }); await go(path);
      check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(34, 36, 54)'), `${path}: Moon background`);
      check(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme === 'dark'), `${path}: dark-only controls`);
      check(await page.evaluate(() => getComputedStyle(document.querySelector('.masthead')).backgroundColor === 'rgb(30, 32, 48)'), `${path}: Moon navigation surface`);
      await page.waitForFunction(() => document.querySelector('.brand-symbol').complete);
      check(await page.locator('.brand-symbol').evaluate(image => image.tagName === 'IMG' && image.naturalWidth > 0 && image.naturalHeight > 0 && image.width === 48 && image.height === 42), `${path}: enlarged octopus SVG renders in the header`);
      check(await page.locator('.brand-wordmark').evaluate(el => {
        const style = getComputedStyle(el);
        return el.textContent === 'octopulse' && el.children.length === 0 && style.color === 'rgb(200, 211, 245)' && style.fontSize === '28px' && style.fontWeight === '750' && style.fontStyle === 'normal';
      }), `${path}: continuous wordmark uses uniform upright lettering`);
      check(await page.getByRole('link', { name: 'Octopulse', exact: true }).count() === 1, `${path}: styled wordmark retains its accessible name`);
      check(await page.locator('main h1, #description, main > footer').count() === 0, `${path}: no page heading, subtitle or explanatory footer`);
      if (path === '/notification-history') {
        check(await page.locator('.notification-header .badge').count() === 0, 'History omits internal delivery categories');
        check(await page.getByText('Accepted by service', { exact: true }).count() === 0, 'History omits routine successful-delivery labels');
        check(await page.locator('.notification-header > time').first().isVisible(), 'History retains notification timestamps');
      }
      const primaryText = path === '/logs' ? '.log-message' : '.row-title';
      const secondaryText = path === '/' ? '.repository' : path === '/logs' ? '.log > time' : '.notification-preview';
      check(await page.locator(primaryText).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 13, `${path}: readable primary text`);
      check(await page.locator(secondaryText).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 12, `${path}: metadata is at least 12px`);
      for (const width of [1120, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path}/${width}: no horizontal overflow`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await capture(`theme-${path === '/' ? 'queue' : path.slice(1)}.png`);
    }
    await go('/');
    const summary = page.locator('.pr > summary').first();
    check((await summary.boundingBox()).height < 120, 'PR summary is a compact desktop row');
    const heading = await page.locator('.list-headings span').nth(2).boundingBox();
    const review = await page.locator('.review-status').first().boundingBox();
    check(Math.abs(heading.x - review.x) < 2, 'Review column aligns with its heading');
    await summary.focus(); await page.keyboard.press('Enter');
    check(await page.getByRole('heading', { name: 'Review state', exact: true }).first().isVisible(), 'Full reviewer groups remain available in details');
    const expandedStyle = await page.locator('.pr[open]').first().evaluate(row => {
      const style = selector => getComputedStyle(row.querySelector(selector));
      return {
        background: getComputedStyle(row).backgroundColor,
        rail: getComputedStyle(row).boxShadow,
        summary: style('summary').backgroundColor,
        body: style('.pr-body').backgroundColor,
        comment: style('.comment-body').backgroundColor,
        ci: style('.ci').backgroundColor,
        focus: style('summary').outlineStyle,
      };
    });
    check(expandedStyle.background === 'rgb(41, 45, 67)' && expandedStyle.summary === 'rgba(0, 0, 0, 0)' && expandedStyle.body === 'rgba(0, 0, 0, 0)', 'Header and details share one expanded surface');
    check(expandedStyle.rail.includes('inset') && expandedStyle.rail.includes('rgb(130, 170, 255)'), 'Expansion rail belongs to the entire row');
    check(expandedStyle.comment === 'rgb(34, 36, 54)' && expandedStyle.ci === expandedStyle.comment, 'Comments and CI are nested darker surfaces');
    check(expandedStyle.focus === 'solid', 'Keyboard focus remains distinct from the expansion rail');
    await capture('theme-detail.png');
    await go('/?tab=needs-my-review');
    check(await page.getByText('Your review requested', { exact: true }).isVisible(), 'Direct responsibility is labeled');
    check(await page.getByText('Team review requested', { exact: true }).isVisible(), 'Team responsibility is labeled separately');
    await go('/notification-history');
    await page.locator('.notification > summary').first().click();
    check(await page.getByRole('heading', { name: 'Recorded delivery state', exact: true }).first().isVisible(), 'History reveals recorded delivery state');
    check(await page.getByText('Accepted by desktop service', { exact: true }).first().isVisible(), 'Acceptance timestamp has accurate wording');
    check(await page.getByRole('button', { name: 'Resend', exact: true }).first().isEnabled(), 'Resend remains an authenticated local action');
    await capture('theme-history-expanded.png');
    await go('/logs?level=warn');
    check(await page.locator('.log .level-warn').count() === 1, 'Exact-level logs retain severity styling');
    await capture('theme-logs.png');
    check(errors.length === 0, `No runtime errors: ${errors.join('; ')}`);
    return { checks, status: 'pass', theme: 'Tokyo Night Moon', widths: [1120, 1440, 1920] };
  } finally {
    page.off('pageerror', onError);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
