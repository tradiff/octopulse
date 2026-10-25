export async function focusAndRecovery(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const go = async path => { await page.goto(origin + path); await ready(); };
  const focused = locator => locator.evaluate(el => el === document.activeElement);
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await go('/');
    const merged = page.getByRole('button', { name: 'Merged', exact: true });
    await merged.focus(); await merged.press('Enter'); await ready();
    check(await focused(merged), 'State filtering preserves keyboard focus');
    await merged.press('Space'); await ready();
    check(await focused(merged), 'Repeated filtering preserves focus');
    const queue = page.getByRole('button', { name: /^Needs My Review/ });
    await queue.focus(); await queue.press('Enter'); await ready();
    check(await focused(queue), 'Queue changes preserve keyboard focus');
    const clear = page.getByRole('button', { name: 'Clear filters', exact: true });
    await clear.focus(); await clear.press('Enter'); await ready();
    check(await focused(clear), 'Clearing filters preserves keyboard focus');
    await go('/notification-history');
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await next.focus(); await next.press('Enter'); await ready();
    check(await page.getByRole('navigation', { name: 'Notification pages', exact: true }).evaluate(el => el === document.activeElement), 'Pagination retains a focus destination when Next becomes disabled');
    await go('/logs');
    const level = page.getByRole('combobox', { name: 'Log level', exact: true });
    await level.focus(); await level.selectOption('warn'); await ready();
    check(await focused(level), 'Log level changes preserve focus');

    await go('/');
    const before = await page.locator('.pr').allTextContents();
    const counts = await page.locator('#tabs').textContent();
    const failedData = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic local read failure"}' });
    await page.route('**/api/pull-request-timeline*', failedData);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic local read failure' }).waitFor();
    check(JSON.stringify(await page.locator('.pr').allTextContents()) === JSON.stringify(before), 'Failed refresh retains the displayed PRs');
    check(await page.locator('#tabs').textContent() === counts, 'Retained counts still describe the retained PRs');
    check(await page.locator('#identity > span').last().textContent() === '@alex', 'Data failure does not invalidate a successful identity read');
    check((await page.locator('#status').textContent()).includes('previous'), 'Retained results are explicitly marked as previous results');
    check(await page.getByRole('button', { name: '＋ Track PR', exact: true }).isEnabled(), 'Valid identity keeps Track available after a data-only failure');
    await page.unroute('**/api/pull-request-timeline*', failedData);
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready();
    check(await page.locator('#error').isHidden(), 'Retry recovers the normal view');

    const failedIdentity = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic identity failure"}' });
    await page.route('**/api/me', failedIdentity);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic identity failure' }).waitFor();
    check(await page.locator('.pr').count() > 0, 'Identity refresh failure retains existing results');
    check(await page.getByRole('button', { name: '＋ Track PR', exact: true }).isDisabled(), 'Identity failure disables Track');
    await page.locator('.pr > summary').first().click();
    check(await page.getByRole('button', { name: 'Untrack', exact: true }).first().isDisabled(), 'Identity failure disables existing row mutations');
    await page.unroute('**/api/me', failedIdentity);
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready();
    check(await page.getByRole('button', { name: '＋ Track PR', exact: true }).isEnabled(), 'Identity recovery reenables actions');

    await page.route('**/api/pull-request-timeline*', failedData);
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Synthetic local read failure' }).waitFor();
    check(await page.locator('.pr, #tabs button').count() === 0, 'First-load failure has no stale rows or queue counts');
    check(await page.locator('#result-summary').isHidden(), 'First-load failure hides result counts');
    await page.unroute('**/api/pull-request-timeline*', failedData);
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready();

    const dense = async route => {
      const response = await route.fetch(); const data = await response.json();
      const base = data.items.find(pr => pr.id === 'A');
      data.items = Array.from({ length: 24 }, (_, index) => ({ ...base, id: `dense-${index}`, snapshot: { ...base.snapshot, title: `Improve request scheduling and preserve review history ${index + 1}`, number: 100 + index } }));
      data.counts = { 'my-prs': 24, 'needs-my-review': 0, 'review-requested': 0 };
      await route.fulfill({ response, json: data });
    };
    await page.route('**/api/pull-request-timeline*', dense);
    for (const width of [1120, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 }); await go('/');
      const first = await page.locator('.pr > summary').first().boundingBox();
      check(first.y < 300, `${width}: primary results start in a compact desktop work area`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: dense queue fits horizontally`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await go('/');
    await capture('dense-queue.png', { fullPage: false });
    await page.locator('.pr > summary').first().click();
    check(await page.locator('.pr[open] .detail-toolbar').evaluate(el => el === el.parentElement.lastElementChild), 'Tracking administration follows activity and CI');
    check(await page.locator('.pr[open] .detail-toolbar button').first().isVisible(), 'Untrack remains available in expanded details');
    await capture('dense-detail.png', { fullPage: false });
    await page.unroute('**/api/pull-request-timeline*', dense);
    await go('/');
    check(await page.getByText('Ready to merge', { exact: true }).count() === 0, 'Mergeability does not claim overall readiness');
    check(await page.getByText('No merge conflicts', { exact: true }).isVisible(), 'Conflict-free mergeability has a scoped label');
    check(await page.getByText('CI in progress', { exact: true }).isVisible(), 'Pending CI remains independent and visible');

    await go('/notification-history');
    const first = page.locator('.notification-header').first();
    check(!(await first.locator('time').textContent()).includes('ago') && (await first.locator('time').textContent()).includes(':'), 'History shows a precise date and time');
    check(await first.locator('.notification-repository').count() === 0, 'History does not repeat the repository and title');
    await capture('history.png', { fullPage: false });
    check(errors.length === 0, `No runtime errors: ${errors.join('; ')}`);
    return { checks, status: 'pass', densePrs: 24 };
  } finally {
    await page.unroute('**/api/pull-request-timeline*'); await page.unroute('**/api/me'); page.off('pageerror', onError);
  }
}
