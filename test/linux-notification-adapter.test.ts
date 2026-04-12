import { describe, expect, it, vi, beforeEach } from "vitest";

const freedesktopMocks = vi.hoisted(() => {
  const push = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn().mockReturnThis();
  const Notification = vi.fn().mockImplementation(() => ({ push, on }));
  const getCapabilities = vi.fn().mockResolvedValue([]);

  return {
    push,
    on,
    Notification,
    getCapabilities,
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

vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockReturnValue({
    once: vi.fn(),
  }),
}));

describe("LinuxNotificationAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    freedesktopMocks.getCapabilities.mockResolvedValue([]);
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

  it("uses legacy markup body when notification server supports it", async () => {
    freedesktopMocks.getCapabilities.mockResolvedValue(["body-markup"]);

    const adapter = new LinuxNotificationAdapter();

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse #7 Add notifications",
        body: "alice: ✅ LGTM\n\nCI failed",
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(freedesktopMocks.Notification).toHaveBeenCalledWith({
      appName: "Octopulse",
      summary: "",
      body: "<b>acme/octopulse #7 Add notifications</b>\n\n<b>alice</b> ✅ LGTM\n\nCI failed",
      actions: {},
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
      actions: {},
    });
  });
});
