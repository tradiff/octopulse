import { EventEmitter } from "node:events";

import { sessionBus, Variant, type MessageBus } from "dbus-native";

const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/Menu";
const ITEM_INTERFACE = "org.kde.StatusNotifierItem";
const MENU_INTERFACE = "com.canonical.dbusmenu";
const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";

export interface TrayMenuItem {
  title: string;
  enabled: boolean;
}

export interface TrayMenu {
  icon: string;
  tooltip: string;
  items: TrayMenuItem[];
}

export interface TrayConfiguration {
  menu: TrayMenu;
}

export interface TrayClickEvent {
  item: TrayMenuItem;
}

export interface TrayRuntime {
  onReady(listener: () => void): void;
  onClick(listener: (action: TrayClickEvent) => void | Promise<void>): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: () => void): void;
  kill(): Promise<void>;
}

export function createLinuxTray(
  configuration: TrayConfiguration,
  createBus: () => MessageBus = () => sessionBus({ timeout: 5_000 }),
): TrayRuntime {
  const bus = createBus();
  const events = new EventEmitter();
  const { menu } = configuration;
  const name = `org.kde.StatusNotifierItem-Octopulse-${process.pid}`;

  bus.exportInterface(
    {
      Id: "Octopulse",
      Category: "ApplicationStatus",
      Status: "Active",
      Title: menu.tooltip,
      IconName: menu.icon,
      // Plasma reads ToolTip.title for the hover popup; Title alone names the tray entry.
      ToolTip: [menu.icon, [], menu.tooltip, ""],
      Menu: MENU_PATH,
      ItemIsMenu: true,
      ContextMenu() {},
      Activate() {},
      SecondaryActivate() {},
      Scroll() {},
    },
    ITEM_PATH,
    {
      name: ITEM_INTERFACE,
      properties: {
        Id: { type: "s", access: "read" },
        Category: { type: "s", access: "read" },
        Status: { type: "s", access: "read" },
        Title: { type: "s", access: "read" },
        IconName: { type: "s", access: "read" },
        ToolTip: { type: "(sa(iiay)ss)", access: "read" },
        Menu: { type: "o", access: "read" },
        ItemIsMenu: { type: "b", access: "read" },
      },
      methods: {
        ContextMenu: ["ii", "", ["x", "y"], []],
        Activate: ["ii", "", ["x", "y"], []],
        SecondaryActivate: ["ii", "", ["x", "y"], []],
        Scroll: ["is", "", ["delta", "orientation"], []],
      },
    },
  );

  const itemProperties = (id: number): Record<string, Variant> => {
    const item = menu.items[id - 1];
    return item === undefined
      ? { "children-display": new Variant("s", "submenu") }
      : { label: new Variant("s", item.title), enabled: new Variant("b", item.enabled) };
  };

  const activate = (id: number, eventId: string): void => {
    const item = menu.items[id - 1];
    if (eventId === "clicked" && item !== undefined && item.enabled) {
      events.emit("click", { item });
    }
  };

  bus.exportInterface(
    {
      Version: 3,
      TextDirection: "ltr",
      Status: "normal",
      IconThemePath: [],
      GetLayout(parentId: number, recursionDepth: number) {
        return [
          1,
          [
            parentId,
            itemProperties(parentId),
            parentId === 0 && recursionDepth !== 0
              ? menu.items.map((_, index) =>
                  new Variant("(ia{sv}av)", [index + 1, itemProperties(index + 1), []]),
                )
              : [],
          ],
        ];
      },
      GetGroupProperties(ids: number[]) {
        return ids
          .filter((id) => id >= 0 && id <= menu.items.length)
          .map((id) => [id, itemProperties(id)]);
      },
      GetProperty(id: number, property: string) {
        return itemProperties(id)[property];
      },
      Event(id: number, eventId: string) {
        activate(id, eventId);
      },
      EventGroup(group: Array<[number, string]>) {
        for (const [id, eventId] of group) {
          activate(id, eventId);
        }
        return [];
      },
      AboutToShow() {
        return false;
      },
      AboutToShowGroup() {
        return [[], []];
      },
    },
    MENU_PATH,
    {
      name: MENU_INTERFACE,
      properties: {
        Version: { type: "u", access: "read" },
        TextDirection: { type: "s", access: "read" },
        Status: { type: "s", access: "read" },
        IconThemePath: { type: "as", access: "read" },
      },
      methods: {
        GetLayout: ["iias", "u(ia{sv}av)", ["parentId", "recursionDepth", "propertyNames"], ["revision", "layout"]],
        GetGroupProperties: ["aias", "a(ia{sv})", ["ids", "propertyNames"], ["properties"]],
        GetProperty: ["is", "v", ["id", "name"], ["value"]],
        Event: ["isvu", "", ["id", "eventId", "data", "timestamp"], []],
        EventGroup: ["a(isvu)", "ai", ["events"], ["idErrors"]],
        AboutToShow: ["i", "b", ["id"], ["needUpdate"]],
        AboutToShowGroup: ["ai", "aiai", ["ids"], ["updatesNeeded", "idErrors"]],
      },
    },
  );

  bus.connection.on("error", (error: Error) => events.emit("runtime-error", error));
  bus.connection.on("end", () => events.emit("exit"));

  void (async () => {
    try {
      if (await bus.requestName(name, 0) !== 1) {
        throw new Error(`Tray D-Bus name unavailable: ${name}`);
      }
      await bus.invokeDbus({
        destination: WATCHER_NAME,
        path: WATCHER_PATH,
        interface: WATCHER_NAME,
        member: "RegisterStatusNotifierItem",
        signature: "s",
        body: [name],
      });
      events.emit("ready");
    } catch (error) {
      events.emit("runtime-error", error instanceof Error ? error : new Error(String(error)));
      await bus.close().catch(() => undefined);
    }
  })();

  return {
    onReady(listener) {
      events.on("ready", listener);
    },
    onClick(listener) {
      events.on("click", listener);
    },
    onError(listener) {
      events.on("runtime-error", listener);
    },
    onExit(listener) {
      events.on("exit", listener);
    },
    async kill() {
      await bus.close();
    },
  };
}
