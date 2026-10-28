import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { notificationHistory, pullRequestActivity, pullRequests } from './views.js';
import { ActivityCursor } from './store.js';
import type { Store } from './store.js';
import type { Monitor } from './monitor.js';
import type { Delivery } from './delivery.js';
import type { Diagnostics } from './diagnostics.js';
import { pullRequestUrl } from './config.js';
import type { Settings } from './settings.js';
import type { MonitoringStatus } from './monitoring-health.js';
import type { RefreshStatus } from './scheduler.js';

export interface LocalApplication {
  store: Store; monitor: Monitor; delivery: Pick<Delivery, 'resend'>; logs: Diagnostics; login: string; teams: string[];
  track(url: string, signal: AbortSignal): Promise<void>;
  refresh(): RefreshStatus;
  readonly refreshStatus: RefreshStatus | null;
  settings?: Settings;
  monitoring?: MonitoringStatus;
  updateSettings?(body: unknown): Promise<void>;
}

export async function listenLocal(app: LocalApplication, port: number) {
  const assets = new Map([
    ['/', { type: 'text/html', data: await readFile(new URL('../../web/index.html', import.meta.url)) }],
    ['/app.js', { type: 'text/javascript', data: await readFile(new URL('./browser.js', import.meta.url)) }],
    ['/filters.js', { type: 'text/javascript', data: await readFile(new URL('./filters.js', import.meta.url)) }],
    ['/app.css', { type: 'text/css', data: await readFile(new URL('../../web/app.css', import.meta.url)) }],
    ['/icon.svg', { type: 'image/svg+xml', data: await readFile(new URL('../../assets/octopulse-mark-blue.svg', import.meta.url)) }],
    ['/favicon.svg', { type: 'image/svg+xml', data: await readFile(new URL('../../assets/octopulse-mark-small-blue.svg', import.meta.url)) }],
  ]);
  for (const state of ['open', 'draft', 'merged', 'closed']) {
    assets.set(`/git-${state}.svg`, { type: 'image/svg+xml', data: await readFile(new URL(`../../assets/git-${state}.svg`, import.meta.url)) });
    assets.set(`/git-${state}-inline.svg`, { type: 'image/svg+xml', data: await readFile(new URL(`../../assets/git-${state}-inline.svg`, import.meta.url)) });
  }
  const token = randomBytes(32).toString('hex');
  const validatorSalt = randomBytes(16).toString('hex');
  let origin = '';
  const pending = new Set<Promise<void>>();
  const shutdown = new AbortController();
  function send(response: ServerResponse, status: number, body: unknown, head = false) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(head ? undefined : JSON.stringify(body));
  }
  function conditional(request: IncomingMessage, response: ServerResponse, url: URL, body: () => unknown, revision?: string): void {
    const serialized = revision === undefined ? JSON.stringify(body()) : undefined;
    const etag = `W/"${createHash('sha256').update(JSON.stringify([validatorSalt, url.pathname, url.search, revision ?? serialized])).digest('base64url')}"`;
    response.setHeader('ETag', etag);
    const validators = request.headers['if-none-match'];
    if (validators && (validators.trim() === '*' || validators.split(',').some(value => value.trim().replace(/^W\//, '') === etag.slice(2)))) {
      response.writeHead(304); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(serialized ?? JSON.stringify(body()));
  }
  async function json(request: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 16 * 1024) { request.resume(); throw new Error('Request body too large'); }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== new URL(origin).host) { send(response, 403, { error: 'Invalid local Host' }); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', origin); } catch { send(response, 400, { error: 'Invalid URL' }); return; }
    if (url.origin !== origin) { send(response, 403, { error: 'Invalid request origin' }); return; }
    const method = request.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';
    if (read) {
      const page = ['/', '/notification-history', '/logs', '/settings'].includes(url.pathname) ? assets.get('/') : assets.get(url.pathname);
      if (page) { response.writeHead(200, { 'Content-Type': `${page.type}; charset=utf-8` }); response.end(method === 'HEAD' ? undefined : page.data); return; }
      if (url.pathname === '/health') { send(response, 200, { status: 'ok' }, method === 'HEAD'); return; }
      if (method !== 'GET') { send(response, 404, { error: 'Not found' }, true); return; }
      const activity = /^\/api\/pull-requests\/([^/]+)\/activity$/.exec(url.pathname);
      if (activity) {
        let id: string;
        try { id = decodeURIComponent(activity[1]!); } catch { send(response, 400, { error: 'Invalid pull request ID' }); return; }
        const pr = app.store.pr(id);
        if (!pr) { send(response, 404, { error: 'Unknown pull request' }); return; }
        let cursor: ReturnType<typeof ActivityCursor.parse> | null = null;
        if (url.searchParams.has('cursor')) {
          try { cursor = ActivityCursor.parse(JSON.parse(url.searchParams.get('cursor')!)); }
          catch { send(response, 400, { error: 'Invalid activity cursor' }); return; }
        }
        send(response, 200, pullRequestActivity(app.store, pr, cursor)); return;
      }
      switch (url.pathname) {
        case '/api/refresh': conditional(request, response, url, () => app.refreshStatus); return;
        case '/api/settings': send(response, 200, app.settings?.view() ?? {}); return;
        case '/api/me': conditional(request, response, url, () => ({ login: app.login, teams: app.teams, actionToken: token, monitoring: app.monitoring })); return;
        case '/api/monitoring': conditional(request, response, url, () => app.monitoring ?? { state: 'ready', since: null }); return;
        case '/api/tracked-pull-requests':
        case '/api/inactive-pull-requests':
          send(response, 200, app.store.prs().filter(pr => pr.tracked === (url.pathname === '/api/tracked-pull-requests')).map(pr => pr.snapshot)); return;
        case '/api/pull-request-timeline':
          conditional(request, response, url, () => pullRequests(app.store, app.monitor, url.searchParams),
            JSON.stringify([app.store.changeToken(), app.monitor.user, app.monitor.teams])); return;
        case '/api/notification-history':
          conditional(request, response, url, () => notificationHistory(app.store, url.searchParams), app.store.changeToken()); return;
        case '/api/logs': {
          const level = z.enum(['debug', 'info', 'warn', 'error']).safeParse(url.searchParams.get('level'));
          conditional(request, response, url, () => ({ items: app.logs.read(level.success ? level.data : undefined) }), app.logs.changeToken()); return;
        }
      }
    }
    const untrack = /^\/api\/tracked-pull-requests\/([^/]+)$/.exec(url.pathname);
    const resend = /^\/api\/notification-records\/(\d+)\/resend$/.exec(url.pathname);
    const settings = method === 'PUT' && url.pathname === '/api/settings';
    const refresh = method === 'POST' && url.pathname === '/api/refresh';
    const mutation = refresh || settings || method === 'POST' && url.pathname === '/api/tracked-pull-requests' || method === 'DELETE' && untrack || method === 'POST' && resend;
    if (!mutation) { send(response, 404, { error: 'Not found' }); return; }
    if (request.headers.origin !== origin || request.headers['x-octopulse-action'] !== token || request.headers['sec-fetch-site'] === 'cross-site') {
      send(response, 403, { error: 'Same-origin action authorization required' }); return;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { send(response, 400, { error: 'Expected a JSON body' }); return; }
    let body: unknown;
    try { body = await json(request); } catch { send(response, 400, { error: 'Invalid or oversized JSON body' }); return; }
    if (refresh) {
      if (!z.strictObject({}).safeParse(body).success) { send(response, 400, { error: 'Expected an empty refresh request' }); return; }
      try {
        const progress = app.refresh();
        response.setHeader('Location', '/api/refresh'); response.setHeader('Retry-After', '1');
        send(response, 202, progress);
      }
      catch { send(response, 503, { error: 'GitHub refresh is unavailable. Check monitoring status and Settings, then retry.' }); }
    } else if (settings) {
      if (!app.updateSettings || !app.settings) { send(response, 503, { error: 'Settings unavailable' }); return; }
      try { await app.updateSettings(body); send(response, 200, app.settings.view()); }
      catch { send(response, 400, { error: 'Unable to save settings. Check durations, provider URL, and required credentials, then retry.' }); }
    } else if (untrack) {
      try { app.monitor.untrack(decodeURIComponent(untrack[1]!)); send(response, 200, { status: 'untracked' }); }
      catch { send(response, 400, { error: 'Unknown pull request' }); }
    } else if (resend) {
      const id = Number(resend[1]);
      try {
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid notification');
        await app.delivery.resend(id);
        if (app.store.notification(id).status !== 'sent') throw new Error('Submission failed');
        send(response, 200, { status: 'sent' });
      } catch { send(response, 500, { error: 'Notification resend failed' }); }
    } else {
      const parsed = z.strictObject({ url: z.string().trim().min(1) }).safeParse(body);
      if (!parsed.success) { send(response, 400, { error: 'Expected a nonblank pull request URL' }); return; }
      try {
        const target = pullRequestUrl(parsed.data.url);
        const existing = app.store.prs().find(pr => pr.snapshot.repository.toLowerCase() === target.repository.toLowerCase() && pr.snapshot.number === target.number);
        await app.track(parsed.data.url, shutdown.signal);
        send(response, existing?.tracked ? 200 : 201, { status: existing?.tracked ? 'already-tracked' : 'tracked' });
      } catch { send(response, 400, { error: 'Unable to track pull request; check URL and GitHub access' }); }
    }
  }
  const server = createServer((request, response) => {
    const work = handle(request, response).catch(() => { if (!response.headersSent) send(response, 500, { error: 'Local operation failed' }); else response.end(); });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local listener address');
  origin = `http://127.0.0.1:${address.port}`;
  let stopping: Promise<void> | undefined;
  return { origin, stop(): Promise<void> {
    if (!stopping) {
      shutdown.abort();
      stopping = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
      }).then(async () => { await Promise.allSettled(pending); });
    }
    return stopping;
  } };
}
