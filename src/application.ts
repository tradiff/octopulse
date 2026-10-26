import type { Config } from './config.js';
import type { Clock } from './model.js';
import type { RuntimeDesktop } from './runtime.js';
import type { Fetch } from './http.js';
import { openRuntime } from './runtime.js';
import { listenLocal } from './server.js';

export async function startApplication(config: Config | undefined, directory: string, clock: Clock, desktop: RuntimeDesktop, signal: AbortSignal, port: number, fetch: Fetch = globalThis.fetch,
  environment: NodeJS.ProcessEnv = {}) {
  const runtime = openRuntime(config, directory, clock, desktop, signal, fetch, environment);
  try {
    const local = await listenLocal({
      store: runtime.profile.store, logs: runtime.logs, delivery: runtime.delivery, track: runtime.track,
      settings: runtime.settings, updateSettings: runtime.updateSettings,
      get monitor() { return runtime.monitor; },
      get login() { return runtime.login; },
      get teams() { return runtime.teams; },
    }, port);
    void runtime.initialize().catch(() => {});
    const timer = setInterval(() => {
      try { runtime.tick(); } catch { runtime.logs.write('error', 'Runtime scheduling failed'); }
    }, 1000);
    let stopping: Promise<void> | undefined;
    const stopRuntime = runtime.stop;
    return Object.assign(runtime, { origin: local.origin, stop(): Promise<void> {
      if (!stopping) {
        clearInterval(timer);
        stopping = stopRuntime(local.stop());
      }
      return stopping;
    } });
  } catch (error) { await runtime.stop(); throw error; }
}
