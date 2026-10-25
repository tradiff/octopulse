export async function repositories(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable web preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const parameter = name => page.evaluate(name => new URL(location.href).searchParams.get(name), name);
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const path of ['/?tab=needs-my-review', '/notification-history?pr-state=all&actor-type=bot&page=2']) {
      await page.goto(origin + path); await ready();
      const input = page.getByRole('combobox', { name: 'Repository', exact: true });
      await input.click();
      check(await input.getAttribute('aria-expanded') === 'true', `${path}: click opens the dropdown`);
      check(await page.getByRole('option', { name: 'All repositories', exact: true }).isVisible(), `${path}: all repositories is available`);
      await input.fill('SeRvI');
      check(await page.getByRole('option').count() === 1, `${path}: case-insensitive substring search narrows options`);
      check(await page.getByRole('option', { name: 'acme/service', exact: true }).isVisible(), `${path}: matching repository is shown`);
      check(await parameter('repo') === null, `${path}: typing does not apply a filter`);
      await input.press('Enter'); await ready();
      check(await parameter('repo') === 'acme/service', `${path}: Enter commits the matching option`);
      check(await input.inputValue() === 'acme/service', `${path}: selection survives rendering`);
      check(await input.evaluate(el => el === document.activeElement), `${path}: keyboard focus survives selection`);
      check(await input.getAttribute('aria-expanded') === 'false', `${path}: selection closes the dropdown`);
      if (path.startsWith('/notification-history')) {
        check(await parameter('page') === null, 'History repository selection resets pagination');
        check(await parameter('actor-type') === 'bot', 'History preserves actor filters');
      } else check(await parameter('tab') === 'needs-my-review', 'Repository selection preserves the PR queue');
      await input.fill('no-such-repository');
      check(await page.getByRole('status').filter({ hasText: 'No matching repositories' }).isVisible(), `${path}: no-match feedback is visible`);
      await input.press('Enter');
      check(await parameter('repo') === 'acme/service', `${path}: arbitrary text cannot become a repository filter`);
      await input.press('Escape');
      check(await input.inputValue() === 'acme/service' && await input.getAttribute('aria-expanded') === 'false', `${path}: Escape restores the selection`);
      await input.fill('widget'); await input.press('Tab');
      check(await input.inputValue() === 'acme/service' && await input.getAttribute('aria-expanded') === 'false', `${path}: Tab dismisses uncommitted text`);
      await input.click();
      await page.getByRole('option', { name: 'All repositories', exact: true }).click(); await ready();
      check(await parameter('repo') === '' && await input.inputValue() === '', `${path}: all repositories clears the filter`);
      await input.press('ArrowDown');
      check(await input.getAttribute('aria-expanded') === 'true', `${path}: ArrowDown reopens the dropdown`);
      await input.press('ArrowDown'); await input.press('Enter'); await ready();
      check(await parameter('repo') === 'acme/service', `${path}: arrow keys select a repository`);
      await input.click(); await page.locator('#identity').click();
      check(await input.getAttribute('aria-expanded') === 'false', `${path}: clicking outside dismisses the dropdown`);
    }
    await page.goto(origin + '/?repo=missing/repo'); await ready();
    const input = page.getByRole('combobox', { name: 'Repository', exact: true }); await input.click();
    check(await page.getByRole('option', { name: 'missing/repo', exact: true }).isVisible(), 'A selected repository absent from the current data remains selectable');
    await input.fill('widget');
    const activeOption = await input.getAttribute('aria-activedescendant');
    await input.dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true });
    check(await input.getAttribute('aria-activedescendant') === activeOption, 'IME composition does not move the active option');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
    check(await parameter('repo') === 'missing/repo', 'IME confirmation does not commit a repository filter');
    await capture('repository-search.png');
    check(errors.length === 0, `No runtime errors: ${errors.join('; ')}`);
    return { checks, status: 'pass', pages: ['Pull Requests', 'Notification History'] };
  } finally { page.off('pageerror', onError); }
}
