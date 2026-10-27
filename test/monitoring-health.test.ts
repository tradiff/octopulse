import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { startApplication } from '../src/application.js';
import { MonitoringHealth } from '../src/monitoring-health.js';
import { Profile } from '../src/profile.js';
import { DesktopAdapter } from '../src/desktop.js';
import type { DesktopMessage } from '../src/desktop.js';
import { RecordingDesktop, temporaryProfile, VirtualClock } from './fixture.js';

const T = '2026-10-27T12:00:00Z';
const emptySearch = () => Response.json({ total_count: 0, incomplete_results: false, items: [] });

test('missing credentials warn once across ticks, settings changes and restarts; success re-arms the alert', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = new RecordingDesktop(); const clock = new VirtualClock(T);
  const start = () => startApplication(undefined, directory, clock, desktop, new AbortController().signal, 0, async url => {
    if (url.endsWith('/user')) return Response.json({ login: 'alex' });
    if (url.includes('/user/teams')) return Response.json([]);
    return emptySearch();
  });
  let app = await start(); t.after(() => app.stop()); await app.initialize();
  assert.equal(app.monitoring.state, 'missing_token');
  assert.equal(desktop.submissions.length, 1);
  assert.equal(desktop.submissions[0]!.destination, app.origin + '/settings');
  assert.equal(desktop.submissions[0]!.kind, 'monitoring');
  assert.equal(desktop.submissions[0]!.expiryMs, 0);
  assert.deepEqual(await (await fetch(app.origin + '/api/monitoring')).json(), app.monitoring);
  const me = await (await fetch(app.origin + '/api/me')).json() as { monitoring: unknown };
  assert.deepEqual(me.monitoring, app.monitoring);
  for (let i = 0; i < 5; i++) { app.tick(); await app.initialize(); }
  await app.updateSettings({ github: {} }); await app.initialize();
  await app.stop(); app = await start(); await app.initialize();
  assert.equal(desktop.submissions.length, 1, 'No reminders for the same unresolved incident');
  await app.updateSettings({ github: { token: 'working-token' } }); await app.initialize();
  assert.equal(app.monitoring.state, 'ready');
  await app.updateSettings({ github: { token: null } }); await app.initialize();
  assert.equal(app.monitoring.state, 'missing_token');
  assert.equal(desktop.submissions.length, 2, 'A new failure after recovery gets a new alert');
});

test('rejected tokens warn once through initialization retries and restart, without assuming a replacement works', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = new RecordingDesktop(); const clock = new VirtualClock(T);
  const start = () => startApplication(undefined, directory, clock, desktop, new AbortController().signal, 0,
    async () => Response.json({ message: 'Bad credentials' }, { status: 401 }), { GITHUB_TOKEN: 'expired-token' });
  let app = await start(); t.after(() => app.stop());
  await assert.rejects(app.initialize(), /identity/);
  assert.equal(app.monitoring.state, 'authentication_failed');
  assert.equal(desktop.submissions.length, 1);
  assert.match(desktop.submissions[0]!.body, /expired or been revoked/);
  for (let i = 0; i < 3; i++) await assert.rejects(app.initialize());
  await app.updateSettings({ github: { token: 'also-invalid' } });
  await assert.rejects(app.initialize());
  await app.stop(); app = await start(); await assert.rejects(app.initialize());
  assert.equal(desktop.submissions.length, 1);
  assert.equal((await fetch(app.origin + '/api/monitoring')).status, 200);
});

test('a token expiring during background operation is detected, deduplicated, recovered and re-armed', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  let expired = false;
  const clock = new VirtualClock(T); const desktop = new RecordingDesktop();
  const app = await startApplication(undefined, directory, clock, desktop, new AbortController().signal, 0, async url => {
    if (expired) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (url.endsWith('/user')) return Response.json({ login: 'alex' });
    if (url.includes('/user/teams')) return Response.json([]);
    return emptySearch();
  }, { GITHUB_TOKEN: 'synthetic-token' });
  t.after(() => app.stop()); await app.initialize();
  const sweep = async (at: string) => { clock.set(at); app.tick(); await app.scheduler.idle(); };
  assert.equal(app.monitoring.state, 'ready');
  expired = true;
  await sweep('2026-10-27T12:05:00Z');
  assert.equal(app.monitoring.state, 'authentication_failed');
  assert.equal(desktop.submissions.length, 1);
  await sweep('2026-10-27T12:10:00Z');
  assert.equal(desktop.submissions.length, 1);
  expired = false;
  await sweep('2026-10-27T12:15:00Z');
  assert.equal(app.monitoring.state, 'ready');
  expired = true;
  await sweep('2026-10-27T12:20:00Z');
  assert.equal(desktop.submissions.length, 2);
});

test('rate limits, transport failures and repository permissions are not reported as expired credentials', async t => {
  for (const response of [
    () => Response.json({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793110000' } }),
    () => Response.json({}, { status: 429 }),
    () => { throw new TypeError('Network unavailable'); },
  ]) {
    const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
    const desktop = new RecordingDesktop();
    const app = await startApplication(undefined, directory, new VirtualClock(T), desktop, new AbortController().signal, 0,
      async () => response(), { GITHUB_TOKEN: 'token' });
    await assert.rejects(app.initialize());
    assert.notEqual(app.monitoring.state, 'authentication_failed');
    assert.equal(desktop.submissions.length, 0); await app.stop();
  }
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = new RecordingDesktop();
  const app = await startApplication(undefined, directory, new VirtualClock(T), desktop, new AbortController().signal, 0, async url => {
    if (url.endsWith('/user')) return Response.json({ login: 'alex' });
    return Response.json({}, { status: 403 });
  }, { GITHUB_TOKEN: 'token' });
  t.after(() => app.stop()); await assert.rejects(app.initialize());
  assert.equal(desktop.submissions.length, 0);
});

test('failed desktop submission leaves a durable warning without retry spam', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory); t.after(() => profile.close());
  const desktop = new RecordingDesktop(); desktop.results.push('transient');
  const reports: string[] = [];
  const health = new MonitoringHealth(profile.store, new VirtualClock(T), () => desktop, message => reports.push(message));
  health.update('missing_token'); await health.idle();
  health.update('authentication_failed'); await health.idle();
  assert.equal(desktop.submissions.length, 1);
  assert.ok(reports.some(message => message.includes('could not be delivered')));
  const restarted = new MonitoringHealth(profile.store, new VirtualClock(T), () => desktop, () => {});
  restarted.update('authentication_failed'); await restarted.idle();
  assert.equal(desktop.submissions.length, 1);
  assert.equal(restarted.view().state, 'authentication_failed');
  await health.stop(); await restarted.stop();
});

test('desktop monitoring alert uses warning presentation and opens Settings rather than a PR', async t => {
  const directory = await temporaryProfile(); t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = new Profile(directory); t.after(() => profile.close());
  let message: DesktopMessage | undefined; let destination: string | undefined;
  const desktop = new DesktopAdapter(profile.store, '', {
    async capabilities() { return ['body-markup', 'actions']; },
    async notify(value, url) { message = value; destination = url; return 1; },
  });
  const health = new MonitoringHealth(profile.store, new VirtualClock(T), () => desktop, () => {});
  health.update('missing_token'); await health.idle();
  assert.equal(message!.icon, 'dialog-warning');
  assert.equal(message!.summary, 'Octopulse needs your attention');
  assert.deepEqual(message!.actions, ['default', 'Open Settings']);
  assert.equal(destination, 'http://127.0.0.1:3000/settings');
  await health.stop();
});
