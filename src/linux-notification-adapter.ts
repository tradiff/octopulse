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
  private capabilitiesPromise: Promise<readonly string[]> | null = null;

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
    const renderedNotification = await this.renderForServer(notification);
    const notif = new freedesktopNotifications.Notification({
      appName: "Octopulse",
      summary: renderedNotification.summary,
      body: renderedNotification.body,
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

  private async renderForServer(notification: LinuxNotification): Promise<{
    summary: string;
    body: string;
  }> {
    if (!(await this.serverSupportsBodyMarkup())) {
      return {
        summary: notification.title,
        body: notification.body,
      };
    }

    return {
      summary: "",
      body: buildLegacyMarkupBody(notification),
    };
  }

  private async serverSupportsBodyMarkup(): Promise<boolean> {
    if (this.capabilitiesPromise === null) {
      this.capabilitiesPromise = freedesktopNotifications.getCapabilities().catch(() => []);
    }

    return (await this.capabilitiesPromise).includes("body-markup");
  }
}

function buildLegacyMarkupBody(notification: LinuxNotification): string {
  const bodyParagraphs = notification.body
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => formatLegacyParagraph(paragraph));
  const titleParagraph = notification.title.trim().length > 0
    ? [`<b>${escapeMarkup(notification.title)}</b>`]
    : [];

  return [...titleParagraph, ...bodyParagraphs].join("\n\n");
}

function formatLegacyParagraph(paragraph: string): string {
  const actorMatch = /^(.*?):\s(.+)$/.exec(paragraph);

  if (actorMatch === null) {
    return escapeMarkup(paragraph);
  }

  const actor = actorMatch[1]!;
  const rest = actorMatch[2]!;

  return `<b>${escapeMarkup(actor)}</b> ${escapeMarkup(rest)}`;
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
