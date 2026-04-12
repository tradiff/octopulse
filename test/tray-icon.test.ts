import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAppLoggerForTesting } from "../src/logger.js";
import { startTrayIcon } from "../src/tray-icon.js";

describe("startTrayIcon", () => {
  beforeEach(() => {
    resetAppLoggerForTesting();
  });

  it("skips tray startup without graphical session", async () => {
    const createTray = vi.fn();

    const trayIcon = await startTrayIcon({
      serverOrigin: "http://127.0.0.1:3000",
      onQuitRequested: vi.fn().mockResolvedValue(undefined),
      environment: {},
      createTray,
    });

    expect(trayIcon.isVisible).toBe(false);
    expect(createTray).not.toHaveBeenCalled();
    await expect(trayIcon.stop()).resolves.toBeUndefined();
  });

  it("routes tray menu actions to URLs and quit handler", async () => {
    let clickListener:
      | ((action: { item: { title: string } }) => void | Promise<void>)
      | undefined;
    const onReady = vi.fn((listener: () => void) => {
      listener();
    });
    const trayRuntime = {
      onReady,
      onClick: vi.fn((listener: (action: { item: { title: string } }) => void | Promise<void>) => {
        clickListener = listener;
      }),
      onError: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
    };
    const createTray = vi.fn().mockReturnValue(trayRuntime);
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const onQuitRequested = vi.fn().mockResolvedValue(undefined);

    const trayIcon = await startTrayIcon({
      serverOrigin: "http://127.0.0.1:3000",
      onQuitRequested,
      environment: {
        DISPLAY: ":1",
      },
      createTray,
      openUrl,
    });

    expect(trayIcon.isVisible).toBe(true);
    expect(createTray).toHaveBeenCalledWith({
      menu: {
        icon: expect.any(String),
        title: "",
        tooltip: "Octopulse",
        items: [
          {
            title: "Open Octopulse",
            tooltip: "Open Octopulse UI",
            checked: false,
            enabled: true,
          },
          {
            title: "Open Logs",
            tooltip: "Open Octopulse logs",
            checked: false,
            enabled: true,
          },
          {
            title: "Quit",
            tooltip: "Quit Octopulse",
            checked: false,
            enabled: true,
          },
        ],
      },
      debug: false,
      copyDir: false,
    });
    expect(clickListener).toBeTypeOf("function");

    await clickListener?.({ item: { title: "Open Octopulse" } });
    await clickListener?.({ item: { title: "Open Logs" } });
    await clickListener?.({ item: { title: "Quit" } });

    expect(openUrl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:3000");
    expect(openUrl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3000/logs");
    expect(onQuitRequested).toHaveBeenCalledTimes(1);

    await trayIcon.stop();

    expect(trayRuntime.kill).toHaveBeenCalledTimes(1);
  });
});
