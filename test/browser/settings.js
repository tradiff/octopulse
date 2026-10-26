import assert from 'node:assert/strict';

async function save(page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save settings' }).click();
  const result = await response;
  assert.equal(result.status(), 200);
  await page.waitForFunction(() => !document.querySelector('.settings-form button[type=submit]').disabled
    && document.querySelector('#status').textContent.startsWith('Settings saved.'));
  const body = result.request().postDataJSON();
  return { data: await result.json(), github: body.github, body };
}

export async function settings(page, capture) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.locator('#setting-login').count(), 0);
  const token = page.getByLabel('GitHub Token', { exact: true });
  const source = page.locator('#token-source');
  assert.equal(await token.inputValue(), '********************ken');
  assert.equal(await token.getAttribute('type'), 'text');
  assert.equal(await source.innerText(), 'Using $GITHUB_TOKEN');
  assert.ok(await source.evaluate(el => getComputedStyle(el).color === 'rgb(195, 232, 141)'));
  await capture('settings-desktop.png');
  assert.deepEqual((await save(page)).github, {}, 'An unchanged environment preview is never submitted as a token');
  await token.fill('browser-override');
  assert.ok(await source.isHidden(), 'Typing a token hides the environment guidance');
  assert.equal(await token.getAttribute('type'), 'text');
  await page.getByLabel('Tracked PR polling interval', { exact: true }).selectOption({ label: '2 minutes' });
  const saved = await save(page);
  assert.deepEqual(saved.github, { token: 'browser-override' });
  assert.equal(saved.data.github.token_source, 'database');
  assert.equal(await token.inputValue(), '********************ide');
  assert.ok(await source.isHidden());
  assert.deepEqual((await save(page)).github, {}, 'An unchanged database preview preserves the saved token');
  await page.reload();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await token.inputValue(), '********************ide');
  assert.equal(await page.getByLabel('Tracked PR polling interval', { exact: true }).inputValue(), '2 m');
  await token.fill('');
  assert.equal(await source.innerText(), 'Using $GITHUB_TOKEN');
  const cleared = await save(page);
  assert.deepEqual(cleared.github, { token: null });
  assert.equal(cleared.data.github.token_source, 'environment');
  assert.equal(await token.inputValue(), '********************ken');
  await page.getByLabel('Grace period', { exact: true }).selectOption({ label: '14 days' });
  await page.route('**/api/settings', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to save settings. Retry.' }) }) : route.continue());
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('Unable to save settings.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Grace period', { exact: true }).inputValue(), '14 days');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture('settings-mobile.png');
  return { checks: 24, status: 'pass' };
}

export async function settingsWithoutEnvironment(page, capture) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const token = page.getByLabel('GitHub Token', { exact: true });
  const source = page.locator('#token-source');
  assert.equal(await token.inputValue(), '');
  assert.match(await source.innerText(), /Add your GitHub token here or set the GITHUB_TOKEN environment variable/);
  assert.ok(await source.evaluate(el => getComputedStyle(el).color === 'rgb(255, 117, 127)'));
  await capture('settings-no-token.png');
  await token.fill('database-only-token');
  assert.ok(await source.isHidden());
  assert.equal((await save(page)).data.github.token_source, 'database');
  assert.equal(await token.inputValue(), '********************ken');
  await token.fill('');
  assert.ok(await source.isVisible());
  const cleared = await save(page);
  assert.deepEqual(cleared.github, { token: null });
  assert.equal(cleared.data.github.token_source, 'none');
  assert.equal(await token.inputValue(), '');
  assert.ok(await source.isVisible());
  await page.reload();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await token.inputValue(), '');
  assert.ok(await source.isVisible());
  return { checks: 13, status: 'pass' };
}

export async function systemOneSettings(page, capture) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByLabel('Enable bot-comment classification').check();
  await page.getByLabel('Provider base URL', { exact: true }).fill('https://provider.example');
  const key = page.getByLabel('API key', { exact: true });
  const hint = page.locator('#api-key-status');
  assert.equal(await key.inputValue(), '');
  assert.ok(await hint.isVisible());
  assert.ok(await hint.evaluate(el => getComputedStyle(el).color === 'rgb(255, 117, 127)'));
  assert.equal((await save(page)).data.system_one.api_key_preview, '');
  await key.fill('system-one-first-key');
  assert.equal(await key.getAttribute('type'), 'text');
  assert.ok(await hint.isHidden());
  const first = await save(page);
  assert.equal(first.body.system_one.api_key, 'system-one-first-key');
  assert.equal(await key.inputValue(), '********************key');
  assert.ok(!JSON.stringify(first.data).includes('system-one-first-key'));
  const unchanged = await save(page);
  assert.ok(!Object.hasOwn(unchanged.body.system_one, 'api_key'));
  await page.reload();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await key.inputValue(), '********************key');
  await key.fill('replacement-key-xyz');
  assert.equal(await key.inputValue(), 'replacement-key-xyz');
  assert.equal((await save(page)).data.system_one.api_key_preview, '********************xyz');
  await capture('system-one-key.png');
  await key.fill('');
  assert.ok(await hint.isVisible());
  const cleared = await save(page);
  assert.equal(cleared.body.system_one.api_key, null);
  assert.equal(cleared.data.system_one.api_key_preview, '');
  await page.reload();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await key.inputValue(), '');
  assert.ok(await hint.isVisible());
  assert.equal(await page.getByLabel('Provider base URL', { exact: true }).inputValue(), 'https://provider.example');
  assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'jev-latest');
  return { checks: 20, status: 'pass' };
}

export async function intervalPresets(page, capture) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const fields = [
    ['Tracked PR polling interval', '1 m', '30 seconds', '30 s'],
    ['Discovery interval', '5 m', '10 minutes', '10 m'],
    ['Grace period', '7 days', '3 days', '3 days'],
    ['Log retention', '14 days', '90 days', '90 days'],
    ['Raw payload retention', '30 days', '365 days', '365 days'],
  ];
  for (const [name, initial, label] of fields) {
    const control = page.getByLabel(name, { exact: true });
    assert.equal(await control.evaluate(el => el.tagName), 'SELECT');
    assert.equal(await control.inputValue(), initial);
    assert.ok(!(await control.locator('option').allTextContents()).some(text => /custom/i.test(text)));
    await control.selectOption({ label });
  }
  assert.deepEqual(await page.getByLabel('Log retention', { exact: true }).locator('option').allTextContents(),
    ['1 day', '3 days', '7 days', '14 days', '30 days', '60 days', '90 days']);
  const result = await save(page);
  assert.deepEqual(result.body.timings, { tracked_poll_interval: '30 s', discovery_poll_interval: '10 m', grace_period: '3 days' });
  assert.deepEqual(result.body.logging, { level: 'info', retention: '90 days' });
  assert.deepEqual(result.body.history, { raw_payload_retention: '365 days' });
  await page.reload();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  for (const [name, , , value] of fields) assert.equal(await page.getByLabel(name, { exact: true }).inputValue(), value);
  await capture('interval-presets-desktop.png');
  const response = await page.evaluate(async () => {
    const me = await (await fetch('/api/me')).json();
    const settings = await (await fetch('/api/settings')).json();
    const result = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Octopulse-Action': me.actionToken },
      body: JSON.stringify({ ...settings, github: {}, timings: { ...settings.timings, tracked_poll_interval: '45s' } }) });
    return result.status;
  });
  assert.equal(response, 200);
  await page.reload();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const tracked = page.getByLabel('Tracked PR polling interval', { exact: true });
  assert.equal(await tracked.inputValue(), '45 s');
  assert.equal(await tracked.locator('option:checked').innerText(), '45 s (saved value)');
  assert.equal((await save(page)).body.timings.tracked_poll_interval, '45 s');
  await tracked.selectOption({ label: '1 minute' });
  await save(page);
  assert.equal(await tracked.locator('option', { hasText: 'saved value' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture('interval-presets-mobile.png');
  return { checks: 30, status: 'pass' };
}
