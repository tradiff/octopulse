import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { EventBundleRepository } from "../src/event-bundling.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";
import { RawEventRepository } from "../src/raw-event-repository.js";
import { listRawEvents } from "../src/raw-events.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("listRawEvents", () => {
  it("lists normalized events with raw payloads and related notification outcomes", () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);
    const notificationRecordRepository = new NotificationRecordRepository(database);

    try {
      const immediateRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2001",
        eventType: "pull_request_review",
        actorLogin: "alice",
        payloadJson: '{"state":"CHANGES_REQUESTED","body":"Please add tests."}',
        occurredAt: "2026-04-10T12:04:00.000Z",
      }).rawEvent;
      const bundledRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_comment",
        sourceId: "1001",
        eventType: "issue_comment",
        actorLogin: "ci-bot[bot]",
        payloadJson: '{"body":"CI says hello"}',
        occurredAt: "2026-04-10T12:05:00.000Z",
      }).rawEvent;

      if (!immediateRawEvent || !bundledRawEvent) {
        throw new Error("Expected raw events to be inserted");
      }

      const immediateEvent = normalizedEventRepository.insertNormalizedEvent({
        rawEventId: immediateRawEvent.id,
        pullRequestId: pullRequest.id,
        eventType: "review_changes_requested",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        notificationTiming: "immediate",
        occurredAt: immediateRawEvent.occurredAt,
      });
      const bundledEvent = normalizedEventRepository.insertNormalizedEvent({
        rawEventId: bundledRawEvent.id,
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "ci-bot[bot]",
        actorClass: "bot",
        decisionState: "notified_ai_fallback",
        occurredAt: bundledRawEvent.occurredAt,
      });
      const bundle = eventBundleRepository.createEventBundle({
        pullRequestId: pullRequest.id,
        windowStartedAt: bundledEvent.occurredAt,
        windowEndsAt: "2026-04-10T12:06:00.000Z",
      });

      normalizedEventRepository.assignEventBundle([bundledEvent.id], bundle.id);

      notificationRecordRepository.createNotificationRecord({
        normalizedEventId: immediateEvent.id,
        pullRequestId: pullRequest.id,
        title: "acme/octopulse PR #7",
        body: "alice requested changes",
        clickUrl: pullRequest.url,
        deliveryStatus: "sent",
        deliveredAt: "2026-04-10T12:04:10.000Z",
      });
      notificationRecordRepository.createNotificationRecord({
        eventBundleId: bundle.id,
        pullRequestId: pullRequest.id,
        title: "acme/octopulse PR #7",
        body: "1 comment",
        clickUrl: pullRequest.url,
        deliveryStatus: "pending",
      });

        expect(listRawEvents(database)).toEqual([
          {
            id: bundledEvent.id,
            repositoryKey: "acme/octopulse",
            isTracked: true,
            pullRequestLabel: "acme/octopulse #7",
            pullRequestTitle: "Add notifications",
            pullRequestUrl: "https://github.com/acme/octopulse/pull/7",
          eventType: "issue_comment",
          actorLogin: "ci-bot[bot]",
          actorClass: "bot",
          decisionState: "notified_ai_fallback",
          notificationTiming: null,
          occurredAt: "2026-04-10T12:05:00.000Z",
          rawPayloadJson: '{"body":"CI says hello"}',
          notificationSourceKind: "bundle",
          notificationDeliveryStatus: "pending",
        },
          {
            id: immediateEvent.id,
            repositoryKey: "acme/octopulse",
            isTracked: true,
            pullRequestLabel: "acme/octopulse #7",
            pullRequestTitle: "Add notifications",
            pullRequestUrl: "https://github.com/acme/octopulse/pull/7",
          eventType: "review_changes_requested",
          actorLogin: "alice",
          actorClass: "human_other",
          decisionState: "notified",
          notificationTiming: "immediate",
          occurredAt: "2026-04-10T12:04:00.000Z",
          rawPayloadJson: '{"state":"CHANGES_REQUESTED","body":"Please add tests."}',
          notificationSourceKind: "immediate",
          notificationDeliveryStatus: "sent",
        },
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
  const homeDir = createTempDir("octopulse-raw-events-home-");
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
