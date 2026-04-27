import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { bundlePullRequestEvents } from "../src/event-bundling.js";
import { dispatchPullRequestNotifications } from "../src/notification-dispatch.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("dispatchPullRequestNotifications", () => {
  it("dispatches immediate and bundled notifications through the same path", async () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationRecordRepository = new NotificationRecordRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_approved",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        notificationTiming: "immediate",
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/alice.png" }),
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "bob",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/bob.png" }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      });

      expect(bundlePullRequestEvents(database, pullRequest.id)).toEqual({
        eligibleCount: 1,
        bundledCount: 1,
        createdBundleCount: 1,
      });

      await expect(
        dispatchPullRequestNotifications(database, pullRequest, {
          currentUserLogin: "octocat",
          dispatchedAt: "2026-04-10T12:02:45.000Z",
          notificationDispatcher,
        }),
      ).resolves.toEqual({
        immediateCount: 1,
        bundledCount: 1,
        createdCount: 2,
        dispatchedCount: 2,
        failedCount: 0,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledTimes(2);
      expect(notificationDispatcher.dispatchNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
        title: "acme/octopulse #7 Add notifications",
        body: "alice: ✅ approved",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
        icon: expect.stringContaining("pull-request-open.svg"),
        sticky: true,
        markup: expect.objectContaining({
          headerText: "[octopulse] Add notifications (open)",
          headerAvatarUrl: "https://avatars.example.test/octocat.png",
        }),
      }));
      expect(notificationDispatcher.dispatchNotification).toHaveBeenNthCalledWith(2, expect.objectContaining({
        title: "acme/octopulse #7 Add notifications",
        body: "bob: 💬 commented",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
        icon: expect.stringContaining("pull-request-open.svg"),
        sticky: true,
        markup: expect.objectContaining({
          headerText: "[octopulse] Add notifications (open)",
          headerAvatarUrl: "https://avatars.example.test/octocat.png",
        }),
      }));
      expect(notificationRecordRepository.listNotificationRecordsForPullRequest(pullRequest.id)).toEqual([
        expect.objectContaining({
          deliveryStatus: "sent",
          deliveredAt: "2026-04-10T12:02:45.000Z",
          normalizedEventId: expect.any(Number),
          eventBundleId: null,
        }),
        expect.objectContaining({
          deliveryStatus: "sent",
          deliveredAt: "2026-04-10T12:02:45.000Z",
          normalizedEventId: null,
          eventBundleId: expect.any(Number),
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("marks notification records failed when dispatch errors occur", async () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationRecordRepository = new NotificationRecordRepository(database);
    const onError = vi.fn();

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_approved",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        notificationTiming: "immediate",
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/alice.png" }),
        occurredAt: "2026-04-10T12:00:00.000Z",
      });

      await expect(
        dispatchPullRequestNotifications(database, pullRequest, {
          notificationDispatcher: {
            dispatchNotification: vi.fn().mockRejectedValue(new Error("notify-send failed")),
          },
          onError,
        }),
      ).resolves.toEqual({
        immediateCount: 1,
        bundledCount: 0,
        createdCount: 1,
        dispatchedCount: 0,
        failedCount: 1,
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0].message).toContain("notify-send failed");
      expect(notificationRecordRepository.listNotificationRecordsForPullRequest(pullRequest.id)).toEqual([
        expect.objectContaining({
          deliveryStatus: "failed",
          deliveredAt: null,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("does not dispatch suppressed decisions", async () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_approved",
        actorLogin: "octocat",
        actorClass: "self",
        decisionState: "suppressed_self_action",
        notificationTiming: "immediate",
        occurredAt: "2026-04-10T12:00:00.000Z",
      });

      await expect(
        dispatchPullRequestNotifications(database, pullRequest, {
          notificationDispatcher,
        }),
      ).resolves.toEqual({
        immediateCount: 0,
        bundledCount: 0,
        createdCount: 0,
        dispatchedCount: 0,
        failedCount: 0,
      });

      expect(notificationDispatcher.dispatchNotification).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("auto-dismisses notifications for pull requests not authored by the current user", async () => {
    const { database, pullRequest } = createPullRequest({ authorLogin: "alice" });
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "bob",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/bob.png" }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      });

      expect(bundlePullRequestEvents(database, pullRequest.id)).toEqual({
        eligibleCount: 1,
        bundledCount: 1,
        createdBundleCount: 1,
      });

      await expect(
        dispatchPullRequestNotifications(database, pullRequest, {
          currentUserLogin: "octocat",
          notificationDispatcher,
        }),
      ).resolves.toEqual({
        immediateCount: 0,
        bundledCount: 1,
        createdCount: 1,
        dispatchedCount: 1,
        failedCount: 0,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({
        body: "bob: 💬 commented",
        sticky: false,
      }));
    } finally {
      database.close();
    }
  });

  it("keeps review-request notifications sticky even when the pull request is not authored by the current user", async () => {
    const { database, pullRequest } = createPullRequest({ authorLogin: "alice" });
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_requested",
        decisionState: "notified",
        notificationTiming: "immediate",
        occurredAt: "2026-04-10T12:01:00.000Z",
      });

      await expect(
        dispatchPullRequestNotifications(database, pullRequest, {
          currentUserLogin: "octocat",
          notificationDispatcher,
        }),
      ).resolves.toEqual({
        immediateCount: 1,
        bundledCount: 0,
        createdCount: 1,
        dispatchedCount: 1,
        failedCount: 0,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({
        body: "👀 review requested",
        sticky: true,
      }));
    } finally {
      database.close();
    }
  });

  it("keeps ready-for-review notifications sticky even when the pull request is not authored by the current user", async () => {
    const { database, pullRequest } = createPullRequest({ authorLogin: "alice" });
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "ready_for_review",
        actorLogin: "bob",
        actorClass: "human_other",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:01:00.000Z",
      });

      expect(bundlePullRequestEvents(database, pullRequest.id)).toEqual({
        eligibleCount: 1,
        bundledCount: 1,
        createdBundleCount: 1,
      });

      await expect(
        dispatchPullRequestNotifications(database, pullRequest, {
          currentUserLogin: "octocat",
          notificationDispatcher,
        }),
      ).resolves.toEqual({
        immediateCount: 0,
        bundledCount: 1,
        createdCount: 1,
        dispatchedCount: 1,
        failedCount: 0,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({
        body: "bob: marked PR ready for review",
        sticky: true,
      }));
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-notification-dispatch-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));

  return {
    database,
    repository: new PullRequestRepository(database),
  };
}

function createPullRequest(
  overrides: Partial<UpsertPullRequestInput> = {},
): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const { database, repository } = createRepository();

  return {
    database,
    pullRequest: repository.upsertPullRequest(createPullRequestInput(overrides)),
  };
}

function createPullRequestInput(
  overrides: Partial<UpsertPullRequestInput> = {},
): UpsertPullRequestInput {
  return {
    githubPullRequestId: 101,
    repositoryOwner: "acme",
    repositoryName: "octopulse",
    number: 7,
    url: "https://github.com/acme/octopulse/pull/7",
    authorLogin: "octocat",
    authorAvatarUrl: "https://avatars.example.test/octocat.png",
    title: "Add notifications",
    state: "open",
    isDraft: false,
    lastSeenAt: "2026-04-10T12:00:00.000Z",
    lastSeenHeadSha: "abc123",
    ...overrides,
  };
}

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
