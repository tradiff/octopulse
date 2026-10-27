import assert from 'node:assert/strict';

export async function monitoringHealth(page, capture) {
  let state = 'missing_token';
  await page.route('**/api/me', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), monitoring: { state, since: '2026-10-27T12:00:00Z' } } });
  });
  await page.route('**/api/monitoring', route => route.fulfill({ json: { state, since: '2026-10-27T12:00:00Z' } }));
  await page.clock.install();
  await page.reload();
  const warning = page.locator('#monitoring-warning');
  await warning.getByText('GitHub monitoring is off', { exact: true }).waitFor();
  assert.match(await warning.innerText(), /No GitHub token is configured/);
  assert.ok(await page.getByText('Make workflow retries reliable', { exact: true }).isVisible(), 'Saved PRs remain available');
  await capture('monitoring-missing-desktop.png');
  await warning.getByRole('link', { name: 'Open Settings' }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.ok(await warning.isVisible(), 'The warning persists on Settings');
  state = 'authentication_failed';
  await page.clock.fastForward(30_000);
  await warning.getByText('GitHub authentication failed', { exact: true }).waitFor();
  assert.match(await warning.innerText(), /expired or been revoked/);
  const before = await warning.innerText();
  await page.clock.fastForward(60_000);
  assert.equal(await warning.innerText(), before, 'Polling preserves the existing warning');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture('monitoring-expired-mobile.png');
  state = 'ready';
  await page.clock.fastForward(30_000);
  await warning.waitFor({ state: 'hidden' });
  return { checks: 8, status: 'pass' };
}
