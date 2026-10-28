import assert from 'node:assert/strict';

export async function githubRefresh(page, capture) {
  await page.clock.install();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  await page.locator('.pr > summary').first().click();
  await page.locator('.timeline li').first().waitFor();
  const row = await page.locator('.pr').first().elementHandle();
  let requests = 0; let outcome = 'running'; let job = null; let unavailable = false;
  await page.route('**/api/refresh', async route => {
    if (route.request().method() === 'GET') {
      if (unavailable) return route.fulfill({ status: 503, json: { error: 'Temporary status failure' } });
      const etag = `W/"${job ? `${job.id}-${job.phase}-${job.completed}-${job.total}-${job.discoveryFailed}-${job.failedPullRequests}` : 'none'}"`;
      if (route.request().headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers: { ETag: etag } });
      return route.fulfill({ json: job, headers: { ETag: etag } });
    }
    requests++;
    assert.equal(route.request().postData(), '{}');
    assert.ok(route.request().headers()['x-octopulse-action']);
    if (outcome === 'failed') return route.fulfill({ status: 503, json: { error: 'Synthetic GitHub refresh unavailable' } });
    job = { id: `refresh-${requests}`, phase: outcome === 'success' ? 'completed' : 'discovering', completed: 0, total: 0, discoveryFailed: false, failedPullRequests: 0 };
    return route.fulfill({ status: 202, json: job });
  });
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/refresh') && response.request().method() === 'POST' && response.status() === 202);
  await page.locator('#refresh').click(); await accepted;
  await page.getByText('Discovering pull requests…', { exact: true }).waitFor();
  assert.equal(await page.locator('#refresh').innerText(), 'Refreshing GitHub…');
  assert.ok(await page.locator('#refresh').isDisabled());
  assert.ok(await row.evaluate(el => el.isConnected && el.open), 'Refresh leaves existing details visible');
  assert.equal(await page.locator('#content').getAttribute('aria-busy'), null);
  await page.locator('#refresh').dispatchEvent('click');
  assert.equal(requests, 1, 'Repeated clicks cannot start duplicate refreshes');
  assert.equal(await page.locator('#refresh-meter').getAttribute('value'), null, 'Discovery has indeterminate progress');
  job = { ...job, phase: 'checking', completed: 1, total: 4 };
  await page.clock.fastForward(1_000);
  await page.getByText('Checking pull requests: 1 of 4', { exact: true }).waitFor();
  assert.equal(await page.locator('#refresh-meter').getAttribute('value'), '1');
  assert.equal(await page.locator('#refresh-meter').getAttribute('max'), '4');
  await capture('refreshing-github.png');
  const localPoll = page.waitForResponse(response => response.url().includes('/api/pull-request-timeline'));
  await page.clock.fastForward(5_000); await localPoll;
  unavailable = true;
  await page.clock.fastForward(1_000);
  await page.getByText('Connection interrupted. Retrying refresh status…', { exact: true }).waitFor();
  unavailable = false;
  const recovered = page.waitForResponse(response => response.url().endsWith('/api/refresh') && response.status() === 304);
  await page.clock.fastForward(1_000); await recovered;
  await page.getByText('Checking pull requests: 1 of 4', { exact: true }).waitFor();
  job = { ...job, completed: 3 };
  await page.reload();
  await page.getByText('Checking pull requests: 3 of 4', { exact: true }).waitFor();
  assert.equal(requests, 1, 'Reload resumes watching the existing job instead of starting another');
  const resumedRow = await page.locator('.pr').first().elementHandle();
  job = { ...job, phase: 'completed', completed: 4, discoveryFailed: true, failedPullRequests: 2 };
  await page.clock.fastForward(1_000);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('GitHub refresh incomplete'));
  assert.match(await page.locator('#status').innerText(), /discovery failed; 2 pull request checks failed/);
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.ok(await resumedRow.evaluate(el => el.isConnected), 'Unchanged rows survive a completed refresh');
  outcome = 'failed';
  await page.locator('#refresh').click();
  await page.getByText('Synthetic GitHub refresh unavailable', { exact: true }).waitFor();
  assert.ok(await page.locator('.pr').first().isVisible());
  outcome = 'success';
  await page.locator('#retry').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'GitHub refreshed.');
  assert.equal(requests, 3, 'Retry repeats the GitHub action, not just the local read');
  for (const [label, endpoint] of [['Notification History', '/api/notification-history'], ['Logs', '/api/logs']]) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).count(), 0);
    const poll = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
    await page.clock.fastForward(5_000); await poll;
  }
  return { checks: 22, status: 'pass' };
}
