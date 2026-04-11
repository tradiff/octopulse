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
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
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
          preparedAt: "2026-04-10T12:02:30.000Z",
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
      expect(notificationDispatcher.dispatchNotification).toHaveBeenNthCalledWith(1, {
        title: "acme/octopulse PR #7",
        body: "alice approved review\nAdd notifications",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
      });
      expect(notificationDispatcher.dispatchNotification).toHaveBeenNthCalledWith(2, {
        title: "acme/octopulse PR #7",
        body: "bob commented\nAdd notifications",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
      });
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
          preparedAt: "2026-04-10T12:02:00.000Z",
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

function createPullRequest(): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const { database, repository } = createRepository();

  return {
    database,
    pullRequest: repository.upsertPullRequest(createPullRequestInput()),
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
