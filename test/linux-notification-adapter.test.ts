import { describe, expect, it, vi, beforeEach } from "vitest";

const freedesktopMocks = vi.hoisted(() => {
  const push = vi.fn().mockResolvedValue(undefined);
  const getCapabilities = vi.fn().mockResolvedValue([]);
  const instances: Array<{
    push: typeof push;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  }> = [];
  const Notification = vi.fn().mockImplementation(() => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const instance = {
      push,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(event) ?? [];
        eventListeners.push(listener);
        listeners.set(event, eventListeners);
        return instance;
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
      },
    };

    instances.push(instance);
    return instance;
  });

  return {
    push,
    Notification,
    getCapabilities,
    instances,
  };
});

vi.mock("freedesktop-notifications", () => ({
  default: {
    Notification: freedesktopMocks.Notification,
    getCapabilities: freedesktopMocks.getCapabilities,
  },
}));

import {
  LinuxNotificationAdapter,
  LinuxNotificationAdapterError,
  type LinuxNotificationDispatchResult,
  type LinuxNotification,
} from "../src/linux-notification-adapter.js";
import { DESKTOP_ENTRY_ID } from "../src/desktop-entry.js";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockReturnValue({
    once: vi.fn(),
  }),
}));

describe("LinuxNotificationAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    freedesktopMocks.getCapabilities.mockResolvedValue([]);
    freedesktopMocks.instances.length = 0;
  });

  it("dispatches a notification via custom dispatch function", async () => {
    const dispatchNotification = vi
      .fn<(_notification: LinuxNotification) => Promise<LinuxNotificationDispatchResult>>()
      .mockResolvedValue({ openedClickUrl: false });

    const adapter = new LinuxNotificationAdapter({ dispatchNotification });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(dispatchNotification).toHaveBeenCalledWith({
      title: "acme/octopulse PR #7",
      body: "alice approved review\nShip notifications",
    });
  });

  it("passes clickUrl to custom dispatch when present", async () => {
    const dispatchNotification = vi
      .fn<(_notification: LinuxNotification) => Promise<LinuxNotificationDispatchResult>>()
      .mockResolvedValue({ openedClickUrl: true });

    const adapter = new LinuxNotificationAdapter({ dispatchNotification });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
      }),
    ).resolves.toEqual({
      openedClickUrl: true,
    });

    expect(dispatchNotification).toHaveBeenCalledWith({
      title: "acme/octopulse PR #7",
      body: "alice approved review\nShip notifications",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
    });
  });

  it("does not wait for clickable notifications to close before resolving", async () => {
    const adapter = new LinuxNotificationAdapter();
    const clickUrl = "https://github.com/acme/octopulse/pull/7";

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
        icon: "/tmp/pull-request-open.svg",
        clickUrl,
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(freedesktopMocks.Notification).toHaveBeenCalledWith({
      appName: "Octopulse",
      summary: "acme/octopulse PR #7",
      body: "alice approved review\nShip notifications",
      urgency: "normal",
      actions: { default: "Open" },
      icon: "/tmp/pull-request-open.svg",
      timeout: 10000,
      "desktop-entry": DESKTOP_ENTRY_ID,
    });
    expect(spawn).not.toHaveBeenCalled();

    freedesktopMocks.instances[0]?.emit("action", "default");

    expect(spawn).toHaveBeenCalledWith("xdg-open", [clickUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("wraps custom dispatch errors in LinuxNotificationAdapterError", async () => {
    const dispatchNotification = vi
      .fn<(_notification: LinuxNotification) => Promise<LinuxNotificationDispatchResult>>()
      .mockRejectedValue(new Error("notification daemon unavailable"));

    const adapter = new LinuxNotificationAdapter({ dispatchNotification });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
      }),
    ).rejects.toThrowError("Notification failed: Error: notification daemon unavailable");
  });

  it("marks sticky notifications as non-expiring", async () => {
    const adapter = new LinuxNotificationAdapter();

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
        sticky: true,
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(freedesktopMocks.Notification).toHaveBeenCalledWith({
      appName: "Octopulse",
      summary: "acme/octopulse PR #7",
      body: "alice approved review\nShip notifications",
      urgency: "normal",
      actions: {},
      timeout: 0,
      "desktop-entry": DESKTOP_ENTRY_ID,
    });
  });

  it("uses markup body when notification server supports it", async () => {
    const avatarCache = {
      resolveAvatarFileUri: vi
        .fn()
        .mockResolvedValueOnce("file:///tmp/octocat.png")
        .mockResolvedValueOnce("file:///tmp/alice.png"),
    };
    freedesktopMocks.getCapabilities.mockResolvedValue(["body-markup", "body-images"]);

    const adapter = new LinuxNotificationAdapter({ avatarCache });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse #7 Add notifications",
        body: "alice: ✅ LGTM\n\nCI failed",
        icon: "/tmp/pull-request-open.svg",
        markup: {
          headerText: "[octopulse] Add notifications (open)",
          headerAvatarKey: "octocat",
          headerAvatarUrl: "https://avatars.example.test/octocat.png",
          paragraphs: [
            {
              actorLogin: "alice",
              actorAvatarKey: "alice",
              actorAvatarUrl: "https://avatars.example.test/alice.png",
              text: "✅ LGTM",
            },
            {
              actorLogin: null,
              actorAvatarKey: null,
              actorAvatarUrl: null,
              text: "CI failed",
            },
          ],
        },
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(freedesktopMocks.Notification).toHaveBeenCalledWith({
      appName: "Octopulse",
      summary: "",
      body:
        '<img src="file:///tmp/octocat.png"/> [octopulse] Add notifications (open)\n<b> </b>\n<img src="file:///tmp/alice.png"/> <b>alice</b> ✅ LGTM\n\nCI failed',
      urgency: "normal",
      actions: {},
      icon: "/tmp/pull-request-open.svg",
      timeout: 10000,
      "desktop-entry": DESKTOP_ENTRY_ID,
    });
  });

  it("falls back to plain body when markup is unsupported", async () => {
    const adapter = new LinuxNotificationAdapter();

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse #7 Add notifications",
        body: "alice: ✅ LGTM",
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(freedesktopMocks.Notification).toHaveBeenCalledWith({
      appName: "Octopulse",
      summary: "acme/octopulse #7 Add notifications",
      body: "alice: ✅ LGTM",
      urgency: "normal",
      actions: {},
      timeout: 10000,
      "desktop-entry": DESKTOP_ENTRY_ID,
    });
  });

  it("uses markup without images when body-images capability is absent", async () => {
    freedesktopMocks.getCapabilities.mockResolvedValue(["body-markup"]);

    const adapter = new LinuxNotificationAdapter({
      avatarCache: {
        resolveAvatarFileUri: vi.fn(),
      },
    });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse #7 Add notifications",
        body: "alice: ✅ LGTM",
        markup: {
          headerText: "[octopulse] Add notifications (open)",
          headerAvatarKey: "octocat",
          headerAvatarUrl: "https://avatars.example.test/octocat.png",
          paragraphs: [
            {
              actorLogin: "alice",
              actorAvatarKey: "alice",
              actorAvatarUrl: "https://avatars.example.test/alice.png",
              text: "✅ LGTM",
            },
          ],
        },
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(freedesktopMocks.Notification).toHaveBeenCalledWith({
      appName: "Octopulse",
      summary: "",
      body: "[octopulse] Add notifications (open)\n<b> </b>\n<b>alice</b> ✅ LGTM",
      urgency: "normal",
      actions: {},
      timeout: 10000,
      "desktop-entry": DESKTOP_ENTRY_ID,
    });
  });
});
