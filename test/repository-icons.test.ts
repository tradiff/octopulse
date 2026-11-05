import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import { repositoryIcon } from '../src/repository-icon.js';
import { AvatarCache, DesktopAdapter } from '../src/desktop.js';
import type { DesktopMessage } from '../src/desktop.js';
import { webFixture } from './web-fixture.js';

test('repository Blobs are deterministic, case-insensitive, non-animated and owner-specific', async () => {
  const svg = repositoryIcon('acme/widget');
  assert.equal(svg, repositoryIcon('ACME/Widget'));
  assert.notEqual(svg, repositoryIcon('other/widget'));
  assert.notEqual(svg, repositoryIcon('acme/service'));
  assert.doesNotMatch(svg, /<(?:script|animate|animateTransform|set)\b|(?:href|src)="https?:\/\//);
  const metadata = await sharp(Buffer.from(svg)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [64, 64]);
});

test('repository icon palette excludes grey, including previously grey screenshot repositories', () => {
  for (const repository of ['moonbase/pigeon-post', 'moonbase/handbook', ...Array.from({ length: 64 }, (_, index) => `acme/project-${index}`)]) {
    assert.doesNotMatch(repositoryIcon(repository), /fill="#1e293b"/);
  }
});

test('local repository SVG endpoint validates names and supports private caching and HEAD', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const path = fixture.local.origin + '/repository-icon.svg';
  const response = await fetch(path + '?repository=ACME%2FWidget');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^image\/svg\+xml/);
  assert.equal(response.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(await response.text(), repositoryIcon('acme/widget'));
  const head = await fetch(path + '?repository=acme%2Fwidget', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const repository of ['', 'widget', '../acme/widget', '<script>/widget', 'https://evil.example/icon', 'acme/' + 'x'.repeat(256)]) {
    assert.equal((await fetch(path + '?' + new URLSearchParams({ repository }))).status, 400);
  }
});

test('desktop notifications put an 18px repository PNG before the repository name and retain the PR-state icon', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  let requests = 0;
  const cache = new AvatarCache(join(fixture.directory, 'avatars'), fixture.clock, async () => { requests++; throw new Error('Offline'); });
  const intent = fixture.store.notifications().find(record => record.data.intent.prId === 'A')!.data.intent;
  const messages: DesktopMessage[] = [];
  const signal = new AbortController().signal;
  const generating = t.mock.method(cache, 'repositoryImage');
  for (const capabilities of [[], ['body-markup'], ['body-markup', 'body-images']]) {
    const adapter = new DesktopAdapter(fixture.store, 'alex', {
      async capabilities() { return capabilities; },
      async notify(message) { messages.push(message); return 1; },
    }, cache);
    assert.equal(await adapter.submit(intent, signal), 'sent');
  }
  assert.ok(messages.every(message => message.icon === 'git-open'), 'The main notification icon always conveys PR state');
  assert.equal(messages[0]!.summary, intent.title);
  assert.equal(messages[0]!.body, intent.body);
  assert.doesNotMatch(messages[1]!.body, /<img\b/);
  assert.match(messages[1]!.body, /<br\/>acme\/widget #7 alex<br\/>/);
  assert.doesNotMatch(messages[1]!.body, /\(open\)/);
  assert.equal(generating.mock.callCount(), 1, 'Only desktops supporting inline images need a repository PNG');
  const match = /<br\/><img src="([^"]+)" alt="" width="18" height="18"\/> acme\/widget/.exec(messages[2]!.body);
  assert.ok(match, 'The repository icon appears directly before its name');
  const image = fileURLToPath(match[1]!);
  assert.match(image, /\/repository-[a-f0-9]{64}\.18\.png$/);
  const expected = await sharp(Buffer.from(repositoryIcon('acme/widget'))).resize(18, 18).png().toBuffer();
  assert.deepEqual(await readFile(image), expected, 'Web SVG and desktop PNG represent the same icon');
  assert.equal((await stat(image)).mode & 0o777, 0o600);
  assert.equal((await stat(join(fixture.directory, 'avatars'))).mode & 0o777, 0o700);
  const before = (await stat(image)).mtimeMs;
  assert.equal(await cache.repositoryImage('ACME/Widget', signal), image);
  assert.equal((await stat(image)).mtimeMs, before);
  assert.equal(requests, 0, 'Repository icons do not require network access');
  const broken = new AvatarCache(join(image, 'not-a-directory'), fixture.clock);
  const adapter = new DesktopAdapter(fixture.store, 'alex', {
    async capabilities() { return ['body-markup', 'body-images']; }, async notify(message) { messages.push(message); return 2; },
  }, broken);
  assert.equal(await adapter.submit(intent, signal), 'sent');
  assert.equal(messages.at(-1)!.icon, 'git-open', 'Image failures retain the existing PR-state icon');
  assert.match(messages.at(-1)!.body, /<br\/>acme\/widget #7 alex/, 'An image failure still delivers the repository label');
  assert.equal(await adapter.submit({ ...intent, kind: 'monitoring' }, signal), 'sent');
  assert.equal(messages.at(-1)!.icon, 'dialog-warning', 'Monitoring warnings never use a repository icon');
  const canceled = new AbortController(); canceled.abort();
  assert.equal(await cache.repositoryImage('acme/service', canceled.signal), null);
});
