export async function notificationHistory(page, capture) {
  const origin = await page.evaluate(() => location.origin);
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const go = async () => {
    await page.goto(origin + '/notification-history');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
  };
  for (const width of [1920, 1440, 820, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    let expected;
    for (const path of ['/', '/logs', '/notification-history']) {
      await page.goto(origin + path);
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('refreshed'));
      const frame = await page.locator('main').evaluate(el => {
        const { x, width } = el.getBoundingClientRect();
        return { x, width, padding: getComputedStyle(el).paddingInline };
      });
      if (!expected) expected = frame;
      else check(JSON.stringify(frame) === JSON.stringify(expected), `${width}: ${path} shares the PR page width and gutters`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await go();
  const first = page.locator('.notification').first();
  check(await first.evaluate(el => el.tagName === 'ARTICLE'), 'History entries are accessible articles, not dropdowns');
  check(await page.locator('.notification summary, .notification details').count() === 0, 'No history content requires expansion');
  check(await first.getByRole('heading', { name: 'Approved', exact: true }).isVisible(), 'History shares the native activity heading');
  check(await first.locator('.notification-body').evaluate(el => { const copy = el.cloneNode(true); copy.querySelectorAll('.avatar').forEach(avatar => avatar.remove()); return copy.textContent.trim() === 'cam: Approved'; }), 'Native actor-led activity is rendered without duplicate action labels');
  check(await first.locator('.notification-body strong').textContent() === 'cam', 'Actor names lead activity lines');
  check(await first.evaluate(el => {
    const weight = selector => Number(getComputedStyle(el.querySelector(selector)).fontWeight);
    const body = weight('.notification-body'), actor = weight('.notification-body strong'), heading = weight('.notification-header');
    return body === 400 && weight('.row-title') === body
      && actor > body && actor < heading && heading <= 600 && weight('.notification-delivery button') <= actor;
  }), 'Only event headings carry semibold emphasis; actors are medium and supporting text is regular');
  check(await first.locator('.repository-icon').getAttribute('src') === '/repository-icon.svg?repository=acme%2Fwidget&v=2', 'Repository identity matches the PR queue');
  check(await first.locator('.pr-author .avatar').getAttribute('aria-label') === 'alex', 'Author retains an avatar fallback');
  check(await first.locator('.delivery-status').count() === 0 && await page.locator('.delivery-note').count() === 0, 'Successful deliveries omit routine status and explanatory clutter');
  const createdAt = await page.evaluate(async () => (await (await fetch('/api/notification-history')).json()).items[0].createdAt);
  const createdTime = first.locator('.notification-meta time');
  check(await first.locator('.notification-delivery time').count() === 1
    && (await createdTime.textContent()).includes('ago')
    && await createdTime.getAttribute('datetime') === new Date(createdAt).toISOString()
    && (await first.locator(`#${await createdTime.getAttribute('aria-describedby')}`).textContent()).includes(':'), 'A single relative timestamp comes from creation, with an accessible full date and time');
  check(await first.getByRole('button', { name: 'Resend', exact: true }).isVisible(), 'Resend is available without expansion');
  check(await first.locator('.row-title').evaluate(link => link.target === '_blank' && link.relList.contains('noreferrer')), 'PR link opens safely in a new tab');
  const arranged = () => first.evaluate(el => {
    const rect = selector => el.querySelector(selector).getBoundingClientRect();
    const heading = rect('.notification-header'), title = rect('.row-title'), context = rect('.row-context'), body = rect('.notification-body'), icon = rect('.pr-state-icon'), delivery = rect('.notification-delivery > :first-child');
    return heading.bottom <= title.top && title.bottom <= context.top && context.bottom < body.top && icon.left > title.right
      && (innerWidth > 700 ? delivery.left > body.right && Math.abs(delivery.top - heading.top) < 2 : delivery.top > body.bottom);
  });
  check(await arranged(), 'Native heading, PR context, body and trailing state icon precede the metadata column');
  check(Math.abs((await first.boundingBox()).x - (await page.locator('#page-title').boundingBox()).x) < 2, 'History content and its controls share a horizontal axis');
  await capture('history-desktop.png', { fullPage: false });
  const varied = async route => {
    const response = await route.fetch(); const data = await response.json();
    data.items = data.items.slice(0, 4).map((record, index) => ({ ...record,
      status: ['sent', 'failed', 'pending', 'sent'][index], reason: index === 1 ? 'exhausted' : null,
      deliveredAt: index === 1 || index === 2 ? null : new Date(Date.parse(record.createdAt) + 10000).toISOString(),
      timing: { eventAt: new Date(Date.parse(record.createdAt) - (index === 2 ? 130000 : 42000)).toISOString(),
        observedAt: new Date(Date.parse(record.createdAt) - (index === 2 ? 70000 : 7000)).toISOString(), deliveredAt: record.createdAt,
        lagMs: index === 3 ? null : index === 2 ? 130000 : 42000, detectionMs: index === 2 ? 60000 : 35000, deliveryMs: index === 2 ? 70000 : 7000,
        ciExcluded: false, unavailableReason: index === 3 ? 'Source event timestamps are unavailable.' : null },
      presentation: index === 0 ? { summary: 'New comment', updates: [{ actor: { login: 'long-reviewer-username', avatar: 'https://invalid.example/avatar.png' }, separator: ': ', action: '', text: '<img src=x onerror=alert(1)> A literal, safe excerpt.',
        bodyHtml: '<p>&lt;img src=x onerror=alert(1)&gt; <strong>Keep cancellation</strong> and <code>retry()</code>.</p><ul><li>First item</li></ul><p><a href="https://example.com/guide" rel="noreferrer noopener">Guide</a></p><pre><code>const retry = true;</code></pre>' }] }
        : index === 1 ? { summary: 'CI failed', updates: [{ actor: null, separator: ': ', text: 'Linux tests exceeded the retry deadline.' }] }
        : index === 2 ? { summary: '16 updates', updates: Array.from({ length: 16 }, (_, i) => ({ actor: { login: 'bea' }, separator: ': ', text: `Update ${i + 1}: Keep the cancellation signal intact.` })) } : null,
      intent: { ...record.intent, expiryMs: index % 2 === 0 ? 0 : 10000, body: 'cam: ✅ approval: Keep the approval checklist unchanged.' },
      pr: { ...record.pr, state: ['draft', 'merged', 'closed', 'open'][index], tracked: index !== 2,
        snapshot: { ...record.pr.snapshot, title: index === 0 ? 'Preserve cancellation across nested workflow retries and concurrent shutdown ' + 'LongTitle'.repeat(12) : `Current PR title ${index + 1}` } },
    }));
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/notification-history*', varied);
  try {
    await go();
    check(await page.locator('.notification-body img[src="x"]').count() === 0 && (await first.locator('.notification-body').textContent()).includes('<img src=x onerror=alert(1)>'), 'Comment markup remains inert text');
    check(await first.locator('.comment-body strong').textContent() === 'Keep cancellation'
      && await first.locator('.comment-body li').textContent() === 'First item'
      && await first.locator('.comment-body pre code').textContent() === 'const retry = true;'
      && await first.locator('.comment-body a').getAttribute('href') === 'https://example.com/guide', 'History uses the PR comment surface for formatted Markdown, links, lists, and code');
    check(await first.locator('.row-title img').count() === 0, 'Long PR titles are inert text');
    check(await page.locator('.notification .pr-state-icon').evaluateAll(icons => icons.map(icon => icon.alt).join(',') === 'Draft,Merged,Closed,Open'), 'All current PR lifecycle icons are preserved');
    check(await page.locator('.delivery-failed').textContent() === 'Failed' && await page.locator('.delivery-pending').textContent() === 'Pending', 'Failures and pending delivery have visible text labels');
    check(await page.getByText('Delivery retries exhausted.', { exact: true }).isVisible(), 'Failure reasons are explained inline');
    check(await page.locator('.notification').nth(1).locator('.notification-body .avatar').count() === 0, 'CI messages do not invent an actor');
    check(await page.locator('.notification').nth(2).locator('.notification-body p').count() === 16, 'Long bundles preserve every update');
    check(await page.locator('.notification').nth(2).evaluate(el => {
      const facts = el.querySelector('.notification-meta').getBoundingClientRect();
      const action = el.querySelector('.notification-open').getBoundingClientRect();
      return action.top - facts.bottom <= 20;
    }), 'Long bundles keep delivery actions directly after their metadata');
    const bundle = page.locator('.notification').nth(2).getByRole('region');
    check(await bundle.evaluate(el => el.tabIndex === 0 && el.scrollHeight > el.clientHeight), 'Long bundle content has a bounded keyboard-accessible scroll region');
    await bundle.focus(); await bundle.press('End');
    await page.waitForFunction(() => document.querySelector('.notification-scroll').scrollTop > 0);
    check(await bundle.evaluate(el => el.scrollTop > 0), 'Keyboard users can scroll to the rest of a bundle');
    check(await first.getByText('Accepted', { exact: true }).count() === 0 && await first.locator('.delivery-status').count() === 0, 'Even delayed successful deliveries omit acceptance labels and timestamps');
    check(await first.locator('.notification-delivery time').count() === 1 && await first.locator('.delivery-header').count() === 0, 'Creation time is not duplicated above the metadata');
    await page.mouse.move(0, 0);
    await first.locator('.notification-meta time').focus();
    check(await first.getByRole('tooltip').filter({ hasText: /^Created / }).isVisible(), 'Exact creation time is available through keyboard focus');
    await first.locator('.notification-meta time').press('Escape');
    check(await first.getByRole('tooltip').count() === 0, 'Escape dismisses metadata tooltips');
    await first.getByText('Sticky', { exact: true }).focus();
    check(await first.getByRole('tooltip').textContent() === 'Stays until dismissed.', 'Sticky explanation is keyboard accessible');
    const ephemeral = page.locator('.notification').nth(1).getByText('Ephemeral', { exact: true });
    await ephemeral.focus();
    check(await page.locator('.notification').nth(1).getByRole('tooltip').textContent() === 'Automatically dismisses after 10 seconds.', 'Ephemeral explanation is keyboard accessible');
    await first.locator('.notification-lag').focus();
    check(await first.locator('.notification-lag').textContent() === '(Lag 42s)'
      && (await first.getByRole('tooltip').textContent()).includes('Detection: 35s')
      && (await first.getByRole('tooltip').textContent()).includes('Processing / delivery: 7s'), 'Lag exposes the detection and delivery breakdown through keyboard focus');
    check((await page.locator('.notification').nth(2).locator('.notification-lag').textContent()) === '(Lag 2m 10s)', 'Bundle lag formats the earliest event delay');
    await page.locator('.notification').nth(3).locator('.notification-lag').focus();
    check(await page.locator('.notification').nth(3).locator('.notification-lag').textContent() === '(Lag —)'
      && (await page.locator('.notification').nth(3).getByRole('tooltip').textContent()).includes('timestamps are unavailable'), 'Unavailable lag has an explanation rather than an invented zero');
    await first.getByRole('link', { name: 'Open PR ↗', exact: true }).focus();
    const primary = await first.getByRole('link', { name: 'Open PR ↗', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor);
    const quietResend = await first.getByRole('button', { name: 'Resend', exact: true }).evaluate(el => getComputedStyle(el).borderTopColor);
    const failedResend = await page.locator('.notification').nth(1).getByRole('button', { name: 'Resend', exact: true }).evaluate(el => getComputedStyle(el).borderTopColor);
    check(primary !== 'rgba(0, 0, 0, 0)' && quietResend === 'rgba(0, 0, 0, 0)' && failedResend !== quietResend, 'Open PR is the normal primary action; only failed notifications emphasize Resend');
    check(await page.locator('.notification-behavior').evaluateAll(items => Math.max(...items.map(el => el.getBoundingClientRect().left)) - Math.min(...items.map(el => el.getBoundingClientRect().left)) < 1), 'Behavior badges align despite different timestamp lengths');
    check(await page.locator('.notification-behavior').evaluateAll(items => {
      const accent = getComputedStyle(document.querySelector('.notification-open')).borderTopColor;
      return items.every(el => getComputedStyle(el).color !== accent)
        && getComputedStyle(items[0]).color !== getComputedStyle(items[1]).color;
    }), 'Behavior badges use distinct review-style colors rather than primary-action blue');
    check(await first.locator('.notification-delivery').getByText(/^(Created|Behavior|Timeout)$/).count() === 0, 'Metadata has no redundant creation or behavior labels');
    check(await first.locator('.notification-delivery').evaluate(el => {
      const rect = selector => el.querySelector(selector).getBoundingClientRect();
      const badge = rect('.notification-behavior'), time = rect('time'), lag = rect('.notification-lag');
      const open = rect('.notification-open'), resend = rect('button');
      return badge.bottom <= time.top && Math.abs(time.top - lag.top) < 2 && time.right < lag.left
        && Math.max(time.bottom, lag.bottom) <= open.top && open.bottom <= resend.top
        && Math.abs(badge.left - open.left) < 2 && Math.abs(open.left - resend.left) < 2;
    }), 'Rail stacks badge, age with parenthesized lag, Open PR, and Resend on aligned lines');
    check(await page.locator('.notification').nth(2).locator('.tracking-status').textContent() === 'Inactive', 'Inactive tracking remains visible');
    check(await page.locator('.notification').nth(3).locator('.notification-body').textContent() === 'cam: ✅ approved: Keep the approval checklist unchanged.', 'Missing source events fall back to the saved body without rewriting review prose');
    for (const width of [1920, 1440, 1100, 820, 720, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: long content fits without horizontal scrolling`);
      check(await arranged(), `${width}: content order and metadata alignment are preserved`);
      check(await first.getByText('Sticky', { exact: true }).isVisible()
        && await page.locator('.notification').nth(1).getByText('Ephemeral', { exact: true }).isVisible(), `${width}: both notification behaviors stay visible, including on mobile`);
      check(await first.evaluate(el => {
        const row = el.getBoundingClientRect(), content = el.parentElement.getBoundingClientRect();
        const preview = el.querySelector('.notification-preview'), delivery = el.querySelector('.notification-delivery');
        const metadata = delivery.getBoundingClientRect();
        const rowStyle = getComputedStyle(el), previewStyle = getComputedStyle(preview), deliveryStyle = getComputedStyle(delivery);
        return Math.abs(row.width - content.width) < 2 && metadata.right < row.right && metadata.bottom < row.bottom
          && rowStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && rowStyle.borderTopWidth === '1px'
          && previewStyle.borderTopWidth === '0px'
          && (innerWidth > 700 ? deliveryStyle.borderLeftWidth === '1px' : deliveryStyle.borderTopWidth === '1px');
      }), `${width}: a single full-width surface groups the notification and separated delivery metadata`);
      await capture(`history-${width}.png`, { fullPage: false });
    }
    const resend = first.getByRole('button', { name: 'Resend', exact: true });
    await resend.focus();
    check(await resend.evaluate(el => getComputedStyle(el).outlineStyle === 'solid'), 'Keyboard focus on the always-visible action is clear');
    check((await resend.boundingBox()).height >= 44, 'Mobile resend has a touch-sized target');
  } finally { await page.unroute('**/api/notification-history*', varied); }
  return { checks, status: 'pass' };
}
