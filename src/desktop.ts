import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import sharp from 'sharp';
import type { Clock, Desktop, Intent } from './model.js';
import type { Fetch } from './http.js';
import { abortable } from './cancellation.js';
import { Store } from './store.js';
import { intent as present } from './presentation.js';
import { Semaphore } from './concurrency.js';

export class AvatarCache {
  private readonly slots = new Semaphore(4);
  private readonly pending = new Map<string, { work: Promise<string | null>; controller: AbortController; users: number }>();
  private readonly failures = new Map<string, number>();
  constructor(private readonly directory: string, private readonly clock: Clock, private readonly fetch: Fetch = globalThis.fetch) {}

  async image(input: string, signal: AbortSignal): Promise<string | null> {
    let url: URL;
    try { url = new URL(input); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || signal.aborted) return null;
    let entry = this.pending.get(url.href);
    if (!entry) {
      if (this.pending.size >= 32) return null;
      const controller = new AbortController();
      const work = Promise.resolve().then(() => this.load(url, controller.signal))
        .finally(() => { if (this.pending.get(url.href)?.controller === controller) this.pending.delete(url.href); });
      entry = { work, controller, users: 0 };
      this.pending.set(url.href, entry);
    }
    entry.users++;
    try { return await abortable(entry.work, signal); }
    catch { return null; }
    finally { if (--entry.users === 0) entry.controller.abort(); }
  }

  private async load(url: URL, signal: AbortSignal): Promise<string | null> {
    const key = createHash('sha256').update(url.href).digest('hex');
    const path = join(this.directory, `${key}.18.png`);
    let cached = false;
    try {
      await stat(path);
    } catch {
      try {
        const legacy = join(this.directory, `${key}.image`);
        const info = await stat(legacy);
        if (info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024) {
          await this.slots.run(async () => {
            await this.saveThumbnail(await readFile(legacy), path, signal);
            await utimes(path, info.atime, info.mtime);
          }, signal);
        }
      } catch { signal.throwIfAborted(); }
    }
    try {
      const info = await stat(path);
      cached = info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024;
      if (cached && Date.parse(this.clock.now()) - info.mtimeMs < 86_400_000) return pathToFileURL(path).href;
    } catch { /* Missing cache is fetched below. */ }
    if ((this.failures.get(url.href) ?? 0) > Date.parse(this.clock.now())) return cached ? pathToFileURL(path).href : null;
    try { return await this.slots.run(() => this.download(url, path, signal), signal); }
    catch {
      this.failures.delete(url.href);
      this.failures.set(url.href, Date.parse(this.clock.now()) + 60_000);
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
      if (cached) { try { await readFile(path); return pathToFileURL(path).href; } catch { return null; } }
      return null;
    }
  }

  private async download(url: URL, path: string, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      combined.throwIfAborted();
      const response = await abortable(this.fetch(url.href, { redirect: 'manual', signal: combined }), combined);
      reader = response.body?.getReader();
      if (!response.ok || !reader || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('Avatar unavailable');
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await abortable(reader.read(), combined);
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Avatar too large');
        chunks.push(chunk.value);
      }
      await this.saveThumbnail(Buffer.concat(chunks), path, combined);
      this.failures.delete(url.href);
      return pathToFileURL(path).href;
    } finally { clearTimeout(timer); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  }

  private async saveThumbnail(bytes: Buffer, path: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (bytes.length > 2 * 1024 * 1024 || (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))) throw new Error('Unsupported avatar');
    const thumbnail = await sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'error' })
      .rotate().resize(18, 18, { fit: 'cover' }).png().timeout({ seconds: 5 }).toBuffer();
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(path, thumbnail, { mode: 0o600 });
  }
}

export interface DesktopMessage {
  appName: 'Octopulse'; replacesId: 0; icon: string; summary: string; body: string;
  actions: string[]; hints: Record<string, string | boolean>; expireTimeout: 0 | 10000;
}
export interface NotificationTransport {
  capabilities(signal: AbortSignal): Promise<unknown>;
  notify(message: DesktopMessage, destination: string, signal: AbortSignal): Promise<unknown>;
}

export interface NotificationBus {
  call(request: {
    destination: 'org.freedesktop.Notifications'; path: '/org/freedesktop/Notifications'; interface: 'org.freedesktop.Notifications';
    member: 'GetCapabilities' | 'Notify'; signature: string; body: unknown[];
  }, signal: AbortSignal): Promise<unknown>;
}

export class FreedesktopTransport implements NotificationTransport {
  private readonly destinations = new Map<number, string>();
  constructor(private readonly bus: NotificationBus, private readonly open: (url: string) => Promise<void>) {}

  async capabilities(signal: AbortSignal): Promise<string[]> {
    const answer = await this.bus.call({ destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications',
      interface: 'org.freedesktop.Notifications', member: 'GetCapabilities', signature: '', body: [],
    }, signal);
    return z.tuple([z.array(z.string())]).parse(answer)[0];
  }

  async notify(message: DesktopMessage, destination: string, signal: AbortSignal): Promise<number> {
    const hints = Object.fromEntries(Object.entries(message.hints).map(([key, value]) => [key, { signature: typeof value === 'string' ? 's' : 'b', value }]));
    const answer = await this.bus.call({ destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications',
      interface: 'org.freedesktop.Notifications', member: 'Notify', signature: 'susssasa{sv}i',
      body: [message.appName, message.replacesId, message.icon, message.summary, message.body, message.actions, hints, message.expireTimeout],
    }, signal);
    const id = z.tuple([z.number().int().positive().max(0xffffffff)]).parse(answer)[0];
    this.destinations.set(id, destination);
    return id;
  }

  async actionInvoked(id: number, action: string): Promise<void> {
    const destination = this.destinations.get(id);
    if (action === 'default' && destination) await this.open(destination);
  }

  notificationClosed(id: number): void { this.destinations.delete(id); }
  reset(): void { this.destinations.clear(); }
}
const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);

export class DesktopAdapter implements Desktop {
  constructor(private readonly store: Store, private readonly user: string, private readonly transport: NotificationTransport, private readonly avatars?: AvatarCache) {}

  async submit(intent: Intent, signal: AbortSignal): Promise<'sent' | 'transient'> {
    try {
      const capabilities = z.array(z.string()).parse(await this.transport.capabilities(signal));
      const pr = this.store.pr(intent.prId);
      const history = this.store.activities(intent.prId);
      const events = intent.events.flatMap(key => history.filter(item => `${item.event.source}:${item.event.id}` === key).map(item => item.event));
      const current = pr && events.length === intent.events.length ? present(pr.snapshot, events, intent.kind, this.user, history) : intent;
      const state = pr?.snapshot.state === 'open' && pr.snapshot.draft ? 'draft' : pr?.snapshot.state ?? 'open';
      const images = new Map<string, string | null>();
      if (capabilities.includes('body-markup') && capabilities.includes('body-images') && this.avatars) {
        const urls = [...new Set([
          ...(pr?.snapshot.authorAvatar ? [pr.snapshot.authorAvatar] : []),
          ...(events.length === intent.events.length ? events.flatMap(event => event.actor?.avatar && !event.kind.startsWith('ci_') ? [event.actor.avatar] : []) : []),
        ])].slice(0, 16);
        const budget = new AbortController();
        const combined = AbortSignal.any([signal, budget.signal]);
        const timer = setTimeout(() => budget.abort(), 750);
        const loading = Promise.all(urls.map(async url => { images.set(url, await this.avatars!.image(url, signal)); }));
        try { await abortable(loading, combined); }
        catch { signal.throwIfAborted(); }
        finally { clearTimeout(timer); budget.abort(); }
      }
      signal.throwIfAborted();
      let body = intent.body;
      if (capabilities.includes('body-markup')) {
        body = escape(body);
        if (events.length === intent.events.length) {
          const paragraphs = intent.body.split('\n\n');
          if (paragraphs.length === events.length) {
            const rendered: string[] = [];
            for (let i = 0; i < events.length; i++) {
              const event = events[i]!;
              const image = event.actor?.avatar && !event.kind.startsWith('ci_') ? images.get(event.actor.avatar) : null;
              const paragraph = event.kind === 'comment'
                ? paragraphs[i]!.replace(/^((?:[^:\n]+: )?💬) commented(?:: |$)/, '$1 ') : paragraphs[i]!;
              const actor = event.actor && !event.kind.startsWith('ci_') ? event.actor.login : null;
              const text = actor && paragraph.startsWith(`${actor}: `)
                ? `<b>${escape(actor)}</b>${escape(paragraph.slice(actor.length))}` : escape(paragraph);
              rendered.push(`${image ? `<img src="${escape(image)}" alt="" width="18" height="18"/> ` : ''}${text}`);
            }
            body = rendered.join('<br/>&#160;<br/>');
          }
        }
        if (pr) {
          let image = '';
          if (capabilities.includes('body-images') && pr.snapshot.authorAvatar && this.avatars) {
            const uri = images.get(pr.snapshot.authorAvatar);
            if (uri) image = `<img src="${escape(uri)}" alt="" width="18" height="18"/> `;
          }
          body = `${image}${escape(`[${pr.snapshot.repository}] ${pr.snapshot.title} (${state})`)}<br/>&#160;<br/>${body}`;
        }
      }
      const id = await this.transport.notify({
        appName: 'Octopulse', replacesId: 0, icon: `git-${state}`,
        summary: pr && capabilities.includes('body-markup') ? '' : current.title, body,
        actions: capabilities.includes('actions') ? ['default', 'Open pull request'] : [],
        hints: { 'desktop-entry': 'octopulse', ...(current.sound && capabilities.includes('sound') ? { 'sound-name': `octopulse-${current.sound}` } : {}) },
        expireTimeout: current.expiryMs,
      }, intent.destination, signal);
      z.number().int().positive().max(0xffffffff).parse(id);
      return 'sent';
    } catch { return 'transient'; }
  }
}
