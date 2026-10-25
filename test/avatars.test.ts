import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import { AvatarCache } from '../src/desktop.js';
import { temporaryProfile, VirtualClock } from './fixture.js';

test('large downloaded PNG and JPEG avatars are cached at their actual 18px display size', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const format of ['png', 'jpeg'] as const) {
    const source = await sharp({ create: { width: 1024, height: 512, channels: 3, background: '#2096aa' } }).toFormat(format).toBuffer();
    let requests = 0;
    const cache = new AvatarCache(directory, new VirtualClock(new Date().toISOString()), async () => { requests++; return new Response(source); });
    const url = `https://avatars.example/large.${format}`;
    const image = await cache.image(url, new AbortController().signal); assert.ok(image);
    const metadata = await sharp(await readFile(fileURLToPath(image))).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [18, 18, 'png']);
    assert.equal((await stat(fileURLToPath(image))).mode & 0o777, 0o600);
    assert.equal(await cache.image(url, new AbortController().signal), image);
    assert.equal(requests, 1);
  }
});

test('existing full-size avatar caches are resized offline, including stale refresh fallback', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#aa2096' } }).png().toBuffer();
  for (const stale of [false, true]) {
    const url = `https://avatars.example/legacy-${stale}.png`;
    const path = join(directory, `${createHash('sha256').update(url).digest('hex')}.image`);
    await writeFile(path, source);
    if (stale) await utimes(path, new Date('2020-01-01'), new Date('2020-01-01'));
    let requests = 0;
    const cache = new AvatarCache(directory, new VirtualClock(new Date().toISOString()), async () => { requests++; throw new Error('Offline'); });
    const image = await cache.image(url, new AbortController().signal); assert.ok(image);
    const metadata = await sharp(await readFile(fileURLToPath(image))).metadata();
    assert.deepEqual([metadata.width, metadata.height], [18, 18]);
    assert.notEqual(fileURLToPath(image), path, 'Use a new URI so Plasma does not reuse the oversized image');
    assert.equal(requests, stale ? 1 : 0);
    assert.deepEqual(await readFile(path), source, 'Legacy cache is preserved');
  }
});

test('invalid images and excessive decoded dimensions never enter the thumbnail cache', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const huge = await sharp({ create: { width: 8192, height: 4096, channels: 3, background: '#2096aa' } }).png().toBuffer();
  assert.ok(huge.length < 2 * 1024 * 1024);
  for (const [i, bytes] of [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), huge].entries()) {
    const cache = new AvatarCache(directory, new VirtualClock(new Date().toISOString()), async () => new Response(bytes));
    assert.equal(await cache.image(`https://avatars.example/invalid-${i}.png`, new AbortController().signal), null);
  }
});
