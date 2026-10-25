import { sessionBus, Message, MessageType } from '@jellybrick/dbus-next';
import type { MessageBus, MessageLike } from '@jellybrick/dbus-next';

export class SessionBus {
  private readonly pending = new Map<number, { finish(error?: Error, reply?: Message): void }>();
  private closed = false;
  private constructor(readonly bus: MessageBus) {
    bus.on('message', message => {
      if (message.replySerial !== undefined && [MessageType.METHOD_RETURN, MessageType.ERROR].includes(message.type)) {
        this.pending.get(message.replySerial)?.finish(message.type === MessageType.ERROR ? new Error('D-Bus method failed') : undefined, message);
      }
    });
    bus.on('error', () => this.close());
  }

  static async connect(address: string, signal: AbortSignal): Promise<SessionBus> {
    if (!address) throw new Error('Session bus address is unavailable');
    signal.throwIfAborted();
    const connection = new SessionBus(sessionBus({ busAddress: address }));
    try {
      await connection.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus', member: 'GetId' }, signal);
      return connection;
    } catch (error) { connection.close(); throw error; }
  }

  get available(): boolean { return !this.closed; }

  call(request: MessageLike, signal: AbortSignal): Promise<Message> {
    if (this.closed) return Promise.reject(new Error('Session bus is closed'));
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const message = new Message({ ...request, serial: this.bus.newSerial() });
      const serial = message.serial!;
      const finish = (error?: Error, reply?: Message) => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted); this.pending.delete(serial);
        if (error) reject(error); else if (reply) resolve(reply); else reject(new Error('Missing D-Bus reply'));
      };
      const aborted = () => finish(new Error('D-Bus call canceled'));
      const timer = setTimeout(() => { finish(new Error('D-Bus call timed out')); this.close(); }, 5000);
      this.pending.set(serial, { finish }); signal.addEventListener('abort', aborted, { once: true });
      try { this.bus.send(message); } catch { finish(new Error('D-Bus send failed')); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of [...this.pending.values()]) call.finish(new Error('Session bus closed'));
    this.bus.disconnect();
  }
}
