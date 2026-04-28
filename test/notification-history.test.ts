import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_ACTIVITY_PAGE_SIZE } from "../src/activity-feed.js";
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
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/alice.png" }),
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      const bundledComment = normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "ci-bot[bot]",
        actorClass: "bot",
        decisionState: "notified_ai_fallback",
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/ci-bot.png" }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      });
      const bundledCi = normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "ci_failed",
        actorLogin: "github-actions[bot]",
        actorClass: "bot",
        decisionState: "notified",
        payloadJson: JSON.stringify({ actorAvatarUrl: "https://avatars.example.test/github-actions.png" }),
        occurredAt: "2026-04-10T12:01:20.000Z",
      });
      const bundle = eventBundleRepository.createEventBundle({
        pullRequestId: pullRequest.id,
        firstEventOccurredAt: bundledComment.occurredAt,
        lastEventOccurredAt: "2026-04-10T12:02:20.000Z",
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

        expect(listNotificationHistory(database)).toEqual({
          entries: [
            expect.objectContaining({
              title: "acme/octopulse PR #7",
              markupHeaderText: "[octopulse] Add notifications (open)",
              deliveryStatus: "sent",
              decisionStates: ["notified_ai_fallback", "notified"],
              eventTypes: ["issue_comment", "ci_failed"],
              actorClasses: ["bot"],
              sourceKind: "bundle",
              repositoryKey: "acme/octopulse",
              isTracked: true,
              author: {
                login: "octocat",
                avatarUrl: null,
              },
              actors: [
                {
                  login: "ci-bot[bot]",
                  avatarUrl: "https://avatars.example.test/ci-bot.png",
                },
                {
                  login: "github-actions[bot]",
                  avatarUrl: "https://avatars.example.test/github-actions.png",
                },
              ],
              summaryParagraphs: [
                {
                  actorLogin: "ci-bot[bot]",
                  actorAvatarKey: "ci-bot[bot]",
                  actorAvatarUrl: "https://avatars.example.test/ci-bot.png",
                  text: "💬 commented",
                },
                {
                  actorLogin: null,
                  actorAvatarKey: null,
                  actorAvatarUrl: null,
                  text: "CI failed",
                },
              ],
              deliveredAt: "2026-04-10T12:02:45.000Z",
            }),
            expect.objectContaining({
              title: "acme/octopulse PR #7",
              markupHeaderText: "[octopulse] Add notifications (open)",
              deliveryStatus: "pending",
              decisionStates: ["notified"],
              eventTypes: ["review_approved"],
              actorClasses: ["human_other"],
              sourceKind: "immediate",
              repositoryKey: "acme/octopulse",
              isTracked: true,
              author: {
                login: "octocat",
                avatarUrl: null,
              },
              actors: [
                {
                  login: "alice",
                  avatarUrl: "https://avatars.example.test/alice.png",
                },
              ],
              summaryParagraphs: [
                {
                  actorLogin: "alice",
                  actorAvatarKey: "alice",
                  actorAvatarUrl: "https://avatars.example.test/alice.png",
                  text: "✅ approved",
                },
              ],
              deliveredAt: null,
            }),
          ],
          page: 1,
          pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
          totalCount: 2,
          totalPages: 1,
        });
        expect(listNotificationHistory(database, { page: 2, pageSize: 1 })).toEqual(
          expect.objectContaining({
            entries: [
              expect.objectContaining({
                deliveryStatus: "pending",
                sourceKind: "immediate",
              }),
            ],
            page: 2,
            pageSize: 1,
            totalCount: 2,
            totalPages: 2,
          }),
        );
        expect(
          listNotificationHistory(database, {
            filters: {
              pullRequestState: "tracked",
              repository: "acme/octopulse",
              actorClass: "human_other",
            },
          }).entries,
        ).toEqual([
          expect.objectContaining({
            deliveryStatus: "pending",
            actorClasses: ["human_other"],
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
