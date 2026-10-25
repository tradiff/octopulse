import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const parent = process.env.WAYLAND_DISPLAY;
if (!parent || !process.env.XDG_RUNTIME_DIR) throw new Error('A parent Wayland session is required for the nested smoke test');
const root = await mkdtemp('/tmp/opencode/octopulse-plasma-');
const home = join(root, 'home'); const runtime = join(root, 'runtime');
for (const directory of [home, runtime, join(home, '.config'), join(home, '.local/share/applications'), join(home, '.cache')]) await mkdir(directory, { recursive: true, mode: 0o700 });
const child = fileURLToPath(new URL('../dist/test/plasma-smoke-child.js', import.meta.url));
const handler = join(root, 'url-handler.mjs');
await writeFile(handler, `import {appendFileSync} from 'node:fs'; import {spawn} from 'node:child_process';
const input=process.argv[2]; const url=new URL(input);
appendFileSync(${JSON.stringify(join(root, 'opened-urls.jsonl'))}, JSON.stringify({url:input,at:new Date().toISOString()})+'\\n');
if(url.protocol==='http:' && url.hostname==='127.0.0.1') {
  const browser=spawn('chromium-browser',['--user-data-dir='+${JSON.stringify(join(root, 'browser-profile'))},'--ozone-platform=wayland','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--password-store=basic','--new-window',url.href],{stdio:'ignore'});
  browser.once('error',error=>{appendFileSync(${JSON.stringify(join(root, 'browser-errors.log'))},error.message+'\\n');process.exitCode=1;}); browser.unref();
}\n`);
const desktop = `[Desktop Entry]\nType=Application\nName=Octopulse disposable browser\nExec="${process.execPath}" "${handler}" %u\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\nNoDisplay=true\n`;
await writeFile(join(home, '.local/share/applications/octopulse-smoke-browser.desktop'), desktop);
await writeFile(join(home, '.local/share/applications/octopulse.desktop'), '[Desktop Entry]\nType=Application\nName=Octopulse\nNoDisplay=true\nExec=xdg-open http://127.0.0.1:3000\n');
await writeFile(join(home, '.config/mimeapps.list'), '[Default Applications]\nx-scheme-handler/http=octopulse-smoke-browser.desktop\nx-scheme-handler/https=octopulse-smoke-browser.desktop\n');
const session = join(root, 'session.sh');
await writeFile(session, `#!/bin/sh\nexec "${process.execPath}" "${child}" "${root}"\n`, { mode: 0o700 });
const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'), XDG_RUNTIME_DIR: runtime,
  XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland', QT_QPA_PLATFORM: 'wayland',
  PULSE_SERVER: `unix:${join(process.env.XDG_RUNTIME_DIR, 'pulse/native')}`, PIPEWIRE_REMOTE: join(process.env.XDG_RUNTIME_DIR, 'pipewire-0'),
  DISPLAY: '', WAYLAND_DISPLAY: 'octopulse-smoke', DBUS_SESSION_BUS_ADDRESS: '', KDE_FULL_SESSION: 'true', OCTOPULSE_SMOKE: '1' };
console.log(`Disposable Plasma evidence directory: ${root}`);
const nested = spawn('dbus-run-session', ['--', 'kwin_wayland', '--wayland-display', isAbsolute(parent) ? parent : join(process.env.XDG_RUNTIME_DIR, parent),
  '--socket', 'octopulse-smoke', '--width', '1280', '--height', '800', '--no-lockscreen', '--no-global-shortcuts', '--no-kactivities', '--exit-with-session', session],
  { env: environment, stdio: 'inherit', detached: true });
const stop = () => { try { process.kill(-nested.pid, 'SIGTERM'); } catch {} };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const timer = setTimeout(stop, 15 * 60_000);
nested.once('error', error => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
nested.once('exit', (code, signal) => {
  clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  stop(); process.exitCode = signal === 'SIGTERM' ? 0 : code ?? 1;
  console.log(`Nested session ended. Synthetic evidence retained at ${root}`);
});
