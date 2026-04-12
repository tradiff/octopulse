import { readFile } from "node:fs/promises";

import { SysTray, type ClickEvent, type Conf, type Menu } from "node-systray-v2";

import { APP_ICON_PNG_URL } from "./app-icon.js";
import { getLogger } from "./logger.js";
import { openUrl } from "./open-url.js";

const OPEN_APP_TITLE = "Open Octopulse";
const OPEN_LOGS_TITLE = "Open Logs";
const QUIT_TITLE = "Quit";
const TRAY_TOOLTIP = "Octopulse";

let trayIconBase64Promise: Promise<string> | undefined;

type TrayRuntime = {
  onReady(listener: () => void): void;
  onClick(listener: (action: ClickEvent) => void | Promise<void>): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
};

type CreateTray = (configuration: Conf) => TrayRuntime;

export interface TrayIconHandle {
  isVisible: boolean;
  stop(): Promise<void>;
}

export interface StartTrayIconOptions {
  serverOrigin: string;
  onQuitRequested: () => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  openUrl?: (url: string) => Promise<void>;
  createTray?: CreateTray;
}

export async function startTrayIcon(options: StartTrayIconOptions): Promise<TrayIconHandle> {
  const environment = options.environment ?? process.env;

  if (!hasGraphicalSession(environment)) {
    getLogger().info("Tray icon disabled", {
      reason: "no graphical session detected",
    });
    return createDisabledTrayIconHandle();
  }

  const createTray = options.createTray ?? createDefaultTray;
  const openUrlImpl = options.openUrl ?? openUrl;
  let isStopping = false;

  try {
    const tray = createTray({
      menu: createTrayMenu(await readTrayIconBase64()),
      debug: false,
      copyDir: false,
    });

    await waitForTrayReady(tray, {
      onRuntimeError: (error) => {
        getLogger().warn("Tray icon error", {
          message: getErrorMessage(error),
          error,
        });
      },
      onRuntimeExit: (code, signal) => {
        if (isStopping) {
          return;
        }

        getLogger().warn("Tray icon exited", {
          code,
          signal,
        });
      },
    });
    tray.onClick(async (action) => {
      try {
        await handleTrayAction(action, {
          serverOrigin: options.serverOrigin,
          openUrl: openUrlImpl,
          onQuitRequested: options.onQuitRequested,
        });
      } catch (error) {
        getLogger().warn("Tray action failed", {
          action: action.item.title,
          message: getErrorMessage(error),
          error,
        });
      }
    });

    getLogger().info("Tray icon started", {
      serverOrigin: options.serverOrigin,
    });

    return {
      isVisible: true,
      async stop(): Promise<void> {
        if (isStopping) {
          return;
        }

        isStopping = true;
        tray.kill();
      },
    };
  } catch (error) {
    getLogger().warn("Tray icon unavailable", {
      message: getErrorMessage(error),
      error,
    });
    return createDisabledTrayIconHandle();
  }
}

function hasGraphicalSession(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

function createTrayMenu(icon: string): Menu {
  return {
    icon,
    title: "",
    tooltip: TRAY_TOOLTIP,
    items: [
      {
        title: OPEN_APP_TITLE,
        tooltip: "Open Octopulse UI",
        checked: false,
        enabled: true,
      },
      {
        title: OPEN_LOGS_TITLE,
        tooltip: "Open Octopulse logs",
        checked: false,
        enabled: true,
      },
      {
        title: QUIT_TITLE,
        tooltip: "Quit Octopulse",
        checked: false,
        enabled: true,
      },
    ],
  };
}

async function handleTrayAction(
  action: ClickEvent,
  options: {
    serverOrigin: string;
    openUrl: (url: string) => Promise<void>;
    onQuitRequested: () => Promise<void>;
  },
): Promise<void> {
  switch (action.item.title) {
    case OPEN_APP_TITLE:
      await options.openUrl(options.serverOrigin);
      return;
    case OPEN_LOGS_TITLE:
      await options.openUrl(`${options.serverOrigin}/logs`);
      return;
    case QUIT_TITLE:
      await options.onQuitRequested();
      return;
    default:
      return;
  }
}

function createDefaultTray(configuration: Conf): TrayRuntime {
  return new SysTray(configuration);
}

async function readTrayIconBase64(): Promise<string> {
  if (!trayIconBase64Promise) {
    trayIconBase64Promise = readFile(APP_ICON_PNG_URL)
      .then((buffer) => buffer.toString("base64"))
      .catch((error) => {
        trayIconBase64Promise = undefined;
        throw error;
      });
  }

  return trayIconBase64Promise;
}

async function waitForTrayReady(
  tray: TrayRuntime,
  options: {
    onRuntimeError: (error: Error) => void;
    onRuntimeExit: (code: number | null, signal: string | null) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let isReady = false;
    let isSettled = false;

    const resolveReady = (): void => {
      if (isSettled) {
        return;
      }

      isReady = true;
      isSettled = true;
      resolve();
    };

    const rejectStartup = (error: Error): void => {
      if (isSettled) {
        options.onRuntimeError(error);
        return;
      }

      isSettled = true;
      reject(error);
    };

    tray.onReady(() => {
      resolveReady();
    });
    tray.onError((error) => {
      if (isReady) {
        options.onRuntimeError(error);
        return;
      }

      rejectStartup(error);
    });
    tray.onExit((code, signal) => {
      if (isReady) {
        options.onRuntimeExit(code, signal);
        return;
      }

      rejectStartup(new Error(renderTrayStartupExitMessage(code, signal)));
    });
  });
}

function renderTrayStartupExitMessage(code: number | null, signal: string | null): string {
  const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;

  return `Tray process exited before ready with ${reason}`;
}

function createDisabledTrayIconHandle(): TrayIconHandle {
  return {
    isVisible: false,
    async stop(): Promise<void> {
      return undefined;
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
