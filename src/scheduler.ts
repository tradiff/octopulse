import type { Clock, PullRequest } from './model.js';
import { Monitor } from './monitor.js';
import { Delivery } from './delivery.js';
import { abortable } from './cancellation.js';

interface Work {
  poll(pr: PullRequest, signal: AbortSignal): Promise<unknown>;
  discover(signal: AbortSignal): Promise<void>;
  report(error: unknown, scope: string): void;
}

export class Scheduler {
  private activeAt: number;
  private graceAt: number;
  private discoveryAt: number;
  private sweepRunning = false;
  private discoveryRunning = false;
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
      if (!this.sweepRunning) this.startSweep('active');
    }
    if (now >= this.graceAt) {
      if (this.sweepRunning) this.graceAt = now + 1000;
      else this.startSweep('grace');
    }
    if (now >= this.discoveryAt) {
      this.discoveryAt += (Math.floor((now - this.discoveryAt) / this.discoveryMs) + 1) * this.discoveryMs;
      if (!this.discoveryRunning) {
        this.discoveryRunning = true;
        this.launch(Promise.resolve().then(() => abortable(this.work.discover(this.shutdown.signal), this.shutdown.signal))
          .finally(() => { this.discoveryRunning = false; }), 'discovery');
      }
    }
  }

  private startSweep(kind: 'active' | 'grace'): void {
    this.sweepRunning = true;
    const operation = this.sweep(kind).finally(() => { this.sweepRunning = false; });
    this.launch(operation, kind);
  }

  private async sweep(kind: 'active' | 'grace'): Promise<void> {
    const ids = this.monitor.select(kind);
    let index = 0;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (!this.stopped) {
        const id = ids[index++];
        if (!id) return;
        try { await this.monitor.poll(id, (pr, signal) => this.work.poll(pr, signal)); }
        catch (error) { failed = true; if (!this.stopped) this.work.report(error, id); }
      }
    }));
    if (kind === 'grace') this.graceAt = Date.parse(this.clock.now()) + (failed ? 60_000 : 900_000);
  }

  private launch(work: Promise<void>, scope: string): void {
    const guarded = work.catch(error => { if (!this.stopped) this.work.report(error, scope); });
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
