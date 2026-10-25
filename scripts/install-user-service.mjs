import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { userServiceFiles } from './deploy-user-service.mjs';

const execute = promisify(execFile);

export async function installUserService(root, home, { run = execute } = {}) {
  const { unit, launcher, config, files } = userServiceFiles(root, home);
  for (const path of ['dist/src/daemon.js', 'web/index.html', 'assets/octopulse-mark-small-white.svg']) await readFile(join(root, path));
  files.set(config, await readFile(join(root, 'config.example.toml'), 'utf8'));
  const created = [];
  for (const [path, text] of files) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, text, { flag: 'wx', mode: path === launcher ? 0o700 : 0o600 });
      created.push(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (created.includes(unit)) await run('systemctl', ['--user', 'daemon-reload']);
  return { config, created };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: npm run user-service:install');
    const result = await installUserService(fileURLToPath(new URL('../', import.meta.url)), homedir());
    console.log(`Created ${result.created.length} missing files; existing files preserved.`);
    console.log(`Set github.token in ${result.config}, then run: systemctl --user enable --now octopulse.service`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
