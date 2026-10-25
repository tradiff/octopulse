import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageType, Variant } from '@jellybrick/dbus-next';
import { z } from 'zod';
import { AvatarCache, DesktopAdapter, FreedesktopTransport } from './desktop.js';
import type { NotificationBus } from './desktop.js';
import type { Clock, Desktop, Intent } from './model.js';
import type { Store } from './store.js';
import { SessionBus } from './session-bus.js';

export const assetsDirectory = fileURLToPath(new URL('../../assets/', import.meta.url));

export async function openUrl(input: string): Promise<void> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid desktop destination');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('xdg-open', [url.href], { stdio: 'ignore', timeout: 10_000 });
    child.once('error', () => reject(new Error('Desktop URL opener unavailable')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Desktop URL opener failed')));
  });
}

export class LinuxDesktop implements Desktop {
  private connection: SessionBus | undefined;
  private adapter: DesktopAdapter | undefined;
  private connecting: Promise<void> | undefined;
  private readonly shutdown = new AbortController();
  private readonly avatars: AvatarCache;
  constructor(private readonly store: Store, private readonly user: string, directory: string,
    clock: Clock, private readonly options: { address: string; instance?: string }, private readonly report: (message: string) => void,
    private readonly open: (url: string) => Promise<void> = openUrl) {
    this.avatars = new AvatarCache(join(directory, 'avatars'), clock);
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const connection = await SessionBus.connect(this.options.address, signal);
    try {
      let owner = '';
      const bus: NotificationBus = { call: async (request, caller) => {
        if (request.member === 'GetCapabilities') {
          const answer = await connection.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', body: ['org.freedesktop.Notifications'] }, caller);
          const current = z.tuple([z.string()]).parse(answer.body)[0];
          if (owner !== current) { transport.reset(); owner = current; }
        }
        const body = [...request.body];
        if (request.member === 'Notify') {
          const hints = z.record(z.string(), z.object({ signature: z.string(), value: z.union([z.string(), z.boolean()]) })).parse(body[6]);
          const instance = this.options.instance ?? 'octopulse';
          hints['desktop-entry'] = { signature: 's', value: instance };
          if (instance !== 'octopulse') body[0] = `Octopulse (${instance})`;
          const sound = hints['sound-name'];
          if (sound && typeof sound.value === 'string' && /^octopulse-(approval|comment)$/.test(sound.value)) {
            hints['sound-file'] = { signature: 's', value: join(assetsDirectory, sound.value === 'octopulse-approval' ? 'approved.wav' : 'comment.wav') };
          }
          body[6] = Object.fromEntries(Object.entries(hints).map(([key, hint]) => [key, new Variant(hint.signature, hint.value)]));
          if (typeof body[2] === 'string' && /^git-(open|draft|closed|merged)$/.test(body[2])) body[2] = join(assetsDirectory, `${body[2]}.svg`);
        }
        const reply = await connection.call({ ...request, body }, caller);
        return reply.body;
      } };
      const transport = new FreedesktopTransport(bus, this.open);
      connection.bus.on('message', message => {
        if (message.type !== MessageType.SIGNAL || message.sender !== owner || message.path !== '/org/freedesktop/Notifications'
          || message.interface !== 'org.freedesktop.Notifications') return;
        if (message.member === 'ActionInvoked') {
          const result = z.tuple([z.number().int().positive(), z.string()]).safeParse(message.body);
          if (result.success) void transport.actionInvoked(...result.data).catch(() => this.report('Notification URL opening failed'));
        } else if (message.member === 'NotificationClosed') {
          const result = z.tuple([z.number().int().positive(), z.number().int()]).safeParse(message.body);
          if (result.success) transport.notificationClosed(result.data[0]);
        }
      });
      await connection.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
        member: 'AddMatch', signature: 's', body: ["type='signal',sender='org.freedesktop.Notifications',interface='org.freedesktop.Notifications',path='/org/freedesktop/Notifications'"] }, signal);
      signal.throwIfAborted();
      this.connection = connection;
      this.adapter = new DesktopAdapter(this.store, this.user, transport, this.avatars);
    } catch (error) { connection.close(); throw error; }
  }

  async submit(intent: Intent, signal: AbortSignal): Promise<'sent' | 'transient'> {
    const combined = AbortSignal.any([signal, this.shutdown.signal]);
    try {
      combined.throwIfAborted();
      if (!this.connection?.available) {
        this.connecting ??= this.connect(combined).finally(() => { this.connecting = undefined; });
        await this.connecting;
      }
      return await this.adapter!.submit(intent, combined);
    } catch { return 'transient'; }
  }

  async stop(): Promise<void> {
    this.shutdown.abort(); this.connection?.close();
    await this.connecting?.catch(() => {});
  }
}
