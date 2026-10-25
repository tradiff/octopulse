export async function reviewers(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  let checks = 0;
  let scenario = 'mixed';
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  await page.route('**/api/pull-request-timeline*', async route => {
    const response = await route.fetch(); const data = await response.json();
    data.items = data.items.filter(pr => pr.id === 'A');
    data.items[0].groups = {
      approvers: [{ login: 'approved', avatar: 'https://avatars.example/failed.png' }],
      commenters: [{ login: 'commented', avatar: null }, { login: 'another-commenter', avatar: null }],
      decliners: [{ login: 'blocker', avatar: null }],
      requested: [{ login: 'requested', avatar: null }],
    };
    if (scenario === 'reported') data.items[0].groups = {
      approvers: [], requested: [], decliners: [{ login: 'blocker', avatar: null }],
      commenters: Array.from({ length: 4 }, (_, i) => ({ login: `commenter-${i}`, avatar: null })),
    };
    if (scenario === 'many' || scenario === 'empty') data.items[0].groups = {
      approvers: [], commenters: [], decliners: [],
      requested: scenario === 'many' ? Array.from({ length: 24 }, (_, i) => ({ login: `reviewer-${i}`, avatar: null })) : [],
    };
    await route.fulfill({ response, json: data });
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const card = page.locator('[data-pr="A"]');
  const summary = card.locator(':scope > summary');
  const people = summary.locator('.reviewer-avatar:visible');
  check((await people.evaluateAll(items => items.map(item => item.getAttribute('aria-label')))).join('|')
    === 'Changes requested: blocker|Requested: requested|Approved: approved|Commented: commented|Commented: another-commenter', 'All reviewers are visible, with action-first labels and blockers first');
  check(await summary.locator('.reviewer-avatar').evaluateAll(avatars => avatars.every(avatar =>
    avatar.querySelector('.reviewer-tooltip').textContent === avatar.getAttribute('aria-label'))), 'Visible tooltips match the action-first accessible labels');
  check(await summary.locator('.reviewer-group > svg').count() === 4, 'Each state has one shared SVG icon, not one per person');
  check(await summary.locator('.reviewer-group:visible').count() === 4, 'All nonempty status groups are visible immediately');
  check(await summary.locator('.summary-reviewers button').count() === 0, 'Reviewer summaries have no overflow count or disclosure button');
  check(await card.locator('.reviewer-avatar svg').count() === 0, 'Status icons never obscure individual avatars');
  check(await summary.locator('.pr-summary > .avatar').getAttribute('aria-label') === 'alex', 'Author avatar remains unchanged');
  await people.first().focus();
  check(await people.first().locator('.reviewer-tooltip').isVisible(), 'Keyboard focus exposes the reviewer tooltip');
  check(!await card.evaluate(el => el.open), 'Focusing a reviewer does not expand the PR');
  await capture('reviewer-pills.png', { fullPage: false });
  check(await summary.locator('.reviewer-commenters .reviewer-avatar').count() === 2
    && await summary.locator('.reviewer-commenters > svg').count() === 1, 'Commenters share a single pill and status icon');
  check(await people.nth(3).getAttribute('aria-label') === 'Commented: commented', 'Comments are not represented as approval');
  const iconStyle = state => summary.locator(`.reviewer-${state} > svg`).evaluate(el => {
    const style = getComputedStyle(el);
    return { color: style.stroke, size: parseFloat(style.width), path: el.querySelector('path').getAttribute('d'), circle: !!el.querySelector('circle') };
  });
  const requested = await iconStyle('requested'); const commented = await iconStyle('commenters');
  check(requested.color === 'rgb(255, 199, 119)' && commented.color === 'rgb(163, 172, 203)', 'Pending requests are amber; comments remain neutral');
  check(requested.circle && !commented.circle && requested.path !== commented.path, 'Requests use an eye while comments use a speech bubble');
  check(requested.size >= 16 && commented.size >= 16, 'Status icons remain legible outside the avatars');
  await page.waitForFunction(() => !document.querySelector('[data-pr="A"] > summary .reviewer-avatar .avatar img'));
  check(await people.nth(2).locator('.avatar').textContent() === 'A'
    && await summary.locator('.reviewer-approvers > svg').count() === 1, 'Failed avatar falls back to an initial without losing the group status');
  await summary.focus(); await summary.press('Enter');
  check(await card.locator('.groups .reviewer-avatar').count() === 5
    && await card.locator('.groups .reviewer-group').count() === 4, 'Expanded details use the same grouped pills');
  for (const width of [1120, 720, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const reviewer = width > 1100 ? people.first() : card.locator('.groups .reviewer-avatar').first();
    await reviewer.focus();
    const bounds = await reviewer.locator('.reviewer-tooltip').boundingBox();
    check(bounds.x >= 0 && bounds.x + bounds.width <= width, `${width}: focused tooltip stays inside the viewport`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: all reviewers fit without horizontal overflow`);
    await capture(`reviewer-pills-${width}.png`, { fullPage: false });
  }
  scenario = 'reported';
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  const avatarsHorizontal = () => summary.locator('.reviewer-commenters .reviewer-avatar:visible').evaluateAll(avatars =>
    avatars.every(avatar => Math.abs(avatar.getBoundingClientRect().y - avatars[0].getBoundingClientRect().y) < 1));
  for (const width of [1120, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await people.count() === 5 && await summary.locator('.reviewer-commenters .reviewer-avatar:visible').count() === 4, `${width}: all five people appear without a +2 count`);
    check(await avatarsHorizontal(), `${width}: all four commenters stay in a horizontal stack`);
    const first = await summary.locator('.reviewer-decliners').boundingBox();
    const last = await summary.locator('.reviewer-commenters').boundingBox();
    check(last.y >= first.y + first.height, `${width}: the complete commenter pill wraps to the next line`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: all reviewer pills fit the row`);
  }
  await capture('reviewer-all-avatars-wrapping.png', { fullPage: false });
  scenario = 'many';
  await page.setViewportSize({ width: 1120, height: 1000 }); await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  check(await summary.locator('.reviewer-group:visible').count() === 1 && await people.count() === 24, 'Even a large same-state group shows everyone immediately');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'A large pill wraps within the reviewer column');
  scenario = 'empty'; await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  check(await summary.locator('.summary-reviewers').textContent() === 'None'
    && await summary.locator('.reviewer-group').count() === 0, 'No reviewers renders None without empty pills');
  return { checks, status: 'pass' };
}
