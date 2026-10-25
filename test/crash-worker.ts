import { appendFileSync } from 'node:fs';
import { Delivery } from '../src/delivery.js';
import { Store } from '../src/store.js';
import { VirtualClock } from './fixture.js';

const [path, logPath, now] = process.argv.slice(2);
if (!path || !logPath || !now) throw new Error('Expected disposable profile, recording log, and clock');
const store = new Store(path);
const delivery = new Delivery(store, new VirtualClock(now), {
  async submit(intent) {
    appendFileSync(logPath, `${JSON.stringify(intent)}\n`);
    // Simulate acceptance followed by abrupt process death, bypassing cleanup.
    process.exit(73);
  },
});
await delivery.runDue();
throw new Error('Expected a prepared notification to reach the recording desktop');
