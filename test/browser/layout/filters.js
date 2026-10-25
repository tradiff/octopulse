export async function filterLayout(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  if (['http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin)) throw Error('Use a disposable preview');
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const ready = () => page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  for (const path of ['/', '/notification-history']) {
    for (const width of [1120, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(origin + path); await ready();
      const groups = await page.locator('#filters fieldset').evaluateAll(fieldsets => fieldsets.map(group => {
        const label = group.querySelector('legend'); const choices = group.querySelector('.filter-options');
        const selected = choices.querySelector('[aria-pressed=true]'); const inactive = choices.querySelector('[aria-pressed=false]');
        return { labelAbove: label.getBoundingClientRect().bottom <= choices.getBoundingClientRect().top,
          labelCase: getComputedStyle(label).textTransform,
          selectedColor: selected && getComputedStyle(selected).backgroundColor,
          inactiveColor: inactive && getComputedStyle(inactive).backgroundColor,
          selectedBorder: selected && getComputedStyle(selected).borderTopColor };
      }));
      check(groups.every(group => group.labelAbove && group.labelCase === 'uppercase'), `${path}/${width}: labels sit apart from the choices`);
      check(groups.filter(group => group.selectedColor && group.inactiveColor).every(group => group.selectedColor !== group.inactiveColor && group.selectedBorder === 'rgb(130, 170, 255)'), `${path}/${width}: selected choices have a distinct fill and border`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path}/${width}: filters fit the desktop width`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const merged = page.getByRole('button', { name: 'Merged', exact: true });
    await merged.focus(); await merged.press('Enter'); await ready();
    check(await merged.getAttribute('aria-pressed') === 'true' && await merged.evaluate(el => el === document.activeElement), `${path}: toggling retains state and focus`);
    check(await page.getByRole('button', { name: 'Open', exact: true }).getAttribute('aria-pressed') === 'true', `${path}: multiple states remain independently selectable`);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await ready();
    check(await page.evaluate(() => new URL(location.href).searchParams.get('pr-state') === 'all'), `${path}: clear filters still removes state restrictions`);
  }
  await page.goto(origin + '/'); await ready();
  await capture('queue-filters.png', { fullPage: false });
  await page.goto(origin + '/notification-history'); await ready();
  await capture('history-filters.png', { fullPage: false });
  return { checks, status: 'pass', widths: [1120, 1440, 1920] };
}
