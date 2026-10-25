export async function identity(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const avatarUrl = 'https://github.com/alex.png?size=64';
  await page.route(avatarUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#82aaff"/></svg>' }));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#identity img')?.naturalWidth > 0);
  const picture = page.locator('#identity .avatar');
  check(await picture.locator('img').getAttribute('src') === avatarUrl, 'Header shows the current user avatar');
  check(await page.locator('#identity > span').last().textContent() === '@alex', 'Username stays beside the avatar');
  check(await picture.getAttribute('aria-hidden') === 'true', 'Decorative avatar does not repeat the username to screen readers');
  check(await picture.locator('img').getAttribute('referrerpolicy') === 'no-referrer', 'Avatar request sends no referrer');
  await capture('identity-desktop.png');
  await picture.locator('img').evaluate(image => image.dispatchEvent(new Event('error')));
  check(await picture.textContent() === 'A' && await picture.locator('img').count() === 0, 'Failed avatar falls back to initial');
  await page.setViewportSize({ width: 390, height: 900 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Header fits narrow screens');
  await capture('identity-mobile.png');
  await page.route('**/api/me', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), login: '' } });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#identity').textContent === 'Local profile');
  check(await page.locator('#identity .avatar').count() === 0, 'Unbound local profiles have no invented avatar');
  return { checks, status: 'pass' };
}
