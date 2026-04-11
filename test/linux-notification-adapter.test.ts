import { describe, expect, it, vi, beforeEach } from "vitest";

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
});