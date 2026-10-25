export async function pagination(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  let activityRequests = 0;
  let failActivity = true;
  const activity = async route => {
    activityRequests++;
    if (failActivity) { await route.fulfill({ status: 503, json: { error: 'Synthetic activity failure' } }); return; }
    const response = await route.fetch({ url: origin + '/api/pull-requests/A/activity' }); const data = await response.json();
    const current = Number(new URL(route.request().url()).searchParams.get('cursor') || 1);
    const start = (current - 1) * 50;
    const count = current === 3 ? 20 : 50;
    const base = data.items[0];
    data.items = Array.from({ length: count }, (_, i) => ({ ...base, event: { ...base.event, id: `activity-${start + i}`, body: '' }, bodyHtml: `<p>Activity ${start + i}</p>` }));
    Object.assign(data, { total: 120, nextCursor: current < 3 ? String(current + 1) : null });
    await route.fulfill({ response, json: data });
  };
  const queues = async route => {
    const response = await route.fetch(); const data = await response.json();
    const current = Number(new URL(route.request().url()).searchParams.get('page') || 1);
    const base = data.items[0];
    // Reuse the real PR ID so its lazy activity endpoint remains available.
    data.items = [base]; data.counts['my-prs'] = 105;
    Object.assign(data, { page: current, pages: 3, total: 105, from: (current - 1) * 50 + 1, to: Math.min(current * 50, 105) });
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/pull-requests/A/activity*', activity);
  await page.route('**/api/pull-request-timeline*', queues);
  try {
    await page.goto(origin + '/'); await ready();
    check(activityRequests === 0, 'Collapsed cards fetch no timeline');
    check(await page.locator('.timeline > li').count() === 0, 'No timeline DOM exists initially');
    await page.locator('[data-pr="A"] > summary').click();
    await page.getByRole('button', { name: 'Retry loading activity' }).waitFor();
    check(await page.getByText(/Unable to load activity/).isVisible(), 'Timeline failure is local and recoverable');
    failActivity = false;
    await page.getByRole('button', { name: 'Retry loading activity' }).click();
    await page.getByText('50 of 120 activities loaded.', { exact: true }).waitFor();
    check(await page.locator('.timeline > li').count() === 50, 'First expansion loads one bounded page');
    await page.locator('[data-pr="A"] > summary').click();
    await page.locator('[data-pr="A"] > summary').click();
    check(activityRequests === 2, 'Reopening does not refetch a loaded timeline');
    await page.getByRole('button', { name: 'Load more activity' }).click();
    await page.getByText('100 of 120 activities loaded.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load more activity' }).focus();
    await page.keyboard.press('Enter');
    await page.getByText('120 of 120 activities loaded.', { exact: true }).waitFor();
    check(await page.locator('.timeline > li').count() === 120, 'Older activity appends without replacing existing items');
    check(await page.getByRole('button', { name: 'Load more activity' }).count() === 0, 'Exhausted timeline hides load more');
    check(await page.locator('.activity-section').evaluate(el => el === document.activeElement), 'Keyboard focus survives the last activity page');
    await page.locator('[data-pr="A"] > summary').click();
    const pages = page.getByRole('navigation', { name: 'Pull request pages' });
    await pages.getByRole('button', { name: 'Next' }).click(); await ready();
    check(new URL(page.url()).searchParams.get('page') === '2', 'PR page navigation is URL-backed');
    await page.goBack(); await ready();
    check(new URL(page.url()).searchParams.get('page') === null, 'Back restores the previous PR page');
    await pages.getByRole('button', { name: 'Next' }).click(); await ready();
    await page.getByRole('button', { name: 'Open', exact: true }).click(); await ready();
    check(new URL(page.url()).searchParams.get('page') === null, 'Changing a PR filter resets pagination');
    await page.setViewportSize({ width: 390, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pagination fits a narrow viewport');
    await capture('pagination-mobile.png');
    return { checks, status: 'pass' };
  } finally {
    await page.unroute('**/api/pull-requests/A/activity*', activity);
    await page.unroute('**/api/pull-request-timeline*', queues);
  }
}
