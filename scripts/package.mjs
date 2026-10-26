import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify, parseArgs } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
const output = resolve(values.output ?? join(root, 'release'));
const nodeVersion = '24.22.1';
const archiveName = `node-v${nodeVersion}-linux-x64.tar.xz`;
const nodeSha256 = '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6';
if (process.platform !== 'linux' || process.arch !== 'x64' || !process.report.getReport().header.glibcVersionRuntime) {
  throw new Error('This package target requires Linux x64 with glibc');
}
await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'opencode/octopulse-package-'));
try {
  console.log(`Fetching pinned Node ${nodeVersion} for linux-x64-glibc`);
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('Node runtime download failed');
  const downloadHash = createHash('sha256');
  const archive = join(work, archiveName);
  await pipeline(response.body, async function* (chunks) {
    for await (const chunk of chunks) {
      downloadHash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(archive));
  if (downloadHash.digest('hex') !== nodeSha256) throw new Error('Node archive checksum mismatch');
  await execute('tar', ['-xJf', archive, '-C', work]);
  const runtime = join(work, `node-v${nodeVersion}-linux-x64`);
  const bundle = join(work, 'octopulse');
  await mkdir(bundle);
  for (const directory of ['dist/src', 'web', 'assets']) {
    await cp(join(root, directory), join(bundle, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json', 'README.md']) {
    await cp(join(root, file), join(bundle, file));
  }
  await mkdir(join(bundle, 'scripts'));
  await cp(join(root, 'scripts/install.mjs'), join(bundle, 'scripts/install.mjs'));
  await mkdir(join(bundle, 'runtime/bin'), { recursive: true });
  await cp(join(runtime, 'bin/node'), join(bundle, 'runtime/bin/node'));
  await cp(join(runtime, 'LICENSE'), join(bundle, 'runtime/LICENSE'));
  console.log('Installing locked production dependencies without lifecycle scripts or compiler');
  await execute(join(runtime, 'bin/node'), [
    join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'),
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  ], {
    cwd: bundle,
    env: { ...process.env, PATH: `${join(runtime, 'bin')}:${process.env.PATH}` },
    maxBuffer: 4 * 1024 * 1024,
  });
  const smoke = await execute(join(bundle, 'runtime/bin/node'), ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    import { SessionBus } from './dist/src/session-bus.js';

    const db = new Database(':memory:');
    if (db.prepare('select 42 value').get().value !== 42 || !SessionBus) process.exit(1);
    db.close();
    console.log(process.version);
  `], { cwd: bundle, env: { PATH: '/nonexistent', HOME: work } });
  if (smoke.stdout.trim() !== `v${nodeVersion}`) throw new Error('Bundled runtime validation failed');
  const hash = createHash('sha256');
  async function digest(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await digest(path, name);
      else if (entry.isFile()) {
        hash.update(name).update('\0');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
      }
    }
  }
  await digest(bundle);
  const manifest = {
    schema: 1,
    target: 'linux-x64-glibc',
    nodeVersion,
    nodeSha256,
    digest: hash.digest('hex'),
    version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  };
  await writeFile(join(bundle, 'octopulse-package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  const destination = join(output, `octopulse-${manifest.version}-${manifest.target}.tar.gz`);
  await execute('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', destination, '-C', work, 'octopulse']);
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(destination)) checksum.update(chunk);
  await writeFile(`${destination}.sha256`, `${checksum.digest('hex')}  ${basename(destination)}\n`);
  console.log(`Package verified: ${destination}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
