import type { Clock, Desktop, Notification } from './model.js';
import { Store } from './store.js';
import { abortable } from './cancellation.js';
import { Semaphore } from './concurrency.js';

const delays = [60_000, 300_000, 900_000, 3_600_000];
const maxAge = 86_400_000;

export class Delivery {
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly slots = new Semaphore(4);
  private readonly shutdown = new AbortController();
  private stopped = false;

  constructor(private readonly store: Store, private readonly clock: Clock, private readonly desktop: Desktop,
    private readonly onFailure?: (id: number, result: string) => void,
  ) {}

  recover(): void {
    this.store.transaction(() => {
      for (const { id, data } of this.store.runningNotifications()) {
        if (!data.runningAt) continue;
        const running = this.store.attempts(id).filter(attempt => attempt.data.result === 'running');
        for (const attempt of running) {
          this.store.saveAttempt(attempt.id, { ...attempt.data, result: 'ambiguous' });
        }
        this.fail(data, 'ambiguous', data.runningAt);
        this.store.saveNotification(id, data);
      }
    });
  }

  async runDue(): Promise<void> {
    if (this.stopped) return;
    const capacity = 4 - this.inFlight.size;
    if (capacity <= 0) return;
    const ids = this.store.dueNotificationIds(this.clock.now(), 4).filter(id => !this.inFlight.has(id)).slice(0, capacity);
    await Promise.all(ids.map(async first => {
      let id: number | undefined = first;
      while (id !== undefined && !this.stopped) {
        await this.start(id, false);
        if (this.stopped || this.inFlight.size >= 4) return;
        id = this.store.dueNotificationIds(this.clock.now(), 4).find(candidate => !this.inFlight.has(candidate));
      }
    }));
  }

  resend(id: number): Promise<void> { return this.start(id, true); }

  private start(id: number, manual: boolean): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Delivery is stopped'));
    const running = this.inFlight.get(id);
    if (running) return running;
    const deferredAttempt = Promise.resolve().then(() => this.slots.run(() => this.attempt(id, manual), this.shutdown.signal))
      .catch(error => { if (!this.stopped) throw error; });
    this.inFlight.set(id, deferredAttempt);
    return deferredAttempt.finally(() => { this.inFlight.delete(id); });
  }

  private async attempt(id: number, manual: boolean): Promise<void> {
    if (this.stopped) return;
    let data = this.store.notification(id);
    if (data.runningAt) return;
    if (manual) {
      data = { ...data, preparedAt: this.clock.now(), attempts: 0, automatic: true, reason: null,
        status: 'pending', deliveredAt: null, nextAttemptAt: this.clock.now() };
    } else {
      if (!data.automatic || data.status === 'sent') return;
      if (Date.parse(this.clock.now()) >= Date.parse(data.preparedAt) + maxAge) {
        this.store.saveNotification(id, { ...data, status: 'failed', nextAttemptAt: null, automatic: false, reason: 'expired' });
        return;
      }
      if (!data.nextAttemptAt || Date.parse(data.nextAttemptAt) > Date.parse(this.clock.now())) return;
    }
    if (Date.parse(this.clock.now()) >= Date.parse(data.preparedAt) + maxAge) return;
    data.runningAt = this.clock.now();
    data.attempts++;
    data.nextAttemptAt = null;
    const startedAt = data.runningAt;
    const attemptId = this.store.transaction(() => {
      this.store.saveNotification(id, data);
      return this.store.insertAttempt(id, { startedAt, finishedAt: null, result: 'running' });
    });
    let result: 'sent' | 'transient' | 'permanent' | 'ambiguous';
    const controller = new AbortController();
    this.controllers.add(controller);
    try { result = await abortable(this.desktop.submit(data.intent, controller.signal), controller.signal); }
    catch { result = controller.signal.aborted ? 'ambiguous' : 'transient'; }
    finally { this.controllers.delete(controller); }
    this.store.transaction(() => {
      let latestNotification = this.store.notification(id);
      this.store.saveAttempt(attemptId, { startedAt, finishedAt: this.clock.now(), result });
      if (result === 'sent') {
        latestNotification = { ...latestNotification, status: 'sent', deliveredAt: this.clock.now(), runningAt: null, nextAttemptAt: null, reason: null };
      } else this.fail(latestNotification, result, result === 'ambiguous' ? startedAt : this.clock.now());
      this.store.saveNotification(id, latestNotification);
    });
    if (result !== 'sent') this.onFailure?.(id, result);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.inFlight.values());
  }

  private fail(data: Notification, result: 'transient' | 'permanent' | 'ambiguous', anchor: string): void {
    data.status = 'failed';
    data.deliveredAt = null;
    data.runningAt = null;
    data.nextAttemptAt = null;
    if (!data.automatic) return;
    data.reason = result;
    if (result === 'permanent') data.automatic = false;
    else if (Date.parse(this.clock.now()) >= Date.parse(data.preparedAt) + maxAge) {
      data.reason = 'expired';
      data.automatic = false;
    } else {
      const delay = delays[data.attempts - 1];
      if (delay === undefined) {
        data.reason = 'exhausted';
        data.automatic = false;
      } else data.nextAttemptAt = new Date(Date.parse(anchor) + delay).toISOString();
    }
  }
}
