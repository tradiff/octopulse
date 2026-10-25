import { runDaemon, daemonOptions } from '../src/daemon.js';

const shutdown = new AbortController();
process.on('SIGTERM', () => shutdown.abort()); process.on('SIGINT', () => shutdown.abort());
try {
  await runDaemon(daemonOptions(process.argv.slice(2)), shutdown,
    async url => new Response(JSON.stringify(url.includes('/user/teams') ? [] : { total_count: 0, incomplete_results: false, items: [] })), {});
} catch { if (!shutdown.signal.aborted) process.exitCode = 1; }
