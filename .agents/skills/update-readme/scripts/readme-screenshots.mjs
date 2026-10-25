// Run from the repository root. Builds the app; requires playwright-cli and its Chromium browser.
// Only a disposable profile and synthetic inputs are used; no GitHub access.
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const { Profile } = await import('../../../../dist/src/profile.js');
const { Snapshot, Event } = await import('../../../../dist/src/model.js');
const { Monitor } = await import('../../../../dist/src/monitor.js');
const { Delivery } = await import('../../../../dist/src/delivery.js');
const { Diagnostics } = await import('../../../../dist/src/diagnostics.js');
const { listenLocal } = await import('../../../../dist/src/server.js');
const { VirtualClock, RecordingDesktop, completeSources, temporaryProfile } = await import('../../../../dist/test/fixture.js');

const output = 'assets/screenshots/collage.png';
const previous = await readFile(output).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
const directory = await temporaryProfile();
const capture = join(directory, 'collage.png');
const profile = new Profile(directory);
const clock = new VirtualClock('3001-01-15T17:42:23.000Z');
const capturedAt = Date.parse(clock.now());
const monitor = new Monitor(profile.store, clock, 'byte-bot', ['moonbase/engineering'], clock.now());
const delivery = new Delivery(profile.store, clock, new RecordingDesktop());
const logs = new Diagnostics(join(directory, 'logs'), clock, 'debug', 86400000, [], () => {});
const cli = (...args) => promisify(execFile)('playwright-cli', ['-s=readme-artwork', ...args], { maxBuffer: 8 * 1024 * 1024 });
const avatarUrl = login => `https://avatars.example.test/${login}.svg`;
const avatars = Object.fromEntries([
  ['byte-bot', '<rect width="64" height="64" fill="#6656a8"/><path d="M32 13V6" stroke="#ffc777" stroke-width="4"/><circle cx="32" cy="6" r="4" fill="#ffc777"/><rect x="10" y="17" width="44" height="36" rx="12" fill="#d9d3fa"/><rect x="15" y="24" width="34" height="16" rx="7" fill="#282c45"/><circle cx="24" cy="32" r="4" fill="#86e1fc"/><circle cx="40" cy="32" r="4" fill="#86e1fc"/><path d="M25 46h14" stroke="#6656a8" stroke-width="3" stroke-linecap="round"/>'],
  ['cache-goblin', '<rect width="64" height="64" fill="#244b4a"/><ellipse cx="32" cy="38" rx="25" ry="20" fill="#b5dc76"/><circle cx="18" cy="22" r="11" fill="#b5dc76"/><circle cx="46" cy="22" r="11" fill="#b5dc76"/><circle cx="18" cy="22" r="7" fill="#f2f7dd"/><circle cx="46" cy="22" r="7" fill="#f2f7dd"/><circle cx="20" cy="23" r="4" fill="#243b34"/><circle cx="44" cy="23" r="4" fill="#243b34"/><path d="M22 41q10 10 20 0" fill="none" stroke="#47663b" stroke-width="3" stroke-linecap="round"/>'],
  ['merge-owl', '<rect width="64" height="64" fill="#694331"/><path d="M10 13l15 7h14l15-7v27q0 18-22 18T10 40Z" fill="#ffc777"/><circle cx="23" cy="32" r="12" fill="#fff0cf"/><circle cx="41" cy="32" r="12" fill="#fff0cf"/><circle cx="24" cy="32" r="6" fill="#49342e"/><circle cx="40" cy="32" r="6" fill="#49342e"/><circle cx="26" cy="30" r="2" fill="#fff"/><circle cx="42" cy="30" r="2" fill="#fff"/><path d="M27 40h10l-5 8Z" fill="#d57645"/>'],
].map(([login, shapes]) => [avatarUrl(login), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${shapes}</svg>`]));
avatars['https://github.com/byte-bot.png?size=64'] = avatars[avatarUrl('byte-bot')];
let local;
try {
  const titles = [
    ['moonbase/coffee-ops', 42, 'Stop retrying the coffee machine at 3 a.m.', 'clean', false],
    ['moonbase/pigeon-post', 128, 'Teach carrier pigeons exponential backoff', 'clean', false],
    ['moonbase/duck-debugger', 39, 'Fix rubber duck entering an infinite monologue', 'blocked', false],
    ['moonbase/handbook', 16, 'Document which blinking lights are probably fine', 'clean', false],
    ['moonbase/airlock', 131, 'Add a very polite "are you sure?" to the airlock', 'unknown', true],
  ];
  for (const [index, [repository, number, title, mergeStatus, draft]] of titles.entries()) {
    clock.set(new Date(capturedAt - index * 60000).toISOString());
    const snapshot = Snapshot.parse({ id: `demo-${index}`, repository, number, title, mergeStatus, draft,
      author: 'byte-bot', authorAvatar: avatarUrl('byte-bot'), head: `demo-head-${index}`, updatedAt: clock.now(),
      requestedReviewers: index === 2 ? ['cache-goblin'] : [],
      requestedActors: index === 2 ? [{ login: 'cache-goblin', avatar: avatarUrl('cache-goblin') }] : [] });
    monitor.track(snapshot, 'manual');
    await monitor.observe({ snapshot, sources: completeSources, events: [] });
    const state = index === 1 ? 'in_progress' : 'completed';
    const conclusion = state === 'in_progress' ? null : index === 2 ? 'failure' : 'success';
    await monitor.observe({ snapshot, sources: completeSources,
      events: index === 0 ? [
        Event.parse({ source: 'issue_comment', id: 'demo-comment', kind: 'comment', actor: { login: 'cache-goblin', avatar: avatarUrl('cache-goblin') }, occurredAt: clock.now(),
          body: '**The espresso has entered a retry loop.**\n\nPlease cap the attempts. The on-call toaster needs sleep.\n\n- [x] Backoff longer than one sip\n- [x] No coffee after the deadline\n- [ ] Test with a decaf response' }),
        Event.parse({ source: 'issue_comment', id: 'demo-reply', kind: 'comment', actor: { login: 'byte-bot', avatar: avatarUrl('byte-bot') }, occurredAt: clock.now(),
          body: 'Added the decaf test. Three attempts, then a graceful tea fallback.' }),
        Event.parse({ source: 'review', id: 'demo-approval', kind: 'approval', actor: { login: 'merge-owl', avatar: avatarUrl('merge-owl') }, occurredAt: clock.now(), body: 'Approved. The build is green and the coffee is finally finite.' }),
      ] : [],
      reviews: [0, 1, 3].includes(index) ? [{ id: `review-${index}`, reviewer: { login: 'merge-owl', bot: false, avatar: avatarUrl('merge-owl') }, state: 'approved', submittedAt: clock.now() }] : [],
      workflows: draft ? [] : [{ id: `run-${index}`, workflowId: 'build', trigger: 'pull_request', runNumber: 24 + index,
        attempt: 1, head: snapshot.head, name: 'Preflight checks', updatedAt: clock.now(), status: state, conclusion, jobsComplete: true,
        jobs: ['Zero-gravity tests', 'Decaf compatibility'].map((name, j) => ({ id: `job-${index}-${j}`, name, runId: `run-${index}`, attempt: 1,
          head: snapshot.head, status: state, conclusion: j === 1 && conclusion === 'failure' ? 'success' : conclusion })) }],
    });
  }
  clock.set(new Date(capturedAt).toISOString());
  monitor.reconcile();
  await delivery.runDue();
  local = await listenLocal({ store: profile.store, monitor, delivery, logs, login: 'byte-bot', teams: ['moonbase/engineering'],
    async track() { throw new Error('Screenshot preview is read-only'); } }, 0);
  await mkdir('assets/screenshots', { recursive: true });
  await cli('open');
  const result = await cli('run-code', `async page => {
    const origin = ${JSON.stringify(local.origin)};
    const errors = [];
    page.context().on('page', opened => opened.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    page.context().on('requestfailed', request => {
      if (request.url().startsWith(origin + '/')) errors.push(request.url() + ': ' + request.failure()?.errorText);
    });
    page.context().on('response', response => {
      if (response.url().startsWith(origin + '/') && response.status() >= 400) errors.push(response.url() + ': HTTP ' + response.status());
    });
    await page.clock.setFixedTime(new Date(${capturedAt}));
    const avatars = ${JSON.stringify(avatars)};
    await page.context().route('**/*', route => {
      const avatar = avatars[route.request().url()];
      if (avatar) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: avatar });
      return route.request().url().startsWith(origin + '/') ? route.continue() : route.abort();
    });
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.goto(origin);
    await page.locator('.pr').nth(4).waitFor();
    const readyAvatars = () => page.locator('.avatar img').evaluateAll(images => Promise.all(images.map(image => {
      image.loading = 'eager';
      return image.decode();
    })));
    await readyAvatars();
    const image = async () => 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    const queue = await image();
    const featured = page.locator('.pr').filter({ hasText: 'Stop retrying the coffee machine at 3 a.m.' });
    await featured.locator('summary').click();
    await page.locator('.comment-body').first().waitFor();
    await readyAvatars();
    let detail = 'data:image/png;base64,' + (await featured.screenshot()).toString('base64');
    const artwork = await page.context().newPage();
    // Trim the expanded row's blue selection rail from the source capture.
    detail = await artwork.evaluate(async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth - 4;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to crop the detail screenshot');
      context.drawImage(image, 4, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    }, detail);
    await artwork.setViewportSize({ width: 1800, height: 1900 });
    const css = \`
      * { box-sizing: border-box; } body { margin: 0; }
      .art { width: 1800px; height: 1900px; position: relative; overflow: hidden; }
      .panel { position: absolute; width: 1140px; height: 690px; padding: 10px; background: linear-gradient(135deg, #111720, #0b1018 38%, #020408 76%); border-radius: 19px; box-shadow: inset 1px 1px 0 #edf4ff26, inset -1px -1px 0 #8593a33d, 2px 3px 1px #03060ae6, 4px 7px 3px #070b13bf, 0 22px 28px #00000066; transform: rotate(-16deg); }
      .panel::before { content: ''; position: absolute; inset: 4px; border-radius: 15px; box-shadow: inset 1px 1px 0 #e8f1ff33, inset -1px -1px 0 #8f9aa62e, 1px 1px 0 #000000cc; pointer-events: none; }
      .panel::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(90deg, transparent, #fffffff2 8%, #ffffffa6 30%, #ffffff26 58%, transparent 82%) 18px 1px / calc(100% - 36px) 2px no-repeat, linear-gradient(180deg, transparent, #ffffffe6 9%, #ffffff59 35%, transparent 68%, #ffffffb3 84%, transparent 96%) 1px 18px / 2px calc(100% - 36px) no-repeat, linear-gradient(90deg, transparent 12%, #ffffff99 30%, #ffffff26 54%, transparent 75%) 25px 6px / calc(100% - 50px) 1px no-repeat, linear-gradient(118deg, #dfeaff0a, transparent 29%, transparent 72%, #a8c7ff04); pointer-events: none; }
      .panel img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 10px; background: #080b12; box-shadow: 0 0 0 1px #000000e6, 1px 1px 0 #c4d4e633; }
      .secondary { filter: brightness(.45); }
    \`;
    const angle = 16 * Math.PI / 180;
    const gap = 32;
    const across = { x: (1140 + gap) * Math.cos(angle), y: -(1140 + gap) * Math.sin(angle) };
    const upper = { x: 470, y: 180 };
    const lower = { x: 450, y: upper.y + (690 + gap - (450 - upper.x) * Math.sin(angle)) / Math.cos(angle) };
    const rowStep = { x: lower.x - upper.x, y: lower.y - upper.y };
    const rows = [
      { x: upper.x - rowStep.x, y: upper.y - rowStep.y, image: detail },
      { ...upper, image: queue },
      { ...lower, image: detail },
      { x: lower.x + rowStep.x, y: lower.y + rowStep.y, image: detail },
    ];
    const panels = rows.flatMap((row, index) => [-1, 0, 1].map(column => [
      column === 0 ? row.image : (row.image === queue ? detail : queue),
      row.x + column * across.x,
      row.y + column * across.y,
      column !== 0 || index === 0 || index === rows.length - 1,
    ]));
    await artwork.setContent('<!doctype html><html lang="en"><meta charset="utf-8"><style>' + css + '</style><main class="art">' + panels.map(([src, x, y, secondary]) => '<div class="panel' + (secondary ? ' secondary' : '') + '" style="left:' + x + 'px;top:' + y + 'px"><img alt="Fictional Octopulse interface" src="' + src + '"></div>').join('') + '</main></html>');
    await artwork.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await artwork.screenshot({ path: ${JSON.stringify(capture)}, omitBackground: true, clip: { x: 350, y: 20, width: 1360, height: 1780 } });
    if (errors.length) throw new Error('Browser capture failed: ' + errors.join('; '));
    await artwork.close();
    return 'Created screenshot collage.';
  }`);
  if (!result.stdout.includes('Created screenshot collage')) throw new Error(result.stdout);
  const generated = await readFile(capture);
  let identical = false;
  if (previous) {
    const decode = image => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const [before, after] = await Promise.all([decode(previous), decode(generated)]);
    identical = before.info.width === after.info.width && before.info.height === after.info.height && before.data.equals(after.data);
  }
  if (!identical) await writeFile(output, generated);
  console.log(`${output}: ${identical ? 'identical' : previous ? 'changed' : 'created'} (fictional data; browser checks passed).`);
} finally {
  await cli('close').catch(() => {});
  await local?.stop();
  await monitor.stop();
  await delivery.stop();
  profile.close();
  await rm(directory, { recursive: true, force: true });
}
