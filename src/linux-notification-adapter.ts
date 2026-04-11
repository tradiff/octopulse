import freedesktopNotifications from "freedesktop-notifications";
import { spawn } from "node:child_process";

export interface LinuxNotification {
  title: string;
  body: string;
  clickUrl?: string | null;
}

export interface LinuxNotificationDispatchResult {
  openedClickUrl: boolean;
}

export interface LinuxNotificationAdapterOptions {
  dispatchNotification?: (
    notification: LinuxNotification,
  ) => Promise<LinuxNotificationDispatchResult>;
}

export class LinuxNotificationAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinuxNotificationAdapterError";
  }
}

export class LinuxNotificationAdapter {
  private readonly dispatchNotificationImpl: (
    notification: LinuxNotification,
  ) => Promise<LinuxNotificationDispatchResult>;

  constructor(options: LinuxNotificationAdapterOptions = {}) {
    this.dispatchNotificationImpl =
      options.dispatchNotification ?? this.defaultDispatch.bind(this);
  }

  async dispatchNotification(
    notification: LinuxNotification,
  ): Promise<LinuxNotificationDispatchResult> {
    try {
      return await this.dispatchNotificationImpl(notification);
    } catch (err) {
      throw new LinuxNotificationAdapterError(`Notification failed: ${err}`);
    }
  }

  private async defaultDispatch(
    notification: LinuxNotification,
  ): Promise<LinuxNotificationDispatchResult> {
    const notif = new freedesktopNotifications.Notification({
      appName: "Octopulse",
      summary: notification.title,
      body: notification.body,
      actions: notification.clickUrl
        ? { default: "Open" }
        : {},
    });

    if (!notification.clickUrl) {
      await notif.push();
      return { openedClickUrl: false };
    }

    const clicked = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const timeout = setTimeout(() => finish(false), 30000);

      notif.on("action", (action: string) => {
        if (action === "default") {
          finish(true);
        }
      });

      notif.on("close", () => {
        finish(false);
      });

      notif.push().catch((err: unknown) => {
        fail(err);
      });
    });

    if (clicked && notification.clickUrl) {
      await openUrl(notification.clickUrl);
      return { openedClickUrl: true };
    }

    return { openedClickUrl: false };
  }
}

async function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("xdg-open", [url], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`xdg-open exited with code ${code}`));
      }
    });
  });
}
