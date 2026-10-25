export async function commentRendering(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable rich-comment preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(origin + '/');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
    await page.locator('.pr > summary').first().click();
    const body = page.locator('.comment-body').filter({ has: page.getByRole('heading', { name: 'Review summary' }) });
    check(await body.locator('strong').first().textContent() === '2 findings', 'Bold Markdown is rendered');
    check(await body.locator('a').first().getAttribute('href') === 'https://github.com/acme/widget/issues/42', 'Issue link retains destination');
    check(await body.locator('code').first().textContent() === 'retryRequest()', 'Inline code is distinct');
    check(await body.locator('details').count() === 3, 'All nested disclosures survive');
    check(await body.locator('details[open]').count() === 0, 'Details default to collapsed');
    check(!await body.getByText('Retries currently reset the deadline instead of sharing it.', { exact: true }).isVisible(), 'Collapsed content is hidden');
    await capture('comments-collapsed.png');
    const outer = body.locator('summary').filter({ hasText: 'Potential timeout regression' });
    await outer.focus(); await outer.press('Enter');
    check(await body.getByText('Retries currently reset the deadline instead of sharing it.', { exact: true }).isVisible(), 'Disclosure works from keyboard');
    check(await body.locator('details[open]').count() === 1, 'Nested disclosure stays collapsed');
    await body.locator('summary').filter({ hasText: 'Verification and suggested fix' }).click();
    const tasks = body.locator('input[type=checkbox]');
    check(await tasks.count() === 2, 'Task lists show checkboxes');
    check(await tasks.nth(0).isChecked() && !await tasks.nth(1).isChecked(), 'Task completion is preserved');
    check(await tasks.nth(0).isDisabled() && await tasks.nth(1).isDisabled(), 'Task lists are read-only');
    check(await body.locator('pre code').isVisible(), 'Code block appears in nested details');
    check(await body.locator('blockquote').isVisible(), 'Quote is rendered');
    check(await body.locator('li').first().evaluate(el => getComputedStyle(el, '::before').content) === 'none', 'Comment lists do not inherit timeline dots');
    await body.locator('summary').filter({ hasText: 'Additional review notes' }).click();
    check(await body.locator('table').isVisible(), 'Markdown tables are rendered');
    await capture('comments-expanded.png');
    await body.locator('pre code').evaluate(el => { el.textContent += '\n' + 'longToken'.repeat(1000); });
    await body.locator('td').first().evaluate(el => { el.textContent = 'longCell'.repeat(500); });
    for (const width of [1120, 720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: rich comments fit viewport`);
    }
    check(await body.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth), 'Long code scrolls inside its block');
    check(errors.length === 0, `No runtime errors: ${errors.join('; ')}`);
    return { checks, status: 'pass' };
  } finally { page.off('pageerror', onError); }
}
