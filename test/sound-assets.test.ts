import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('bundled notification sounds retain the original Octopulse recordings after a build', async () => {
  for (const [name, hash] of [
    ['approved', '8b3f390857df103716dcb11513037aed6d4611d9159b4a93b4445b4530ba3005'],
    ['comment', 'f6f8ea26969dcd5a58f63cc118523569d7c62c4aa66a91cc92f3e3d25afaf7a9'],
  ]) {
    const bytes = await readFile(new URL(`../../assets/${name}.wav`, import.meta.url));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `${name}: original recording must not be regenerated`);
  }
});
