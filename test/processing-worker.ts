import { Profile } from '../src/profile.js';
import { Monitor } from '../src/monitor.js';
import { completeSources, VirtualClock } from './fixture.js';

const [directory, phase] = process.argv.slice(2);
if (!directory) throw new Error('Expected disposable profile');
const profile = new Profile(directory);
const clock = new VirtualClock('2026-10-22T12:00:00Z');
const snapshot = profile.store.pr('A')!.snapshot;
const monitor = new Monitor(profile.store, clock, 'alex', [], '2026-10-21T12:00:00Z', {
  async classify() { process.exit(75); },
});
await monitor.observe({ snapshot, sources: completeSources, events: [{
  source: 'issue_comment', id: 'crash-comment', kind: 'comment', occurredAt: clock.now(), body: 'Action needed',
  actor: { login: phase === 'classification' ? 'checks[bot]' : 'bea' },
}] });
if (phase === 'prepared') process.exit(76);
throw new Error('Expected abrupt processing stop');
