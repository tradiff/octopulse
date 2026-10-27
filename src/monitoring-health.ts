import { z } from 'zod';
import { Instant } from './model.js';
import type { Clock, Desktop } from './model.js';
import type { Store } from './store.js';
import { abortable } from './cancellation.js';

const Status = z.strictObject({
  state: z.enum(['starting', 'ready', 'missing_token', 'authentication_failed']),
  since: Instant,
});
export type MonitoringStatus = z.infer<typeof Status>;

export class MonitoringHealth {
  private status: MonitoringStatus;
  private alerted: boolean;
  private readonly pending = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  destination = 'http://127.0.0.1:3000/settings';

  constructor(private readonly store: Store, private readonly clock: Clock, private readonly desktop: () => Desktop,
    private readonly report: (message: string) => void) {
    const saved = store.metadata('monitoringStatus');
    this.status = saved ? Status.parse(JSON.parse(saved)) : { state: 'starting', since: clock.now() };
    this.alerted = store.metadata('credentialAlerted') === 'true';
  }

  view(): MonitoringStatus { return { ...this.status }; }

  update(state: MonitoringStatus['state']): void {
    if (this.shutdown.signal.aborted) return;
    if (this.status.state !== state) {
      this.status = { state, since: this.clock.now() };
      this.store.setMetadata('monitoringStatus', JSON.stringify(this.status));
    }
    if (state === 'ready' && this.alerted) {
      this.store.setMetadata('credentialAlerted', 'false');
      this.alerted = false;
    }
    if (state !== 'missing_token' && state !== 'authentication_failed') return;
    if (this.alerted) return;
    // Claim before submission: a crash or ambiguous desktop result must not cause repeated alerts.
    this.store.setMetadata('credentialAlerted', 'true');
    this.alerted = true;
    this.report(state === 'missing_token' ? 'GitHub monitoring disabled: no token configured' : 'GitHub monitoring authentication failed');
    const work = Promise.resolve().then(async () => {
      const result = await abortable(this.desktop().submit({
        prId: '', kind: 'monitoring', events: [], title: 'Octopulse needs your attention',
        body: state === 'missing_token'
          ? 'GitHub monitoring is off because no token is configured. Add a token in Settings; PR activity and notifications are not updating.'
          : 'GitHub rejected your token. It may have expired or been revoked. Update it in Settings; PR activity and notifications may be out of date.',
        destination: this.destination, expiryMs: 0, sound: null,
      }, this.shutdown.signal), this.shutdown.signal);
      if (result !== 'sent') this.report('Monitoring alert could not be delivered; the warning remains in the web UI');
    }).catch(() => {
      if (!this.shutdown.signal.aborted) this.report('Monitoring alert could not be delivered; the warning remains in the web UI');
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  async idle(): Promise<void> { await Promise.all(this.pending); }
  async stop(): Promise<void> { this.shutdown.abort(); await this.idle(); }
}
