export async function commentAvatars(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const avatarUrl = 'https://avatars.githubusercontent.com/u/123456789?test=octopulse';
  // A local synthetic image keeps verification independent of GitHub and real profiles.
  const image = route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#82aaff"/></svg>' });
  const data = async route => {
    const response = await route.fetch(); const result = await response.json();
    result.items.find(item => item.event.actor?.login === 'bea').event.actor.avatar = avatarUrl;
    result.items.find(item => item.event.actor?.login === 'cam').event.actor.avatar = 'javascript:alert(1)';
    result.items.push({ ...result.items[0], event: { ...result.items[0].event, actor: null, body: '' }, bodyHtml: '' });
    await route.fulfill({ response, json: result });
  };
  await page.route(avatarUrl, image); await page.route('**/api/pull-requests/A/activity*', data);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(origin + '/');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
    await page.locator('[data-pr="A"] > summary').click();
    const header = login => page.locator('.timeline > li > .meta').filter({ has: page.locator(`.avatar[aria-label="${login}"]`) });
    const bea = header('bea').locator('.avatar');
    await page.waitForFunction(() => document.querySelector('.timeline .avatar[aria-label="bea"] img')?.naturalWidth > 0);
    check(await bea.locator('img').getAttribute('src') === avatarUrl, 'Comment uses the actor profile picture');
    check(await bea.locator('img').getAttribute('referrerpolicy') === 'no-referrer', 'Profile image does not send a referrer');
    check(await header('alex').locator('.avatar').textContent() === 'A', 'Missing picture falls back to initial');
    check(await header('cam').locator('.avatar img').count() === 0, 'Unsafe avatar URL is rejected');
    check(await header('cam').locator('.avatar').textContent() === 'C', 'Rejected picture falls back to initial');
    check(await page.locator('.timeline > li > .meta').last().locator('.avatar').count() === 0, 'Actorless activity has no invented profile');
    await capture('comment-avatars.png');
    await bea.locator('img').evaluate(image => image.dispatchEvent(new Event('error')));
    check(await bea.textContent() === 'B' && await bea.locator('img').count() === 0, 'Failed image falls back to initial');
    await page.setViewportSize({ width: 390, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Avatar headers fit narrow screens');
    return { checks, status: 'pass' };
  } finally { await page.unroute(avatarUrl, image); await page.unroute('**/api/pull-requests/A/activity*', data); }
}
