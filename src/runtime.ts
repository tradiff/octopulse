import { join } from 'node:path';
import { z } from 'zod';
import { canonical } from './model.js';
import type { Clock, Desktop } from './model.js';
import type { Config } from './config.js';
import { pullRequestUrl } from './config.js';
import { Profile } from './profile.js';
import { Diagnostics } from './diagnostics.js';
import { GitHub, GitHubUnavailable } from './github.js';
import { Collector } from './collector.js';
import { Monitor } from './monitor.js';
import { Delivery } from './delivery.js';
import { Scheduler } from './scheduler.js';
import { SystemOne } from './system-one.js';
import type { Fetch } from './http.js';
import type { Store } from './store.js';
import { Settings } from './settings.js';
import { MonitoringHealth } from './monitoring-health.js';

export type RuntimeDesktop = Desktop | ((store: Store, login: string) => Desktop);

export function openRuntime(initial: Config | undefined, directory: string, clock: Clock, desktop: RuntimeDesktop, signal: AbortSignal, fetch: Fetch = globalThis.fetch,
  environment: NodeJS.ProcessEnv = {}) {
  const profile = new Profile(directory);
  try {
    const store = profile.store;
    const settings = new Settings(store, initial, environment);
    let config = settings.effective();
    const logs = new Diagnostics(join(directory, 'logs'), clock, config.logging.level, config.logging.retention,
      [config.github.token, config.system_one?.api_key ?? '']);
    let alertDesktop: Desktop | undefined;
    const health = new MonitoringHealth(store, clock, () => alertDesktop ??= typeof desktop === 'function'
      ? desktop(store, store.metadata('login') ?? '') : desktop, message => logs.write('warn', message));
    let shutdown = new AbortController();
    let connectionSignal = AbortSignal.any([signal, shutdown.signal]);
    let connected: Awaited<ReturnType<typeof connectRuntime>> | undefined;
    let connecting: Promise<void> | undefined;
    let stopped: Promise<void> | undefined;
    let retryAt = 0;
    let updating = false;
    const savedTeams = () => z.array(z.string()).parse(JSON.parse(store.metadata('teams') ?? '[]'));
    const savedMonitor = () => new Monitor(store, clock, store.metadata('login') ?? '', savedTeams(), store.metadata('reviewBaseline') ?? clock.now(), undefined, config.timings.grace_period);
    let cached = savedMonitor();
    const initialize = (): Promise<void> => {
      if (stopped || connectionSignal.aborted) return Promise.reject(new Error('Runtime is stopped'));
      if (connected) return Promise.resolve();
      if (!config.github.token) { health.update('missing_token'); return health.idle(); }
      if (!connecting) {
        if (health.view().state !== 'authentication_failed') health.update('starting');
        connecting = connectRuntime(config, profile, logs, clock, desktop, connectionSignal, fetch, health).then(runtime => {
          connected = runtime;
        }).catch(error => {
          cached = savedMonitor();
          throw error;
        }).finally(() => {
          connecting = undefined;
          retryAt = Date.parse(clock.now()) + config.timings.discovery_poll_interval;
        });
      }
      return connecting;
    };
    return {
      profile, logs, initialize, settings,
      get monitoring() { return health.view(); },
      setOrigin(origin: string): void { health.destination = new URL('/settings', origin).href; },
      async updateSettings(body: unknown): Promise<void> {
        if (updating || stopped) throw new Error('Settings are busy. Try again.');
        updating = true;
        try {
          settings.update(body);
          shutdown.abort();
          await connecting?.catch(() => {});
          await connected?.stop();
          await cached.stop();
          connected = undefined;
          config = settings.effective();
          logs.configure(config.logging.level, config.logging.retention, [config.github.token, config.system_one?.api_key ?? '']);
          shutdown = new AbortController();
          connectionSignal = AbortSignal.any([signal, shutdown.signal]);
          cached = savedMonitor();
          retryAt = 0;
        } finally { updating = false; }
        void initialize().catch(() => {});
      },
      get login() { return connected?.login ?? store.metadata('login') ?? ''; },
      get teams() { return connected?.teams ?? savedTeams(); },
      get monitor() { return connected?.monitor ?? cached; },
      get scheduler() { if (!connected) throw new Error('Background monitoring is not ready'); return connected.scheduler; },
      delivery: { async resend(id: number): Promise<void> {
        if (!connected) throw new Error('Background monitoring is not ready');
        await connected.delivery.resend(id);
      } },
      async track(url: string, callerSignal: AbortSignal): Promise<void> {
        if (!connected) throw new Error('Background monitoring is not ready');
        await connected.track(url, callerSignal);
      },
      refresh() {
        if (!connected || updating || stopped) throw new Error('Background monitoring is not ready');
        return connected.scheduler.startRefresh();
      },
      get refreshStatus() { return connected?.scheduler.refreshStatus ?? null; },
      tick(): void {
        if (stopped || updating || connectionSignal.aborted) return;
        if (connected) connected.tick();
        else if (!connecting && Date.parse(clock.now()) >= retryAt) void initialize().catch(() => {});
      },
      stop(localRequests?: Promise<void>): Promise<void> {
        if (!stopped) {
          shutdown.abort();
          const work = Promise.resolve().then(async () => {
            await connecting?.catch(() => {});
            if (connected) await connected.stop();
            await cached.stop();
            await health.stop();
          });
          stopped = Promise.allSettled([work, localRequests]).then(results => {
            for (const result of results) if (result.status === 'rejected') throw result.reason;
          }).finally(() => profile.close());
        }
        return stopped;
      },
    };
  } catch (error) { profile.close(); throw error; }
}

export async function startRuntime(config: Config, directory: string, clock: Clock, desktop: RuntimeDesktop, signal: AbortSignal, fetch: Fetch = globalThis.fetch) {
  const runtime = openRuntime(config, directory, clock, desktop, signal, fetch);
  try { await runtime.initialize(); return runtime; }
  catch (error) { await runtime.stop(); throw error; }
}

async function connectRuntime(config: Config, profile: Profile, logs: Diagnostics, clock: Clock, desktop: RuntimeDesktop, signal: AbortSignal, fetch: Fetch, health: MonitoringHealth) {
  const store = profile.store;
  const github = new GitHub(config.github.token, clock, store, fetch, valid => health.update(valid ? 'ready' : 'authentication_failed'));
  const shutdown = new AbortController();
  const manual = new Set<Promise<void>>();
  let monitor: Monitor | undefined;
  let phase = 'identity';
  try {
    const login = canonical(await github.identity(signal));
    phase = 'profile identity binding';
    const initialized = store.metadata('login') === login && store.metadata('discoveryComplete') !== undefined
      && z.array(z.string()).parse(JSON.parse(store.metadata('reviewRefreshPending') ?? '[]')).length === 0;
    const baseline = store.bindIdentity(login, clock.now());
    let teams: string[] = [];
    try {
      teams = await github.teams(signal);
      store.setMetadata('teams', JSON.stringify(teams));
    } catch { signal.throwIfAborted(); logs.write('warn', 'GitHub team lookup failed'); }
    signal.throwIfAborted();
    const classifier = config.system_one ? new SystemOne(config.system_one, fetch) : undefined;
    const core = new Monitor(store, clock, login, teams, baseline, classifier, config.timings.grace_period);
    monitor = core;
    const collector = new Collector(store, clock, github);
    const delivery = new Delivery(store, clock, typeof desktop === 'function' ? desktop(store, login) : desktop,
      (id, result) => logs.write('error', 'Desktop submission failed', { id, result }));
    let degraded = false;
    const discover = async (signal: AbortSignal) => {
      try {
        if (health.view().state === 'authentication_failed') {
          const current = canonical(await github.identity(signal));
          if (current !== login) throw new Error('GitHub identity changed; update Settings to reconnect');
        }
        await github.discover(login, async (repository, number) => {
          const known = store.prs().find(pr => pr.snapshot.repository.toLowerCase() === repository.toLowerCase() && pr.snapshot.number === number);
          if (known) await core.lookup(known.snapshot.id, 'discovery', owned => github.detail(repository, number, AbortSignal.any([signal, owned])));
          else {
            const snapshot = await github.detail(repository, number, signal);
            await core.lookup(snapshot.id, 'discovery', async () => snapshot);
          }
        }, signal);
        signal.throwIfAborted();
        store.setMetadata('discoveryComplete', clock.now());
        store.setMetadata('discoveryStatus', 'ready');
        if (degraded) logs.write('info', 'Discovery recovered');
        degraded = false;
      } catch (error) {
        signal.throwIfAborted();
        degraded = true;
        store.setMetadata('discoveryStatus', 'degraded');
        throw error;
      }
    };
    store.prune(clock.now(), config.history.raw_payload_retention);
    core.reconcile();
    phase = 'discovery';
    try { await discover(signal); }
    catch (error) {
      if (!initialized || !(error instanceof GitHubUnavailable)) throw error;
      logs.write('warn', 'Discovery unavailable; serving saved state and recovering delivery', { error });
    }
    signal.throwIfAborted();
    phase = 'review-target upgrade refresh';
    const pending = z.array(z.string()).parse(JSON.parse(store.metadata('reviewRefreshPending') ?? '[]'));
    for (const id of [...pending]) {
      const pr = store.pr(id);
      if (!pr) throw new Error('Upgrade references a missing pull request');
      await core.lookup(id, 'discovery', owned => github.detail(pr.snapshot.repository, pr.snapshot.number, AbortSignal.any([signal, owned])));
      pending.splice(pending.indexOf(id), 1);
      store.setMetadata('reviewRefreshPending', JSON.stringify(pending));
    }
    delivery.recover();
    const scheduler = new Scheduler(core, delivery, clock, {
      poll: (pr, signal) => collector.collect(pr, signal), discover,
      report: (error, scope) => logs.write('error', 'Background operation failed', { scope, error }),
    }, config.timings.tracked_poll_interval, config.timings.discovery_poll_interval);
    let maintenanceAt = Date.parse(clock.now()) + 86_400_000;
    let stopped: Promise<void> | undefined;
    return {
      profile, monitor: core, delivery, scheduler, logs, login, teams,
      track(url: string, callerSignal: AbortSignal): Promise<void> {
        const work = Promise.resolve().then(async () => {
          const signal = AbortSignal.any([callerSignal, shutdown.signal]);
          signal.throwIfAborted();
          const target = pullRequestUrl(url);
          const known = store.prs().find(pr => pr.snapshot.repository.toLowerCase() === target.repository.toLowerCase() && pr.snapshot.number === target.number);
          if (known) await core.lookup(known.snapshot.id, 'manual', owned => github.detail(target.repository, target.number, AbortSignal.any([signal, owned])));
          else { const snapshot = await github.detail(target.repository, target.number, signal); await core.lookup(snapshot.id, 'manual', async () => snapshot); }
        });
        manual.add(work);
        void work.finally(() => manual.delete(work)).catch(() => {});
        return work;
      },
      tick(): void {
        if (stopped) return;
        if (Date.parse(clock.now()) >= maintenanceAt) {
          try { store.prune(clock.now(), config.history.raw_payload_retention); }
          catch { logs.write('error', 'Payload maintenance failed'); }
          maintenanceAt = Date.parse(clock.now()) + 86_400_000;
        }
        scheduler.tick();
      },
      stop(): Promise<void> {
        if (!stopped) {
          shutdown.abort();
          stopped = Promise.all([scheduler.stop(), Promise.allSettled(manual)]).then(() => {});
        }
        return stopped;
      },
    };
  } catch (error) {
    await monitor?.stop();
    if (!signal.aborted) logs.write('error', 'Background initialization failed', { phase, error });
    throw new Error(`Octopulse startup failed during ${phase}; see profile diagnostics`);
  }
}
