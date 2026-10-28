import type { Clock, PullRequest } from './model.js';
import { Monitor } from './monitor.js';
import { Delivery } from './delivery.js';
import { abortable } from './cancellation.js';
import { randomUUID } from 'node:crypto';

interface Work {
  poll(pr: PullRequest, signal: AbortSignal): Promise<unknown>;
  discover(signal: AbortSignal): Promise<void>;
  report(error: unknown, scope: string): void;
}

export interface RefreshResult { discoveryFailed: boolean; failedPullRequests: number }
export interface RefreshStatus extends RefreshResult {
  id: string; phase: 'discovering' | 'checking' | 'completed' | 'failed'; completed: number; total: number;
}
interface SweepResult { checked: Set<string>; failed: Set<string>; completed: Set<string>; ids: string[] }

export class Scheduler {
  private activeAt: number;
  private graceAt: number;
  private discoveryAt: number;
  private sweepWork: Promise<SweepResult> | undefined;
  private discoveryWork: Promise<void> | undefined;
  private refreshWork: Promise<RefreshResult> | undefined;
  private refreshState: RefreshStatus | null = null;
  private refreshCompleted = new Set<string>();
  private sweepState: SweepResult | undefined;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly monitor: Monitor,
    private readonly delivery: Delivery,
    private readonly clock: Clock,
    private readonly work: Work,
    private readonly activeMs = 60_000,
    private readonly discoveryMs = 300_000,
  ) {
    if (![activeMs, discoveryMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid scheduling interval');
    const now = Date.parse(clock.now());
    this.activeAt = now + activeMs;
    this.graceAt = now + 900_000;
    this.discoveryAt = now + discoveryMs;
    monitor.reconcile();
  }

  tick(): void {
    if (this.stopped) return;
    const now = Date.parse(this.clock.now());
    this.launch(this.delivery.runDue(), 'delivery');
    if (now >= this.activeAt) {
      this.activeAt += (Math.floor((now - this.activeAt) / this.activeMs) + 1) * this.activeMs;
      if (!this.sweepWork && !this.refreshWork) this.startSweep('active');
    }
    if (now >= this.graceAt) {
      if (this.sweepWork || this.refreshWork) this.graceAt = now + 1000;
      else this.startSweep('grace');
    }
    if (now >= this.discoveryAt) {
      this.discoveryAt += (Math.floor((now - this.discoveryAt) / this.discoveryMs) + 1) * this.discoveryMs;
      if (!this.refreshWork) this.startDiscovery();
    }
  }

  refresh(): Promise<RefreshResult> {
    if (this.stopped) return Promise.reject(new Error('Scheduler is stopped'));
    if (this.refreshWork) return this.refreshWork;
    const previousSweep = this.sweepWork;
    const previousState = this.sweepState;
    this.refreshCompleted = new Set(previousState?.completed);
    const progress: RefreshStatus = { id: randomUUID(), phase: 'discovering', completed: this.refreshCompleted.size, total: this.refreshCompleted.size,
      discoveryFailed: false, failedPullRequests: previousState?.failed.size ?? 0 };
    this.refreshState = progress;
    this.refreshWork = Promise.resolve().then(async () => {
      const discoveryFailed = await this.startDiscovery().then(() => false, () => true);
      this.shutdown.signal.throwIfAborted();
      progress.phase = 'checking'; progress.discoveryFailed = discoveryFailed;
      progress.total = new Set([...this.monitor.select('active'), ...this.monitor.select('grace'), ...(previousState?.ids ?? [])]).size;
      const previous = await previousSweep;
      this.shutdown.signal.throwIfAborted();
      const result = await this.startSweep('refresh', previous?.checked);
      this.shutdown.signal.throwIfAborted();
      const now = Date.parse(this.clock.now());
      const failedPullRequests = (previous?.failed.size ?? 0) + result.failed.size;
      this.activeAt = now + this.activeMs; this.discoveryAt = now + this.discoveryMs;
      this.graceAt = now + (failedPullRequests ? 60_000 : 900_000);
      progress.phase = 'completed'; progress.failedPullRequests = failedPullRequests;
      return { discoveryFailed, failedPullRequests };
    }).catch(error => {
      progress.phase = 'failed';
      throw error;
    }).finally(() => { this.refreshWork = undefined; this.refreshCompleted.clear(); });
    this.launch(this.refreshWork, 'refresh');
    return this.refreshWork;
  }

  get refreshStatus(): RefreshStatus | null { return this.refreshState ? { ...this.refreshState } : null; }

  startRefresh(): RefreshStatus {
    if (this.stopped) throw new Error('Scheduler is stopped');
    void this.refresh().catch(() => {});
    return this.refreshStatus!;
  }

  private startDiscovery(): Promise<void> {
    if (!this.discoveryWork) {
      this.discoveryWork = Promise.resolve().then(() => abortable(this.work.discover(this.shutdown.signal), this.shutdown.signal))
        .finally(() => { this.discoveryWork = undefined; });
      this.launch(this.discoveryWork, 'discovery');
    }
    return this.discoveryWork;
  }

  private startSweep(kind: 'active' | 'grace' | 'refresh', exclude = new Set<string>()): Promise<SweepResult> {
    this.sweepWork = this.sweep(kind, exclude).finally(() => { this.sweepWork = undefined; this.sweepState = undefined; });
    this.launch(this.sweepWork, kind);
    return this.sweepWork;
  }

  private async sweep(kind: 'active' | 'grace' | 'refresh', exclude: Set<string>): Promise<SweepResult> {
    const ids = (kind === 'refresh' ? [...this.monitor.select('active'), ...this.monitor.select('grace')] : this.monitor.select(kind)).filter(id => !exclude.has(id));
    const checked = new Set<string>(); const failed = new Set<string>();
    const completed = new Set<string>();
    this.sweepState = { checked, failed, completed, ids };
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (!this.stopped) {
        const id = ids[index++];
        if (!id) return;
        checked.add(id);
        try { await this.monitor.poll(id, (pr, signal) => this.work.poll(pr, signal)); }
        catch (error) { failed.add(id); if (!this.stopped) this.work.report(error, id); }
        finally {
          completed.add(id);
          if (this.refreshState && this.refreshWork) {
            this.refreshCompleted.add(id);
            this.refreshState.completed = this.refreshCompleted.size;
            this.refreshState.total = Math.max(this.refreshState.total, this.refreshState.completed);
            if (failed.has(id)) this.refreshState.failedPullRequests++;
          }
        }
      }
    }));
    if (kind === 'grace') this.graceAt = Date.parse(this.clock.now()) + (failed.size ? 60_000 : 900_000);
    return { checked, failed, completed, ids };
  }

  private launch(work: Promise<unknown>, scope: string): void {
    const guarded = work.then(() => {}, error => { if (!this.stopped) this.work.report(error, scope); });
    this.pending.add(guarded);
    void guarded.finally(() => this.pending.delete(guarded));
  }

  async idle(): Promise<void> { await Promise.all(this.pending); }

  deadlines(): { active: string; grace: string; discovery: string } {
    return { active: new Date(this.activeAt).toISOString(), grace: new Date(this.graceAt).toISOString(), discovery: new Date(this.discoveryAt).toISOString() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    await Promise.all([this.monitor.stop(), this.delivery.stop()]);
    await this.idle();
  }
}
