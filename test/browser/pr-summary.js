export async function prSummary(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const go = async path => { await page.goto(origin + path); await ready(); };
  const arranged = () => page.locator('.pr-summary').evaluateAll(summaries => summaries.every(el => {
    const icon = el.querySelector('.pr-state-icon'); const title = el.querySelector('.row-title');
    const image = el.querySelector(':scope > .avatar');
    const a = icon.getBoundingClientRect(); const b = title.getBoundingClientRect(); const avatar = image.getBoundingClientRect();
    return image && el.firstElementChild === image && image.getBoundingClientRect().right < a.left
      && a.right < b.left && Math.abs(a.top - b.top) <= 4
      && a.width === 29 && a.height === avatar.height && avatar.height === 29 && Math.abs(a.top - avatar.top) < 1
      && icon.width === 29 && icon.height === 29 && !el.querySelector('.repository .pr-state-icon');
  }));
  const fields = summary => summary.evaluate(el => ({
    title: el.querySelector('.row-title').textContent, href: el.querySelector('.row-title').href,
    repository: el.querySelector('.repository').textContent, author: el.querySelector('.pr-author').textContent,
    avatar: el.querySelector('.avatar').getAttribute('aria-label'), state: el.querySelector('.pr-state-icon').alt,
    inactive: !!el.querySelector('.tracking-status'),
  }));
  const disclosure = summary => summary.evaluate(el => {
    const identity = el.querySelector('.pr-summary');
    const style = getComputedStyle(identity, '::before');
    const avatar = el.querySelector('.avatar').getBoundingClientRect();
    const git = el.querySelector('.pr-state-icon').getBoundingClientRect();
    const iconCenter = identity.getBoundingClientRect().top + parseFloat(style.top);
    return { left: style.left, transform: style.transform, shape: style.clipPath, background: style.backgroundColor,
      aligned: style.translate === '0px -50%' && Math.abs(iconCenter - (avatar.top + avatar.height / 2)) < 1
        && Math.abs(iconCenter - (git.top + git.height / 2)) < 1,
      beforeAvatar: identity.getBoundingClientRect().left + parseFloat(style.left) + parseFloat(style.width) < avatar.left };
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await go('/');
  const collapsedPr = await disclosure(page.locator('[data-pr="A"] > summary'));
  check(collapsedPr.left === '-23px' && collapsedPr.beforeAvatar, 'PR disclosure sits to the left of the author avatar');
  check(collapsedPr.aligned, 'Collapsed PR disclosure is centered with the avatar and Git icon');
  check(collapsedPr.shape === 'polygon(25% 0px, 83.333% 50%, 25% 100%)' && collapsedPr.transform === 'none', 'Collapsed PR uses a solid right-pointing disclosure');
  await page.locator('[data-pr="A"] > summary').press('Enter');
  const expandedPr = await disclosure(page.locator('[data-pr="A"] > summary'));
  check(expandedPr.transform === 'matrix(0, 1, -1, 0, 0, 0)' && expandedPr.background === 'rgb(130, 170, 255)', 'Expanded PR disclosure points down in the accent color');
  check(expandedPr.aligned, 'Expanded PR disclosure is centered with the avatar and Git icon');
  await page.locator('[data-pr="A"] > summary').press('Space');
  await page.locator('[data-pr="A"] .review-status').evaluate(el => { el.style.minHeight = '180px'; });
  check((await disclosure(page.locator('[data-pr="A"] > summary'))).aligned, 'PR disclosure follows its avatar and Git icon when another summary column makes the row taller');
  await page.locator('[data-pr="A"] .review-status').evaluate(el => { el.style.minHeight = ''; });
  for (const width of [720, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const icon = await disclosure(page.locator('[data-pr="A"] > summary'));
    check(icon.aligned && icon.beforeAvatar, `${width}: PR disclosure stays aligned when the title wraps`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const queue = await fields(page.locator('[data-pr="A"] > summary > .pr-summary'));
  check(JSON.stringify(queue) === JSON.stringify({
    title: 'Make workflow retries reliable', href: 'https://github.com/acme/widget/pull/7',
    repository: 'acme/widget#7', author: 'by alex', avatar: 'alex', state: 'Open', inactive: false,
  }), 'Queue renders the independently expected PR identity');
  check(await page.locator('[data-pr="A"] .pr-summary').getByText('3 activities', { exact: true }).isVisible(), 'Queue retains its activity count');
  check(await arranged(), 'Queue leads with the author avatar, then state icon and title');
  await capture('pr-queue.png', { fullPage: false });
  await go('/notification-history');
  const first = page.locator('.notification').first();
  const collapsedNotification = await disclosure(first.locator('summary'));
  check(collapsedNotification.left === '-23px' && collapsedNotification.beforeAvatar, 'Notification disclosure sits to the left of the author avatar');
  check(collapsedNotification.aligned, 'Collapsed notification disclosure is centered with the avatar and Git icon');
  check(collapsedNotification.shape === collapsedPr.shape && collapsedNotification.transform === collapsedPr.transform, 'Notifications use the same solid disclosure as PRs');
  check(JSON.stringify(await fields(first.locator('.pr-summary'))) === JSON.stringify(queue), 'Both pages use the same PR identity fields, link, avatar and lifecycle');
  check(await arranged(), 'History shares the same icon/title/author arrangement');
  check(await first.locator('.notification-preview').textContent() === 'cam: ✅ approval: Approved', 'Recorded event excerpt remains distinct from PR identity');
  check(await first.locator('.notification-header > time').isVisible(), 'Notification time is retained');
  await page.evaluate(() => document.addEventListener('click', event => { if (event.target.closest('.pr-summary a')) event.preventDefault(); }));
  await first.locator('.row-title').click();
  check(!await first.evaluate(el => el.open), 'Opening the PR link does not toggle notification details');
  await first.locator('summary').focus(); await first.locator('summary').press('Enter');
  check(await first.locator('.notification-body').isVisible(), 'Notification still expands from the keyboard');
  const expandedNotification = await disclosure(first.locator('summary'));
  check(expandedNotification.transform === expandedPr.transform && expandedNotification.background === expandedPr.background, 'Expanded notification disclosure matches the PR orientation and color');
  check(expandedNotification.aligned, 'Expanded notification disclosure is centered with the avatar and Git icon');
  check(await first.getByRole('button', { name: 'Resend', exact: true }).isVisible(), 'Resend stays inside notification details');
  await capture('pr-history.png', { fullPage: false });
  const varied = async route => {
    const response = await route.fetch(); const data = await response.json();
    data.items = data.items.slice(0, 4).map((record, index) => ({ ...record,
      status: index === 1 ? 'failed' : index === 2 ? 'pending' : 'sent',
      intent: { ...record.intent, title: 'Original saved notification title' },
      pr: { ...record.pr, state: ['draft', 'merged', 'closed', 'open'][index], tracked: index !== 2,
        snapshot: { ...record.pr.snapshot, title: index === 3 ? '<img src=x onerror=alert(1)>' + 'LongTitle'.repeat(30) : `Current PR title ${index + 1}` } },
    }));
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/notification-history*', varied);
  try {
    await go('/notification-history');
    check(await page.locator('.notification-header').getByText('Original saved notification title', { exact: true }).count() === 0, 'Header uses current title rather than saved notification title');
    check(await page.locator('.notification .pr-state-icon').evaluateAll(icons => icons.map(icon => icon.alt).join(',') === 'Draft,Merged,Closed,Open'), 'Shared lifecycle icons cover all PR states');
    check(await page.locator('.notification .pr-state-icon').evaluateAll(icons => icons.every(icon => icon.getAttribute('src') === `/git-${icon.alt.toLowerCase()}-inline.svg` && icon.title === icon.alt)), 'Each lifecycle uses its matching inline SVG and tooltip');
    await page.waitForFunction(() => [...document.querySelectorAll('.notification .pr-state-icon')].every(icon => icon.complete && icon.naturalWidth > 0));
    check(await page.locator('.notification .badge').count() === 0, 'Lifecycle text badges are replaced by icons');
    check(await page.locator('.notification').nth(2).locator('.tracking-status').textContent() === 'Inactive', 'Inactive tracking is visible');
    check(await page.locator('.delivery-failed').textContent() === 'Failed' && await page.locator('.delivery-pending').textContent() === 'Pending', 'Delivery exceptions remain visible');
    check(await page.locator('.notification-header .row-title img').count() === 0, 'PR titles are inert text');
    await capture('pr-states.png', { fullPage: false });
    for (const width of [1120, 720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: shared summaries fit long titles`);
      check(await arranged(), `${width}: state stays at the first title line when long titles wrap`);
      check((await disclosure(page.locator('.notification-header').first())).beforeAvatar, `${width}: notification disclosure stays left without overlapping the avatar`);
      for (const summary of await page.locator('.notification-header').all()) {
        check((await disclosure(summary)).aligned, `${width}: notification disclosure aligns with single-line and wrapped titles`);
      }
    }
    return { checks, status: 'pass' };
  } finally { await page.unroute('**/api/notification-history*', varied); }
}
