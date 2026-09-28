import { fileURLToPath } from "node:url";

import { APP_ICON_PNG_URL } from "./app-icon.js";
import {
  createLinuxTray,
  type TrayClickEvent,
  type TrayConfiguration,
  type TrayMenu,
  type TrayRuntime,
} from "./linux-tray.js";
import { getLogger } from "./logger.js";
import { openUrl } from "./open-url.js";

const OPEN_APP_TITLE = "Open Octopulse";
const OPEN_LOGS_TITLE = "Open Logs";
const QUIT_TITLE = "Quit";
const TRAY_TOOLTIP = "Octopulse";

type CreateTray = (configuration: TrayConfiguration) => TrayRuntime;

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

  const createTray = options.createTray ?? createLinuxTray;
  const openUrlImpl = options.openUrl ?? openUrl;
  let isStopping = false;

  try {
    const tray = createTray({
      menu: createTrayMenu(fileURLToPath(APP_ICON_PNG_URL)),
    });

    await waitForTrayReady(tray, {
      onRuntimeError: (error) => {
        getLogger().warn("Tray icon error", {
          message: getErrorMessage(error),
          error,
        });
      },
      onRuntimeExit: () => {
        if (isStopping) {
          return;
        }

        getLogger().warn("Tray icon disconnected");
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
        await tray.kill();
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

function createTrayMenu(icon: string): TrayMenu {
  return {
    icon,
    tooltip: TRAY_TOOLTIP,
    items: [
      {
        title: OPEN_APP_TITLE,
        enabled: true,
      },
      {
        title: OPEN_LOGS_TITLE,
        enabled: true,
      },
      {
        title: QUIT_TITLE,
        enabled: true,
      },
    ],
  };
}

async function handleTrayAction(
  action: TrayClickEvent,
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

async function waitForTrayReady(
  tray: TrayRuntime,
  options: {
    onRuntimeError: (error: Error) => void;
    onRuntimeExit: () => void;
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
    tray.onExit(() => {
      if (isReady) {
        options.onRuntimeExit();
        return;
      }

      rejectStartup(new Error("Tray connection closed before ready"));
    });
  });
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
