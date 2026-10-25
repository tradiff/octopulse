import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replay } from './fixture.js';

const sourceHash = createHash('sha256');
for (const directory of ['src', 'test', 'web', 'scripts', 'assets']) {
  for (const file of (await readdir(directory)).filter(file => /\.(ts|js|mjs|html|css|svg)$/.test(file)).sort()) {
    sourceHash.update(`${directory}/${file}\n`).update(await readFile(join(directory, file)));
  }
}
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) sourceHash.update(file).update(await readFile(file));
const results = [];
for (const file of (await readdir('fixtures')).filter(file => file.endsWith('.json')).sort()) {
  const content = await readFile(join('fixtures', file), 'utf8');
  const result = await replay(JSON.parse(content));
  results.push({ ...result, fixtureSha256: createHash('sha256').update(content).digest('hex') });
  console.log(`${result.status.toUpperCase()} ${result.fixture} (${result.checkpoints} checkpoints)${result.error ? `: ${result.error}` : ''}`);
}
await mkdir('replay-results', { recursive: true });
await writeFile('replay-results/report.json', JSON.stringify({
  implementationVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
  implementationSha256: sourceHash.digest('hex'), runtime: process.version, results,
}, null, 2));
if (results.some(result => result.status === 'fail')) process.exitCode = 1;
