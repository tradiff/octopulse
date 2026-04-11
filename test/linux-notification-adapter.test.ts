import { describe, expect, it, vi } from "vitest";

import {
  LinuxNotificationAdapter,
  LinuxNotificationAdapterError,
  type CommandRunner,
} from "../src/linux-notification-adapter.js";

describe("LinuxNotificationAdapter", () => {
  it("dispatches a notification without opening a URL when no click URL is provided", async () => {
    const runCommand = vi.fn<CommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      signal: null,
    });
    const adapter = new LinuxNotificationAdapter({ runCommand });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
      }),
    ).resolves.toEqual({
      openedClickUrl: false,
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("notify-send", [
      "--app-name=Octopulse",
      "--",
      "acme/octopulse PR #7",
      "alice approved review\nShip notifications",
    ]);
  });

  it("opens the PR URL when the notification action is activated", async () => {
    const runCommand = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "default\n",
        stderr: "",
        signal: null,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        signal: null,
      });
    const adapter = new LinuxNotificationAdapter({ runCommand });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
      }),
    ).resolves.toEqual({
      openedClickUrl: true,
    });

    expect(runCommand).toHaveBeenNthCalledWith(1, "notify-send", [
      "--app-name=Octopulse",
      "--action=default=Open",
      "--",
      "acme/octopulse PR #7",
      "alice approved review\nShip notifications",
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, "xdg-open", [
      "https://github.com/acme/octopulse/pull/7",
    ]);
  });

  it("surfaces notify-send failures as adapter errors", async () => {
    const adapter = new LinuxNotificationAdapter({
      runCommand: vi.fn<CommandRunner>().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "notification daemon unavailable",
        signal: null,
      }),
    });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
      }),
    ).rejects.toThrowError(
      new LinuxNotificationAdapterError(
        "Command notify-send exited with code 1: notification daemon unavailable",
      ),
    );
  });

  it("surfaces xdg-open failures after a notification click", async () => {
    const runCommand = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "default\n",
        stderr: "",
        signal: null,
      })
      .mockResolvedValueOnce({
        exitCode: 3,
        stdout: "",
        stderr: "no browser available",
        signal: null,
      });
    const adapter = new LinuxNotificationAdapter({ runCommand });

    await expect(
      adapter.dispatchNotification({
        title: "acme/octopulse PR #7",
        body: "alice approved review\nShip notifications",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
      }),
    ).rejects.toThrowError(
      new LinuxNotificationAdapterError("Command xdg-open exited with code 3: no browser available"),
    );
  });
});
