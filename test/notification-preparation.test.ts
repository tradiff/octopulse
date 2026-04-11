import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { EventBundleRepository, bundlePullRequestEvents } from "../src/event-bundling.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import { preparePullRequestNotifications } from "../src/notification-preparation.js";
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

describe("preparePullRequestNotifications", () => {
  it("persists immediate notifications and only persists bundles after debounce window closes", () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);
    const notificationRecordRepository = new NotificationRecordRepository(database);

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
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "ci_failed",
        actorLogin: "github-actions[bot]",
        actorClass: "bot",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:01:20.000Z",
      });

      expect(bundlePullRequestEvents(database, pullRequest.id)).toEqual({
        eligibleCount: 2,
        bundledCount: 2,
        createdBundleCount: 1,
      });

      expect(
        preparePullRequestNotifications(database, pullRequest, {
          preparedAt: "2026-04-10T12:01:30.000Z",
        }),
      ).toEqual({
        immediateCount: 1,
        bundledCount: 0,
        createdCount: 1,
      });

      const firstPass = notificationRecordRepository.listNotificationRecordsForPullRequest(pullRequest.id);

      expect(firstPass).toHaveLength(1);
      expect(firstPass[0]).toMatchObject({
        normalizedEventId: expect.any(Number),
        eventBundleId: null,
        title: "acme/octopulse PR #7",
        body: "alice approved review\nAdd notifications",
        clickUrl: "https://github.com/acme/octopulse/pull/7",
        deliveryStatus: "pending",
      });

      expect(
        preparePullRequestNotifications(database, pullRequest, {
          preparedAt: "2026-04-10T12:02:30.000Z",
        }),
      ).toEqual({
        immediateCount: 0,
        bundledCount: 1,
        createdCount: 1,
      });

      const bundle = eventBundleRepository.listEventBundlesForPullRequest(pullRequest.id)[0];

      expect(bundle).toBeDefined();
      expect(notificationRecordRepository.listNotificationRecordsForPullRequest(pullRequest.id)).toEqual([
        expect.objectContaining({
          normalizedEventId: expect.any(Number),
          eventBundleId: null,
        }),
        expect.objectContaining({
          normalizedEventId: null,
          eventBundleId: bundle?.id ?? null,
          title: "acme/octopulse PR #7",
          body: "1 comment, CI failed\nAdd notifications",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "pending",
        }),
      ]);

      expect(
        preparePullRequestNotifications(database, pullRequest, {
          preparedAt: "2026-04-10T12:05:00.000Z",
        }),
      ).toEqual({
        immediateCount: 0,
        bundledCount: 0,
        createdCount: 0,
      });
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-notification-home-");
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
