import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { interface as dbusInterface, Variant } from '@jellybrick/dbus-next';
import { SessionBus } from '../src/session-bus.js';
import { LinuxDesktop } from '../src/linux-desktop.js';
import { startTray } from '../src/tray.js';
import { Profile } from '../src/profile.js';
import { Intent } from '../src/model.js';
import { temporaryProfile, VirtualClock } from './fixture.js';

const { Interface } = dbusInterface;
const signal = new AbortController().signal;
const address = process.env.DBUS_SESSION_BUS_ADDRESS!;
const service = await SessionBus.connect(address, signal);
const client = await SessionBus.connect(address, signal);
const directory = await temporaryProfile();
const profile = new Profile(directory);
const opened: string[] = [];
const logs: string[] = [];
let quit = 0;
let registered = '';
class Watcher extends Interface {
  @dbusInterface.property({ signature: 'b', access: 'read' }) IsStatusNotifierHostRegistered = true;
  constructor() { super('org.kde.StatusNotifierWatcher'); }
  @dbusInterface.method({ inSignature: 's' })
  RegisterStatusNotifierItem(path: string): void { registered = path; }
}
class Notifications extends Interface {
  messages: unknown[][] = [];
  capabilities = ['body', 'body-markup', 'actions', 'sound'];
  constructor() { super('org.freedesktop.Notifications'); }
  @dbusInterface.method({ outSignature: 'as' }) GetCapabilities() { return this.capabilities; }
  @dbusInterface.method({ inSignature: 'susssasa{sv}i', outSignature: 'u' }) Notify(...args: unknown[]) { this.messages.push(args); return this.messages.length; }
  @dbusInterface.signal({ signature: 'us' }) ActionInvoked(id: number, action: string) { return [id, action]; }
  @dbusInterface.signal({ signature: 'uu' }) NotificationClosed(id: number, reason: number) { return [id, reason]; }
}
const notifications = new Notifications();
const watcherService = new Watcher();
const desktop = new LinuxDesktop(profile.store, 'alex', directory, new VirtualClock('2026-10-22T12:00:00Z'), { address }, message => logs.push(message),
  async url => { opened.push(url); });
let tray: Awaited<ReturnType<typeof startTray>> | undefined;
const call = async (destination: string, path: string, iface: string, member: string, signature = '', body: unknown[] = []) =>
  (await client.call({ destination, path, interface: iface, member, signature, body }, signal)).body;
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected D-Bus event was not received');
};
try {
  service.bus.export('/StatusNotifierWatcher', watcherService);
  service.bus.export('/org/freedesktop/Notifications', notifications);
  await service.bus.requestName('org.kde.StatusNotifierWatcher', 4);
  await service.bus.requestName('org.freedesktop.Notifications', 4);
  let traySender = '';
  service.bus.on('message', message => { if (message.member === 'RegisterStatusNotifierItem') traySender = message.sender; });
  tray = await startTray('http://127.0.0.1:41234', () => { quit++; }, message => logs.push(message),
    { environment: { DISPLAY: ':synthetic', DBUS_SESSION_BUS_ADDRESS: address }, open: async url => { opened.push(url); } });
  assert.equal(registered, '/StatusNotifierItem'); assert.ok(logs.includes('Tray registered'));
  const properties = (await call(traySender, registered, 'org.freedesktop.DBus.Properties', 'GetAll', 's', ['org.kde.StatusNotifierItem']))[0] as Record<string, Variant>;
  assert.equal(properties.Id!.value, 'octopulse'); assert.equal(properties.Title!.value, 'Octopulse'); assert.equal(properties.Menu!.value, '/MenuBar');
  assert.match(String(properties.IconName!.value), /\/octopulse-mark-small-white\.svg$/);
  assert.equal((properties.ToolTip!.value as unknown[])[0], properties.IconName!.value);
  const layout = await call(traySender, '/MenuBar', 'com.canonical.dbusmenu', 'GetLayout', 'iias', [0, -1, []]);
  const root = layout[1] as [number, unknown, Variant<[number, Record<string, Variant>, unknown[]]>[]];
  assert.deepEqual(root[2].map(child => child.value[1].label!.value), ['Open Octopulse', 'Open Logs', 'Quit']);
  const shallow = await call(traySender, '/MenuBar', 'com.canonical.dbusmenu', 'GetLayout', 'iias', [0, 0, []]);
  assert.deepEqual((shallow[1] as unknown[])[2], []);
  await call(traySender, '/MenuBar', 'com.canonical.dbusmenu', 'Event', 'isvu', [1, 'clicked', new Variant('s', ''), 0]);
  await call(traySender, '/MenuBar', 'com.canonical.dbusmenu', 'Event', 'isvu', [2, 'clicked', new Variant('s', ''), 0]);
  assert.deepEqual(opened, ['http://127.0.0.1:41234/', 'http://127.0.0.1:41234/logs']);
  await assert.rejects(call(traySender, '/MenuBar', 'com.canonical.dbusmenu', 'GetProperty', 'is', [99, 'label']));
  await call(traySender, '/MenuBar', 'com.canonical.dbusmenu', 'Event', 'isvu', [3, 'clicked', new Variant('s', ''), 0]);
  await wait(() => quit === 1);
  const intent = Intent.parse({ prId: 'synthetic', kind: 'immediate', events: [], title: 'Synthetic approval', body: '<b>Inert content</b>',
    destination: 'https://github.com/acme/widget/pull/7', expiryMs: 0, sound: 'approval' });
  assert.equal(await desktop.submit(intent, signal), 'sent');
  const args = notifications.messages[0]!;
  assert.equal(args[0], 'Octopulse'); assert.equal(args[7], 0); assert.match(String(args[2]), /git-open\.svg$/);
  assert.equal(args[4], '&lt;b&gt;Inert content&lt;/b&gt;'); assert.deepEqual(args[5], ['default', 'Open pull request']);
  const hints = args[6] as Record<string, Variant>;
  assert.equal(hints['desktop-entry']!.value, 'octopulse'); assert.match(String(hints['sound-file']!.value), /\/approved\.wav$/);
  notifications.ActionInvoked(1, 'default'); await wait(() => opened.length === 3);
  assert.equal(opened[2], intent.destination);
  notifications.NotificationClosed(1, 2); notifications.ActionInvoked(1, 'default');
  const plain = { ...intent, expiryMs: 10000 as const, sound: null };
  notifications.capabilities = [];
  assert.equal(await desktop.submit(plain, signal), 'sent');
  assert.equal(opened.length, 3); assert.equal(notifications.messages[1]![4], plain.body); assert.deepEqual(notifications.messages[1]![5], []);
  assert.equal(notifications.messages[1]![7], 10000);
  const originalSender = traySender;
  const secondTray = await startTray('http://127.0.0.1:3001', () => {}, message => logs.push(message), {
    environment: { DISPLAY: ':synthetic', DBUS_SESSION_BUS_ADDRESS: address }, instance: 'octopulse-test', open: async url => { opened.push(url); },
  });
  const secondDesktop = new LinuxDesktop(profile.store, 'alex', directory, new VirtualClock('2026-10-22T12:00:00Z'),
    { address, instance: 'octopulse-test' }, message => logs.push(message), async url => { opened.push(url); });
  try {
    assert.notEqual(traySender, originalSender);
    const secondProperties = (await call(traySender, registered, 'org.freedesktop.DBus.Properties', 'GetAll', 's', ['org.kde.StatusNotifierItem']))[0] as Record<string, Variant>;
    assert.equal(secondProperties.Id!.value, 'octopulse-test'); assert.equal(secondProperties.Title!.value, 'Octopulse (octopulse-test)');
    assert.equal(secondProperties.IconName!.value, properties.IconName!.value);
    const firstProperties = (await call(originalSender, registered, 'org.freedesktop.DBus.Properties', 'GetAll', 's', ['org.kde.StatusNotifierItem']))[0] as Record<string, Variant>;
    assert.equal(firstProperties.Id!.value, 'octopulse');
    await call(traySender, registered, 'org.kde.StatusNotifierItem', 'Activate', 'ii', [0, 0]);
    assert.equal(opened.at(-1), 'http://127.0.0.1:3001/');
    assert.equal(await secondDesktop.submit(plain, signal), 'sent');
    const secondArgs = notifications.messages.at(-1)!;
    assert.equal(secondArgs[0], 'Octopulse (octopulse-test)');
    assert.equal((secondArgs[6] as Record<string, Variant>)['desktop-entry']!.value, 'octopulse-test');
    notifications.capabilities = ['sound'];
    assert.equal(await secondDesktop.submit({ ...plain, sound: 'comment' }, signal), 'sent');
    const commentHints = notifications.messages.at(-1)![6] as Record<string, Variant>;
    assert.match(String(commentHints['sound-file']!.value), /\/comment\.wav$/);
  } finally { secondTray.stop(); await secondDesktop.stop(); }
  tray.stop(); tray.stop();
  watcherService.IsStatusNotifierHostRegistered = false;
  const noHost = await startTray('http://127.0.0.1:41234', () => {}, message => logs.push(message), { environment: { DISPLAY: ':synthetic', DBUS_SESSION_BUS_ADDRESS: address } });
  assert.ok(logs.includes('Tray unavailable: no registered host')); noHost.stop(); watcherService.IsStatusNotifierHostRegistered = true;
  await service.bus.releaseName('org.kde.StatusNotifierWatcher');
  const failed = await startTray('http://127.0.0.1:41234', () => {}, message => logs.push(message), { environment: { DISPLAY: ':synthetic', DBUS_SESSION_BUS_ADDRESS: address } });
  assert.ok(logs.includes('Tray unavailable: registration failed'));
  registered = ''; await service.bus.requestName('org.kde.StatusNotifierWatcher', 4); await wait(() => registered !== ''); failed.stop();
  const absent = await startTray('http://127.0.0.1:41234', () => {}, message => logs.push(message), { environment: {} }); absent.stop();
  assert.ok(logs.includes('Tray unavailable: no graphical display'));
  await service.bus.releaseName('org.freedesktop.Notifications');
  assert.equal(await desktop.submit(plain, signal), 'transient');
  await service.bus.requestName('org.freedesktop.Notifications', 4);
  assert.equal(await desktop.submit(plain, signal), 'sent');
  const canceled = new AbortController(); canceled.abort();
  assert.equal(await desktop.submit(plain, canceled.signal), 'transient');
  console.log('Private D-Bus notification, menu, degradation, recovery, and action checks passed');
} finally {
  tray?.stop(); await desktop.stop(); client.close(); service.close(); profile.close(); await rm(directory, { recursive: true, force: true });
}
