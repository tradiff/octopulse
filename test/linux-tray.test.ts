import { EventEmitter } from "node:events";

import { Variant, type MessageBus } from "dbus-native";
import { describe, expect, it, vi } from "vitest";

import { createLinuxTray } from "../src/linux-tray.js";

describe("createLinuxTray", () => {
  it("publishes a StatusNotifierItem tooltip and routes menu clicks", async () => {
    const bus = {
      connection: new EventEmitter(),
      exportInterface: vi.fn(),
      requestName: vi.fn().mockResolvedValue(1),
      invokeDbus: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const menu = {
      icon: "/tmp/octopulse.png",
      tooltip: "Octopulse",
      items: [{ title: "Quit", enabled: true }],
    };
    const tray = createLinuxTray({ menu }, () => bus as unknown as MessageBus);
    const ready = new Promise<void>((resolve) => tray.onReady(resolve));
    await ready;

    const item = bus.exportInterface.mock.calls[0]?.[0] as { ToolTip: unknown; Title: string };
    expect(item.Title).toBe("Octopulse");
    expect(item.ToolTip).toEqual(["/tmp/octopulse.png", [], "Octopulse", ""]);
    expect(bus.exportInterface.mock.calls[0]?.[2]).toMatchObject({
      properties: { ToolTip: { type: "(sa(iiay)ss)", access: "read" } },
    });
    expect(bus.invokeDbus).toHaveBeenCalledWith(expect.objectContaining({
      member: "RegisterStatusNotifierItem",
      body: [expect.stringContaining("Octopulse")],
    }));

    const menuService = bus.exportInterface.mock.calls[1]?.[0] as {
      GetLayout(parentId: number, recursionDepth: number): [number, [number, Record<string, Variant>, Variant[]]];
      Event(id: number, eventId: string): void;
    };
    const [, [, , children]] = menuService.GetLayout(0, -1);
    expect(children[0]).toMatchObject({
      signature: "(ia{sv}av)",
      value: [1, { label: new Variant("s", "Quit"), enabled: new Variant("b", true) }, []],
    });
    expect(menuService.GetLayout(1, 0)[1][2]).toEqual([]);

    const clicked = vi.fn();
    tray.onClick(clicked);
    menuService.Event(1, "clicked");
    expect(clicked).toHaveBeenCalledWith({ item: menu.items[0] });

    await tray.kill();
    expect(bus.close).toHaveBeenCalledOnce();
  });

  it("reports registration failure and closes the bus", async () => {
    const error = new Error("status notifier watcher unavailable");
    const bus = {
      connection: new EventEmitter(),
      exportInterface: vi.fn(),
      requestName: vi.fn().mockRejectedValue(error),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const tray = createLinuxTray({
      menu: { icon: "/tmp/octopulse.png", tooltip: "Octopulse", items: [] },
    }, () => bus as unknown as MessageBus);

    await expect(new Promise<Error>((resolve) => tray.onError(resolve))).resolves.toBe(error);
    expect(bus.close).toHaveBeenCalledOnce();
  });
});
