import assert from 'node:assert/strict';

export async function trackingFooter(page, capture) {
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const origin = new URL(page.url()).origin;
  await ready();
  const track = page.getByRole('button', { name: 'Track a pull request', exact: true });
  const row = page.locator('#track-row');
  assert.equal(await page.locator('#workbar #track').count(), 0);
  assert.equal(await page.locator('#content > #track-row').count(), 1);
  const lastPr = await page.locator('#content > .pr').last().boundingBox();
  const footer = await row.boundingBox();
  assert.ok(footer.y >= lastPr.y + lastPr.height - 1);
  assert.ok(footer.height <= 40 && footer.height >= 34, 'Tracking occupies a single thin row');
  const style = await track.evaluate(el => {
    const css = getComputedStyle(el);
    return { background: css.backgroundColor, border: css.borderTopWidth, decoration: css.textDecorationLine };
  });
  assert.equal(style.background, 'rgba(0, 0, 0, 0)'); assert.equal(style.border, '0px'); assert.match(style.decoration, /underline/);
  await track.focus(); await page.keyboard.press('Enter');
  await page.locator('#track-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.ok(await track.evaluate(el => el === document.activeElement), 'Dialog dismissal returns focus to the footer action');
  await capture('tracking-footer-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await track.isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture('tracking-footer-mobile.png');
  await page.goto(origin + '/?repo=missing/repo'); await ready();
  assert.ok(await track.isVisible(), 'Empty queues still offer tracking');
  await capture('tracking-footer-empty.png');
  for (const path of ['/notification-history', '/logs', '/settings']) {
    await page.goto(origin + path);
    if (path === '/settings') await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor(); else await ready();
    assert.equal(await track.count(), 0, 'Tracking is only offered on pull request queues');
  }
  await page.goto(origin); await ready();
  await track.click(); await page.locator('#track-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  return { checks: 15, status: 'pass' };
}
