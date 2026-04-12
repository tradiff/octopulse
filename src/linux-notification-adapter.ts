import freedesktopNotifications from "freedesktop-notifications";
import { spawn } from "node:child_process";

import { FileAvatarCache, type AvatarImageCache } from "./avatar-cache.js";
import type { NotificationMarkup } from "./notification-rendering.js";

export interface LinuxNotification {
  title: string;
  body: string;
  clickUrl?: string | null;
  markup?: NotificationMarkup;
}

export interface LinuxNotificationDispatchResult {
  openedClickUrl: boolean;
}

export interface LinuxNotificationAdapterOptions {
  dispatchNotification?: (
    notification: LinuxNotification,
  ) => Promise<LinuxNotificationDispatchResult>;
  avatarCache?: AvatarImageCache;
  avatarCacheDirPath?: string;
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
  private readonly avatarCache: AvatarImageCache;
  private capabilitiesPromise: Promise<readonly string[]> | null = null;

  constructor(options: LinuxNotificationAdapterOptions = {}) {
    this.avatarCache = options.avatarCache ?? new FileAvatarCache(
      options.avatarCacheDirPath === undefined
        ? {}
        : { cacheDirPath: options.avatarCacheDirPath },
    );
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

    notif.on("action", (action: string) => {
      if (action !== "default") {
        return;
      }

      void openUrl(notification.clickUrl!).catch(() => undefined);
    });

    await notif.push();

    return { openedClickUrl: false };
  }

  private async renderForServer(notification: LinuxNotification): Promise<{
    summary: string;
    body: string;
  }> {
    const capabilities = await this.readServerCapabilities();

    if (!capabilities.includes("body-markup") || notification.markup === undefined) {
      return {
        summary: notification.title,
        body: notification.body,
      };
    }

    return {
      summary: "",
      body: await buildMarkupBody(notification.markup, {
        avatarCache: this.avatarCache,
        supportsImages: capabilities.includes("body-images"),
      }),
    };
  }

  private async readServerCapabilities(): Promise<readonly string[]> {
    if (this.capabilitiesPromise === null) {
      this.capabilitiesPromise = freedesktopNotifications.getCapabilities().catch(() => []);
    }

    return this.capabilitiesPromise;
  }
}

async function buildMarkupBody(
  markup: NotificationMarkup,
  options: { avatarCache: AvatarImageCache; supportsImages: boolean },
): Promise<string> {
  const headerImage = await resolveAvatarImage(
    options.avatarCache,
    options.supportsImages,
    markup.headerAvatarKey,
    markup.headerAvatarUrl,
  );
  const renderedParagraphs = await Promise.all(
    markup.paragraphs.map(async (paragraph) => {
      const image = await resolveAvatarImage(
        options.avatarCache,
        options.supportsImages,
        paragraph.actorAvatarKey,
        paragraph.actorAvatarUrl,
      );

      return formatMarkupParagraph({
        image,
        actorLogin: paragraph.actorLogin,
        text: paragraph.text,
      });
    }),
  );

  return [
    formatMarkupHeader(markup.headerText, headerImage),
    "<b> </b>",
    renderedParagraphs.join("\n\n"),
  ].join("\n");
}

async function resolveAvatarImage(
  avatarCache: AvatarImageCache,
  supportsImages: boolean,
  key: string | null,
  avatarUrl: string | null,
): Promise<string | null> {
  if (!supportsImages || key === null || avatarUrl === null) {
    return null;
  }

  try {
    return await avatarCache.resolveAvatarFileUri({ key, avatarUrl });
  } catch {
    return null;
  }
}

function formatMarkupHeader(headerText: string, image: string | null): string {
  return image === null
    ? escapeMarkup(headerText)
    : `<img src="${escapeMarkup(image)}"/> ${escapeMarkup(headerText)}`;
}

function formatMarkupParagraph(input: {
  image: string | null;
  actorLogin: string | null;
  text: string;
}): string {
  const imagePrefix = input.image === null ? "" : `<img src="${escapeMarkup(input.image)}"/> `;

  if (input.actorLogin === null) {
    return `${imagePrefix}${escapeMarkup(input.text)}`;
  }

  return `${imagePrefix}<b>${escapeMarkup(input.actorLogin)}</b> ${escapeMarkup(input.text)}`;
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
