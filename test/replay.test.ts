import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { replay } from './fixture.js';

for (const file of (await readdir('fixtures')).filter(file => file.endsWith('.json')).sort()) {
  test(`neutral replay: ${file}`, async () => {
    const result = await replay(JSON.parse(await readFile(join('fixtures', file), 'utf8')));
    assert.equal(result.status, 'pass', JSON.stringify(result, null, 2));
  });
}
