import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startApplication } from './application.js';
import { LinuxDesktop } from './linux-desktop.js';
import { startTray } from './tray.js';
import type { Fetch } from './http.js';

export function daemonOptions(args: string[], home = homedir()) {
  const { values } = parseArgs({ args, options: { profile: { type: 'string' }, development: { type: 'boolean' },
    instance: { type: 'string' }, port: { type: 'string' } }, strict: true });
  const instance = values.instance ?? 'octopulse';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(instance)) throw new Error('Invalid instance name');
  const port = values.port === undefined ? (values.development ? 0 : 3000) : Number(values.port);
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Port must be between 1 and 65535');
  if (values.development && !values.profile) throw new Error('Development requires an explicit --profile');
  const profile = values.profile ?? join(home, '.local/state', instance);
  if (!isAbsolute(profile)) throw new Error('Profile path must be absolute');
  return { profile, port, instance };
}

export async function runDaemon(options: ReturnType<typeof daemonOptions>, shutdown: AbortController, fetch: Fetch = globalThis.fetch,
  environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const clock = { now: () => new Date().toISOString() };
  let desktop: LinuxDesktop | undefined;
  let application: Awaited<ReturnType<typeof startApplication>> | undefined;
  let tray: Awaited<ReturnType<typeof startTray>> | undefined;
  try {
    application = await startApplication(undefined, options.profile, clock, (store, login) => {
      desktop ??= new LinuxDesktop(store, login, options.profile, clock, { address: environment.DBUS_SESSION_BUS_ADDRESS ?? '', instance: options.instance },
        message => application?.logs.write('warn', message));
      return desktop;
    }, shutdown.signal, options.port, fetch, environment);
    const app = application;
    shutdown.signal.throwIfAborted();
    tray = await startTray(app.origin, () => shutdown.abort(), message => app.logs.write('info', message), { environment, instance: options.instance });
    app.logs.write('info', 'Octopulse ready', { origin: app.origin, instance: options.instance });
    if (!shutdown.signal.aborted) await new Promise<void>(resolve => shutdown.signal.addEventListener('abort', () => resolve(), { once: true }));
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    const failures: unknown[] = [];
    for (const stop of [() => tray?.stop(), () => desktop?.stop(), () => application?.stop()]) {
      try { await stop(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Octopulse shutdown failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (process.platform !== 'linux') throw new Error('Octopulse requires Linux');
    await runDaemon(daemonOptions(process.argv.slice(2)), shutdown);
  } catch {
    console.error('Octopulse startup or shutdown failed; check settings and profile diagnostics'); process.exitCode = 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
