import { spawn, execFile } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { webFixture } from './web-fixture.js';
import { LinuxDesktop } from '../src/linux-desktop.js';
import { SessionBus } from '../src/session-bus.js';
import { startTray } from '../src/tray.js';
import { Intent, Event } from '../src/model.js';
import { completeSources } from './fixture.js';

if (process.env.OCTOPULSE_SMOKE !== '1' || !process.env.WAYLAND_DISPLAY?.includes('octopulse-smoke')) throw new Error('This test requires the isolated Plasma harness');
const root = process.argv[2]!;
const log = await open(join(root, 'plasmashell.log'), 'w');
const services = spawn('kded6', [], { stdio: ['ignore', log.fd, log.fd] });
const shell = spawn('plasmashell', ['--no-respawn'], { stdio: ['ignore', log.fd, log.fd] });
const fixture = await webFixture();
const desktop = new LinuxDesktop(fixture.store, 'alex', fixture.directory, fixture.clock, { address: process.env.DBUS_SESSION_BUS_ADDRESS! }, console.log);
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.on('SIGTERM', stop); process.on('SIGINT', stop);
let tray: Awaited<ReturnType<typeof startTray>> | undefined;
let connection: SessionBus | undefined;
try {
  connection = await SessionBus.connect(process.env.DBUS_SESSION_BUS_ADDRESS!, shutdown.signal);
  let ready = false;
  for (let attempt = 0; attempt < 60 && !shutdown.signal.aborted; attempt++) {
    try {
      for (const name of ['org.kde.StatusNotifierWatcher', 'org.freedesktop.Notifications']) await connection.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', body: [name] }, shutdown.signal);
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('Nested Plasma notification/tray services did not start');
  tray = await startTray(fixture.local.origin, stop, console.log);
  const avatar = 'https://synthetic.invalid/octopulse-avatar.png';
  await mkdir(join(fixture.directory, 'avatars'), { recursive: true, mode: 0o700 });
  const pngChunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result;
  };
  const size = 512;
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.set([32, 150, 170, 255], y * (size * 4 + 1) + 1 + x * 4);
  await writeFile(join(fixture.directory, 'avatars', `${createHash('sha256').update(avatar).digest('hex')}.image`),
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]));
  await fixture.monitor.observe({ snapshot: { ...fixture.store.pr('A')!.snapshot, authorAvatar: avatar }, sources: completeSources,
    events: [Event.parse({ source: 'review', id: 'smoke-approval', kind: 'approval', actor: { login: 'bea', avatar }, occurredAt: fixture.clock.now(), body: 'Synthetic desktop approval' })] });
  const base = Intent.parse({ prId: 'A', kind: 'immediate', events: ['review:smoke-approval'], title: 'Octopulse isolated smoke — approval',
    body: 'bea: ✅ approval: Synthetic approval. This notification is sticky. Click to record the PR destination.',
    destination: 'https://github.com/acme/widget/pull/7', expiryMs: 0, sound: 'approval' });
  const sticky = await desktop.submit(base, shutdown.signal);
  await new Promise(resolve => setTimeout(resolve, 800));
  const ordinary = await desktop.submit({ ...base, title: 'Octopulse isolated smoke — comment', body: 'Synthetic comment sound. Ordinary timeout requested: 10 seconds.',
    events: ['synthetic:missing'], sound: 'comment', expiryMs: 10000 }, shutdown.signal);
  const capabilities = await connection.call({ destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications',
    interface: 'org.freedesktop.Notifications', member: 'GetCapabilities' }, shutdown.signal);
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ origin: fixture.local.origin, sticky, ordinary, capabilities: capabilities.body,
    instructions: 'Use the Octopulse tray: Open Octopulse, Open Logs, Quit. Local pages open in a disposable Chromium profile. Synthetic GitHub destinations are recorded only.' }, null, 2));
  console.log(`Nested Plasma ready: ${fixture.local.origin}. Local tray actions open disposable Chromium windows. URL targets are recorded in ${root}/opened-urls.jsonl. Quit ends this session.`);
  await new Promise(resolve => setTimeout(resolve, 2000));
  try { await promisify(execFile)('spectacle', ['--background', '--nonotify', '--output', join(root, 'plasma.png')], { timeout: 15_000 }); }
  catch { console.log('Nested screenshot unavailable; inspect the nested window directly.'); }
  await new Promise(resolve => setTimeout(resolve, 12_000));
  try { await promisify(execFile)('spectacle', ['--background', '--nonotify', '--output', join(root, 'plasma-after-timeout.png')], { timeout: 15_000 }); }
  catch { console.log('Post-timeout screenshot unavailable.'); }
  if (!shutdown.signal.aborted) await new Promise<void>(resolve => shutdown.signal.addEventListener('abort', () => resolve(), { once: true }));
} finally {
  tray?.stop(); connection?.close(); await desktop.stop(); await fixture.close();
  shell.kill('SIGTERM'); services.kill('SIGTERM'); await log.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop);
}
