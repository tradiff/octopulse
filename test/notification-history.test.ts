import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { EventBundleRepository } from "../src/event-bundling.js";
import { listNotificationHistory } from "../src/notification-history.js";
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

describe("listNotificationHistory", () => {
  it("lists immediate and bundled notification records with decision states", () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);
    const notificationRecordRepository = new NotificationRecordRepository(database);

    try {
      const immediateEvent = normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_approved",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        notificationTiming: "immediate",
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      const bundledComment = normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "ci-bot[bot]",
        actorClass: "bot",
        decisionState: "notified_ai_fallback",
        occurredAt: "2026-04-10T12:01:00.000Z",
      });
      const bundledCi = normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "ci_failed",
        actorLogin: "github-actions[bot]",
        actorClass: "bot",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:01:20.000Z",
      });
      const bundle = eventBundleRepository.createEventBundle({
        pullRequestId: pullRequest.id,
        windowStartedAt: bundledComment.occurredAt,
        windowEndsAt: "2026-04-10T12:02:20.000Z",
      });

      normalizedEventRepository.assignEventBundle([bundledComment.id, bundledCi.id], bundle.id);

      notificationRecordRepository.createNotificationRecord({
        normalizedEventId: immediateEvent.id,
        pullRequestId: pullRequest.id,
        title: "acme/octopulse PR #7",
        body: "alice approved review\nAdd notifications",
        clickUrl: pullRequest.url,
        deliveryStatus: "pending",
      });
      notificationRecordRepository.createNotificationRecord({
        eventBundleId: bundle.id,
        pullRequestId: pullRequest.id,
        title: "acme/octopulse PR #7",
        body: "1 comment, CI failed\nAdd notifications",
        clickUrl: pullRequest.url,
        deliveryStatus: "sent",
        deliveredAt: "2026-04-10T12:02:45.000Z",
      });

        expect(listNotificationHistory(database)).toEqual([
          expect.objectContaining({
            title: "acme/octopulse PR #7",
            deliveryStatus: "sent",
            decisionStates: ["notified_ai_fallback", "notified"],
            eventTypes: ["issue_comment", "ci_failed"],
            actorClasses: ["bot"],
            sourceKind: "bundle",
            repositoryKey: "acme/octopulse",
            isTracked: true,
            deliveredAt: "2026-04-10T12:02:45.000Z",
          }),
          expect.objectContaining({
            title: "acme/octopulse PR #7",
            deliveryStatus: "pending",
            decisionStates: ["notified"],
            eventTypes: ["review_approved"],
            actorClasses: ["human_other"],
            sourceKind: "immediate",
            repositoryKey: "acme/octopulse",
            isTracked: true,
            deliveredAt: null,
          }),
        ]);
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-notification-history-home-");
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
