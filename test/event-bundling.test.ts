import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import {
  EventBundleRepository,
  bundlePullRequestEvents,
} from "../src/event-bundling.js";
import { initializeDatabase } from "../src/database.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
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

describe("bundlePullRequestEvents", () => {
  it("bundles repeated human comments into one debounce window", () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "first" }),
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "second" }),
        occurredAt: "2026-04-10T12:00:40.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "third" }),
        occurredAt: "2026-04-10T12:01:20.000Z",
      });

      expect(bundlePullRequestEvents(database, pullRequest.id)).toEqual({
        eligibleCount: 3,
        bundledCount: 3,
        createdBundleCount: 1,
      });

      const bundles = eventBundleRepository.listEventBundlesForPullRequest(pullRequest.id);

      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toMatchObject({
        windowStartedAt: "2026-04-10T12:00:00.000Z",
        windowEndsAt: "2026-04-10T12:02:20.000Z",
      });
      expect(
        normalizedEventRepository.listNormalizedEventsForBundle(bundles[0]?.id ?? -1).map((event) => ({
          eventType: event.eventType,
          occurredAt: event.occurredAt,
        })),
      ).toEqual([
        {
          eventType: "issue_comment",
          occurredAt: "2026-04-10T12:00:00.000Z",
        },
        {
          eventType: "issue_comment",
          occurredAt: "2026-04-10T12:00:40.000Z",
        },
        {
          eventType: "issue_comment",
          occurredAt: "2026-04-10T12:01:20.000Z",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("bundles mixed ci and review activity but skips immediate reviews", () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorClass: "human_other",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:10:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_approved",
        actorClass: "human_other",
        decisionState: "notified",
        notificationTiming: "immediate",
        occurredAt: "2026-04-10T12:10:15.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_inline_comment",
        actorClass: "human_other",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:10:30.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "ci_failed",
        actorClass: "self",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:10:45.000Z",
      });

      expect(bundlePullRequestEvents(database, pullRequest.id)).toEqual({
        eligibleCount: 3,
        bundledCount: 3,
        createdBundleCount: 1,
      });

      const bundles = eventBundleRepository.listEventBundlesForPullRequest(pullRequest.id);

      expect(bundles).toHaveLength(1);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          eventType: event.eventType,
          notificationTiming: event.notificationTiming,
          eventBundleId: event.eventBundleId,
        })),
      ).toEqual([
        {
          eventType: "issue_comment",
          notificationTiming: null,
          eventBundleId: bundles[0]?.id ?? null,
        },
        {
          eventType: "review_approved",
          notificationTiming: "immediate",
          eventBundleId: null,
        },
        {
          eventType: "review_inline_comment",
          notificationTiming: null,
          eventBundleId: bundles[0]?.id ?? null,
        },
        {
          eventType: "ci_failed",
          notificationTiming: null,
          eventBundleId: bundles[0]?.id ?? null,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps bundles isolated per pull request and stays idempotent", () => {
    const { database, repository } = createRepository();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);

    try {
      const firstPullRequest = repository.upsertPullRequest(createPullRequestInput());
      const secondPullRequest = repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 202,
          number: 8,
          url: "https://github.com/acme/octopulse/pull/8",
          title: "Second pull request",
          lastSeenHeadSha: "def456",
        }),
      );

      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: firstPullRequest.id,
        eventType: "issue_comment",
        actorClass: "human_other",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:20:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: secondPullRequest.id,
        eventType: "ci_succeeded",
        actorClass: "self",
        decisionState: "notified",
        occurredAt: "2026-04-10T12:20:20.000Z",
      });

      expect(bundlePullRequestEvents(database, firstPullRequest.id)).toEqual({
        eligibleCount: 1,
        bundledCount: 1,
        createdBundleCount: 1,
      });
      expect(bundlePullRequestEvents(database, secondPullRequest.id)).toEqual({
        eligibleCount: 1,
        bundledCount: 1,
        createdBundleCount: 1,
      });
      expect(bundlePullRequestEvents(database, firstPullRequest.id)).toEqual({
        eligibleCount: 0,
        bundledCount: 0,
        createdBundleCount: 0,
      });
      expect(bundlePullRequestEvents(database, secondPullRequest.id)).toEqual({
        eligibleCount: 0,
        bundledCount: 0,
        createdBundleCount: 0,
      });

      expect(eventBundleRepository.listEventBundlesForPullRequest(firstPullRequest.id)).toHaveLength(1);
      expect(eventBundleRepository.listEventBundlesForPullRequest(secondPullRequest.id)).toHaveLength(1);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(firstPullRequest.id)[0]?.eventBundleId,
      ).not.toBe(
        normalizedEventRepository.listNormalizedEventsForPullRequest(secondPullRequest.id)[0]?.eventBundleId,
      );
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-event-bundling-home-");
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

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function createPullRequestInput(
  overrides: Partial<UpsertPullRequestInput> = {},
): UpsertPullRequestInput {
  const input: UpsertPullRequestInput = {
    githubPullRequestId: 101,
    repositoryOwner: "acme",
    repositoryName: "octopulse",
    number: 7,
    url: "https://github.com/acme/octopulse/pull/7",
    authorLogin: "octocat",
    title: "Add per-PR event bundling",
    state: "open",
    isDraft: false,
    lastSeenAt: "2026-04-10T11:55:00.000Z",
    closedAt: null,
    mergedAt: null,
    graceUntil: null,
    lastSeenHeadSha: "abc123",
  };

  if (overrides.tracking) {
    input.tracking = overrides.tracking;
  }

  return {
    ...input,
    ...overrides,
  };
}
