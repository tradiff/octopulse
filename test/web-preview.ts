import { webFixture } from './web-fixture.js';

const fixture = await webFixture(process.env.OCTOPULSE_RICH_COMMENTS === '1');
console.log(`Synthetic Octopulse UI: ${fixture.local.origin}`);
let closing = false;
const stop = () => { if (!closing) { closing = true; void fixture.close().then(() => { process.exitCode = 0; }); } };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
