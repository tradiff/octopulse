import assert from 'node:assert/strict';

export async function conditionalRefresh(page) {
  await page.clock.install();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const row = await page.locator('.pr').first().elementHandle();
  const unchangedPage = page.waitForResponse(response => response.url().includes('/api/pull-request-timeline') && response.status() === 304);
  const unchangedIdentity = page.waitForResponse(response => response.url().endsWith('/api/me') && response.status() === 304);
  await page.clock.fastForward(5_000);
  const [data, me] = await Promise.all([unchangedPage, unchangedIdentity]);
  assert.ok(data.request().headers()['if-none-match']);
  assert.ok(me.request().headers()['if-none-match']);
  await page.clock.runFor(100);
  assert.ok(await row.evaluate(el => el.isConnected), '304s leave the rendered rows in place');
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.locator('#track').isEnabled(), true, 'Identity remains usable after a 304');
  await page.locator('#track').click();
  await page.getByLabel('GitHub pull request URL', { exact: true }).fill('https://github.com/acme/widget/pull/100');
  const fresh = page.waitForResponse(response => response.url().endsWith('/api/pull-request-timeline') && response.status() === 200);
  await page.getByRole('button', { name: 'Track pull request', exact: true }).click();
  const updated = await fresh;
  assert.equal(updated.request().headers()['if-none-match'], undefined, 'Mutation reloads fetch fresh data');
  await page.getByText('Manually tracked synthetic PR', { exact: true }).waitFor();
  const filtered = page.waitForResponse(response => response.url().includes('/api/pull-request-timeline?') && response.status() === 200);
  await page.getByRole('button', { name: 'Merged', exact: true }).click();
  assert.equal((await filtered).request().headers()['if-none-match'], undefined, 'A filter change cannot reuse another URL’s validator');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const manual = page.waitForResponse(response => response.url().includes('/api/pull-request-timeline') && response.status() === 200);
  await page.locator('#refresh').click();
  assert.equal((await manual).request().headers()['if-none-match'], undefined, 'Manual Refresh remains unconditional');
  return { checks: 8, status: 'pass' };
}
