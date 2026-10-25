import { interface as dbusInterface, DBusError, Variant, MessageType } from '@jellybrick/dbus-next';
import { join } from 'node:path';
import { z } from 'zod';
import { SessionBus } from './session-bus.js';
import { assetsDirectory, openUrl } from './linux-desktop.js';

const { Interface, property, method, signal } = dbusInterface;
const menuPath = '/MenuBar';
const itemPath = '/StatusNotifierItem';
const watcher = 'org.kde.StatusNotifierWatcher';
const labels = ['Open Octopulse', 'Open Logs', 'Quit'];

class Menu extends Interface {
  @property({ signature: 'u', access: 'read' }) Version = 3;
  @property({ signature: 's', access: 'read' }) Status = 'normal';
  @property({ signature: 's', access: 'read' }) TextDirection = 'ltr';
  @property({ signature: 'as', access: 'read' }) IconThemePath = [assetsDirectory];
  constructor(private readonly activate: (id: number) => void) { super('com.canonical.dbusmenu'); }
  private properties(id: number, names: string[]) {
    if (id < 0 || id > labels.length) throw new DBusError('com.canonical.dbusmenu.Error', 'Unknown menu item');
    const values: Record<string, Variant> = id === 0 ? { 'children-display': new Variant('s', 'submenu') }
      : { label: new Variant('s', labels[id - 1]!), enabled: new Variant('b', true), visible: new Variant('b', true) };
    return Object.fromEntries(Object.entries(values).filter(([key]) => !names.length || names.includes(key)));
  }
  @method({ inSignature: 'iias', outSignature: 'u(ia{sv}av)' })
  GetLayout(parent: number, depth: number, names: string[]) {
    return [1, [parent, this.properties(parent, names), parent === 0 && depth !== 0
      ? labels.map((_, index) => new Variant('(ia{sv}av)', [index + 1, this.properties(index + 1, names), []])) : []]];
  }
  @method({ inSignature: 'aias', outSignature: 'a(ia{sv})' })
  GetGroupProperties(ids: number[], names: string[]) { return (ids.length ? ids : [0, ...labels.map((_, index) => index + 1)]).map(id => [id, this.properties(id, names)]); }
  @method({ inSignature: 'is', outSignature: 'v' })
  GetProperty(id: number, name: string) {
    const value = this.properties(id, [name])[name];
    if (!value) throw new DBusError('com.canonical.dbusmenu.Error', 'Unknown menu property');
    return value;
  }
  @method({ inSignature: 'isvu' })
  Event(id: number, event: string, _data: Variant, _timestamp: number): void {
    this.properties(id, []);
    if (event === 'clicked' && id > 0) this.activate(id);
  }
  @method({ inSignature: 'a(isvu)', outSignature: 'ai' })
  EventGroup(events: [number, string, Variant, number][]): number[] {
    const errors: number[] = [];
    for (const event of events) { try { this.Event(...event); } catch { errors.push(event[0]); } }
    return errors;
  }
  @method({ inSignature: 'i', outSignature: 'b' }) AboutToShow(id: number): boolean { this.properties(id, []); return false; }
  @method({ inSignature: 'ai', outSignature: 'aiai' }) AboutToShowGroup(ids: number[]) { return [[], ids.filter(id => id < 0 || id > labels.length)]; }
  @signal({ signature: 'ui' }) LayoutUpdated(revision: number, parent: number) { return [revision, parent]; }
  @signal({ signature: 'a(ia{sv})a(ias)' }) ItemsPropertiesUpdated(updated: unknown[], removed: unknown[]) { return [updated, removed]; }
  @signal({ signature: 'iu' }) ItemActivationRequested(id: number, timestamp: number) { return [id, timestamp]; }
}

class Item extends Interface {
  @property({ signature: 's', access: 'read' }) Category = 'ApplicationStatus';
  @property({ signature: 's', access: 'read' }) Id = 'octopulse';
  @property({ signature: 's', access: 'read' }) Title = 'Octopulse';
  @property({ signature: 's', access: 'read' }) Status = 'Active';
  @property({ signature: 'i', access: 'read' }) WindowId = 0;
  @property({ signature: 's', access: 'read' }) IconThemePath = assetsDirectory;
  @property({ signature: 's', access: 'read' }) IconName = join(assetsDirectory, 'octopulse-mark-small-white.svg');
  @property({ signature: 'a(iiay)', access: 'read' }) IconPixmap = [];
  @property({ signature: 's', access: 'read' }) OverlayIconName = '';
  @property({ signature: 'a(iiay)', access: 'read' }) OverlayIconPixmap = [];
  @property({ signature: 's', access: 'read' }) AttentionIconName = '';
  @property({ signature: 'a(iiay)', access: 'read' }) AttentionIconPixmap = [];
  @property({ signature: 's', access: 'read' }) AttentionMovieName = '';
  @property({ signature: 'b', access: 'read' }) ItemIsMenu = false;
  @property({ signature: 'o', access: 'read' }) Menu = menuPath;
  @property({ signature: '(sa(iiay)ss)', access: 'read' }) ToolTip = [this.IconName, [], 'Octopulse', 'GitHub pull request monitor'];
  constructor(private readonly menu: Menu, private readonly activate: (id: number) => void, instance: string) {
    super('org.kde.StatusNotifierItem');
    this.Id = instance;
    this.Title = instance === 'octopulse' ? 'Octopulse' : `Octopulse (${instance})`;
    this.ToolTip = [this.IconName, [], this.Title, 'GitHub pull request monitor'];
  }
  @method({ inSignature: 'ii' }) Activate(_x: number, _y: number): void { this.activate(1); }
  @method({ inSignature: 'ii' }) SecondaryActivate(_x: number, _y: number): void { this.activate(2); }
  @method({ inSignature: 'ii' }) ContextMenu(_x: number, _y: number): void { this.menu.ItemActivationRequested(0, 0); }
  @method({ inSignature: 'is' }) Scroll(_delta: number, _orientation: string): void {}
  @method({ inSignature: 's' }) ProvideXdgActivationToken(_token: string): void {}
}

export async function startTray(origin: string, quit: () => void, report: (message: string) => void,
  options: { environment?: NodeJS.ProcessEnv; open?: (url: string) => Promise<void>; instance?: string } = {}) {
  const { environment = process.env, open = openUrl, instance = 'octopulse' } = options;
  if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
    report('Tray unavailable: no graphical display'); return { stop() {} };
  }
  const shutdown = new AbortController();
  let connection: SessionBus | undefined;
  try {
    connection = await SessionBus.connect(environment.DBUS_SESSION_BUS_ADDRESS ?? '', shutdown.signal);
    const session = connection;
    const activate = (id: number) => {
      if (shutdown.signal.aborted) return;
      if (id === 3) setImmediate(quit);
      else void open(new URL(id === 2 ? '/logs' : '/', origin).href).catch(() => report('Tray URL opening failed'));
    };
    const menu = new Menu(activate);
    session.bus.export(menuPath, menu); session.bus.export(itemPath, new Item(menu, activate, instance));
    let registering: Promise<void> | undefined;
    const register = () => {
      registering ??= session.call({ destination: watcher, path: '/StatusNotifierWatcher', interface: watcher,
        member: 'RegisterStatusNotifierItem', signature: 's', body: [itemPath] }, shutdown.signal)
        .then(async () => {
          const reply = await session.call({ destination: watcher, path: '/StatusNotifierWatcher', interface: 'org.freedesktop.DBus.Properties',
            member: 'Get', signature: 'ss', body: [watcher, 'IsStatusNotifierHostRegistered'] }, shutdown.signal);
          const host = z.tuple([z.instanceof(Variant)]).parse(reply.body)[0];
          if (host.signature !== 'b' || typeof host.value !== 'boolean') throw new Error('Invalid tray host availability');
          report(host.value ? 'Tray registered' : 'Tray unavailable: no registered host');
        }).catch(() => { if (!shutdown.signal.aborted) report('Tray unavailable: registration failed'); })
        .finally(() => { registering = undefined; });
      return registering;
    };
    session.bus.on('message', message => {
      if (message.type !== MessageType.SIGNAL || message.sender !== 'org.freedesktop.DBus' || message.interface !== 'org.freedesktop.DBus'
        || message.member !== 'NameOwnerChanged') return;
      const change = z.tuple([z.string(), z.string(), z.string()]).safeParse(message.body);
      if (change.success && change.data[0] === watcher && change.data[2] && !shutdown.signal.aborted) void register();
    });
    await session.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch',
      signature: 's', body: [`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${watcher}'`] }, shutdown.signal);
    await register();
    return { stop() { shutdown.abort(); session.close(); } };
  } catch { connection?.close(); report('Tray unavailable: session bus connection failed'); return { stop() { shutdown.abort(); } }; }
}
