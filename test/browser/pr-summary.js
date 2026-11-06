export async function prSummary(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const go = async path => { await page.goto(origin + path); await ready(); };
  const arranged = () => page.locator('.pr-summary').evaluateAll(summaries => summaries.every(el => {
    const icon = el.querySelector('.pr-state-icon'); const title = el.querySelector('.row-title');
    const image = el.querySelector('.pr-author > .avatar');
    const username = el.querySelector('.pr-author > :last-child').getBoundingClientRect();
    const a = icon.getBoundingClientRect(); const b = title.getBoundingClientRect(); const avatar = image.getBoundingClientRect();
    const history = !!el.closest('.notification');
    const lead = el.querySelector('.notification-preview')?.getBoundingClientRect() ?? b;
    const iconSize = !history && innerWidth <= 700 ? 24 : 29;
    return !el.querySelector(':scope > .avatar') && avatar.right <= username.left && username.left - avatar.right <= 5
      && Math.abs(avatar.top + avatar.height / 2 - username.top - username.height / 2) < 1
      && a.right < lead.left && Math.abs(a.top - lead.top) <= 4 && (history ? b.top >= a.bottom : avatar.top > b.bottom)
      && a.width === iconSize && a.height === iconSize && avatar.width === 20 && avatar.height === 20
      && icon.width === iconSize && icon.height === iconSize && !el.querySelector('.repository .pr-state-icon');
  }));
  const fields = summary => summary.evaluate(el => ({
    title: el.querySelector('.row-title').textContent, href: el.querySelector('.row-title').href,
    repository: el.querySelector('.repository').textContent, author: `by ${el.querySelector('.pr-author > :last-child').textContent}`,
    avatar: el.querySelector('.avatar').getAttribute('aria-label'), state: el.querySelector('.pr-state-icon').alt,
    inactive: !!el.querySelector('.tracking-status'),
  }));
  const disclosure = summary => summary.evaluate(el => {
    const identity = el.querySelector('.pr-summary');
    const style = getComputedStyle(identity, '::before');
    const git = el.querySelector('.pr-state-icon').getBoundingClientRect();
    const iconCenter = identity.getBoundingClientRect().top + parseFloat(style.top);
    return { left: style.left, transform: style.transform, shape: style.clipPath, background: style.borderTopColor,
      aligned: style.translate === '0px -50%' && Math.abs(iconCenter - (git.top + git.height / 2)) < 1,
      beforeIcon: identity.getBoundingClientRect().left + parseFloat(style.left) + parseFloat(style.width) < git.left };
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await go('/');
  const collapsedPr = await disclosure(page.locator('[data-pr="A"] > summary'));
  check(collapsedPr.left === '-23px' && collapsedPr.beforeIcon, 'PR disclosure sits to the left of the Git icon');
  check(collapsedPr.aligned, 'Collapsed PR disclosure is centered with the Git icon');
  check(collapsedPr.shape === 'none' && collapsedPr.transform === 'matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)', 'Collapsed PR uses a right-pointing chevron');
  await page.locator('[data-pr="A"] > summary').press('Enter');
  const expandedPr = await disclosure(page.locator('[data-pr="A"] > summary'));
  check(expandedPr.transform === 'matrix(-0.707107, 0.707107, -0.707107, -0.707107, 0, 0)' && expandedPr.background === 'rgb(130, 170, 255)', 'Expanded PR disclosure points down in the accent color');
  check(expandedPr.aligned, 'Expanded PR disclosure is centered with the Git icon');
  await page.locator('[data-pr="A"] > summary').press('Space');
  await page.locator('[data-pr="A"] .review-status').evaluate(el => { el.style.minHeight = '180px'; });
  check((await disclosure(page.locator('[data-pr="A"] > summary'))).aligned, 'PR disclosure follows its Git icon when another summary column makes the row taller');
  await page.locator('[data-pr="A"] .review-status').evaluate(el => { el.style.minHeight = ''; });
  for (const width of [720, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const icon = await disclosure(page.locator('[data-pr="A"] > summary'));
    check(icon.aligned && icon.beforeIcon, `${width}: PR disclosure stays aligned when the title wraps`);
    check(await arranged(), `${width}: author avatar stays beside the username`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const queue = await fields(page.locator('[data-pr="A"] > summary > .pr-summary'));
  const repositoryIcon = page.locator('[data-pr="A"] .repository-icon');
  await repositoryIcon.evaluate(img => img.decode());
  const repositoryIconSource = await repositoryIcon.getAttribute('src');
  check(repositoryIconSource === '/repository-icon.svg?repository=acme%2Fwidget&v=2', 'Repository icon uses the full owner/repo seed and refreshed palette');
  check(await repositoryIcon.evaluate(img => img.naturalWidth === 64 && img.alt === '' && img.width === 20 && img.height === 20),
    'Repository icon loads locally, fits its metadata row and is decorative beside the repository name');
  check(JSON.stringify(queue) === JSON.stringify({
    title: 'Make workflow retries reliable', href: 'https://github.com/acme/widget/pull/7',
    repository: 'acme/widget#7', author: 'by alex', avatar: 'alex', state: 'Open', inactive: false,
  }), 'Queue renders the independently expected PR identity');
  check(!/\b\d+ activit(?:y|ies)\b/.test(await page.locator('[data-pr="A"] .pr-summary').innerText()), 'Queue omits its activity count');
  check(await arranged(), 'Queue leads with the state icon and title, with the author avatar beside the username');
  check(await page.locator('.row-title').evaluateAll(links => links.every(link => link.target === '_blank' && link.relList.contains('noreferrer'))), 'Queue PR links open in a new tab without a referrer or opener');
  await capture('pr-queue.png', { fullPage: false });
  return { checks, status: 'pass' };
}
