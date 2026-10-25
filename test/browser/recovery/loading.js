export async function loadingRecovery(page) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const go = async path => { await page.goto(origin + path); await ready(); };
  try {
    await go('/');
    const failData = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic read failure"}' });
    await page.route('**/api/pull-request-timeline*', failData);
    await page.getByRole('button', { name: 'Merged', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic read failure' }).waitFor();
    check(await page.getByRole('button', { name: 'Merged', exact: true }).getAttribute('aria-pressed') === 'false', 'Failed filter leaves its displayed state unchanged');
    await page.unroute('**/api/pull-request-timeline*', failData);
    await page.getByRole('button', { name: 'Merged', exact: true }).click(); await ready();
    check(await page.getByRole('button', { name: 'Merged', exact: true }).getAttribute('aria-pressed') === 'true', 'Next interaction uses the displayed filter state, not the failed query');
    await page.route('**/api/pull-request-timeline*', failData);
    await page.getByRole('button', { name: 'Closed', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic read failure' }).waitFor();
    await page.unroute('**/api/pull-request-timeline*', failData);
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready();
    check(await page.getByRole('button', { name: 'Closed', exact: true }).getAttribute('aria-pressed') === 'true', 'Retry still applies the failed target query');

    await go('/');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const holdData = async route => { await held; try { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Held data failure"}' }); } catch {} };
    const failIdentity = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Identity failed independently"}' });
    await page.route('**/api/pull-request-timeline*', holdData); await page.route('**/api/me', failIdentity);
    try {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Identity failed independently' }).waitFor({ timeout: 3000 });
      check(await page.getByRole('button', { name: '＋ Track PR', exact: true }).isDisabled(), 'Identity failure is reported without waiting for stalled data');
      check(await page.locator('.pr').count() > 0, 'Fast identity failure retains useful results');
    } finally { release(); await page.unroute('**/api/pull-request-timeline*', holdData); await page.unroute('**/api/me', failIdentity); }
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready();

    const fakeTrack = route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"status":"tracked"}' });
    await page.route('**/api/tracked-pull-requests', fakeTrack);
    await page.getByRole('button', { name: '＋ Track PR', exact: true }).click();
    await page.getByLabel('GitHub pull request URL', { exact: true }).fill('https://github.com/acme/widget/pull/101');
    await page.getByRole('button', { name: 'Track pull request', exact: true }).click();
    await page.locator('#track-dialog').waitFor({ state: 'hidden' }); await ready();
    check(await page.getByRole('button', { name: '＋ Track PR', exact: true }).evaluate(el => el === document.activeElement), 'Successful tracking restores focus after refreshing results');
    await page.unroute('**/api/tracked-pull-requests', fakeTrack);
    return { checks, status: 'pass', failures: 'split requests, filter retry, and mutation focus' };
  } finally {
    await page.unroute('**/api/pull-request-timeline*'); await page.unroute('**/api/me'); await page.unroute('**/api/tracked-pull-requests');
  }
}
