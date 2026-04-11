import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import {
  classifyActor,
  normalizePullRequestActivity,
} from "../src/pull-request-activity-normalization.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";
import { RawEventRepository } from "../src/raw-event-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("classifyActor", () => {
  it("classifies self, human_other, and bot actors", () => {
    expect(
      classifyActor({
        currentUserLogin: "octocat",
        actorLogin: "OctoCat",
      }),
    ).toBe("self");

    expect(
      classifyActor({
        currentUserLogin: "octocat",
        actorLogin: "alice",
      }),
    ).toBe("human_other");

    expect(
      classifyActor({
        currentUserLogin: "octocat",
        actorLogin: "renovate[bot]",
      }),
    ).toBe("bot");

    expect(
      classifyActor({
        currentUserLogin: "octocat",
        actorLogin: null,
        actorType: "Bot",
      }),
    ).toBe("bot");
  });
});

describe("normalizePullRequestActivity", () => {
  it("persists normalized events linked to raw activity", () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);

    try {
      const issueCommentRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_comment",
        sourceId: "1001",
        eventType: "issue_comment",
        actorLogin: "alice",
        payloadJson: JSON.stringify({
          id: 1001,
          user: {
            login: "alice",
            type: "User",
          },
          body: "Ship it",
        }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      }).rawEvent;
      const reviewRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2001",
        eventType: "pull_request_review",
        actorLogin: "renovate[bot]",
        payloadJson: JSON.stringify({
          id: 2001,
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
          state: "APPROVED",
          body: "LGTM",
        }),
        occurredAt: "2026-04-10T12:02:00.000Z",
      }).rawEvent;
      const timelineRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "3001",
        eventType: "merged",
        actorLogin: "octocat",
        payloadJson: JSON.stringify({
          id: 3001,
          actor: {
            login: "octocat",
            type: "User",
          },
          event: "merged",
        }),
        occurredAt: "2026-04-10T12:03:00.000Z",
      }).rawEvent;

      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_actions_workflow_run",
        sourceId: "4001:2026-04-10T12:04:00.000Z",
        eventType: "workflow_run",
        actorLogin: "github-actions[bot]",
        payloadJson: JSON.stringify({
          id: 4001,
          actor: {
            login: "github-actions[bot]",
            type: "Bot",
          },
          conclusion: "success",
          head_sha: "abc123",
        }),
        occurredAt: "2026-04-10T12:04:00.000Z",
      });

      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 4,
        normalizedCount: 3,
        skippedCount: 1,
      });

      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          rawEventId: event.rawEventId,
          eventType: event.eventType,
          actorLogin: event.actorLogin,
          actorClass: event.actorClass,
        })),
      ).toEqual([
        {
          rawEventId: issueCommentRawEvent?.id ?? null,
          eventType: "issue_comment",
          actorLogin: "alice",
          actorClass: "human_other",
        },
        {
          rawEventId: reviewRawEvent?.id ?? null,
          eventType: "review_approved",
          actorLogin: "renovate[bot]",
          actorClass: "bot",
        },
        {
          rawEventId: timelineRawEvent?.id ?? null,
          eventType: "pr_merged",
          actorLogin: "octocat",
          actorClass: "self",
        },
      ]);

      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 1,
        normalizedCount: 0,
        skippedCount: 1,
      });
      expect(normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id)).toHaveLength(3);
    } finally {
      database.close();
    }
  });
});

function createPullRequest(): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const homeDir = createTempDir("octopulse-pr-normalization-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));
  const repository = new PullRequestRepository(database);

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
    title: "Add normalization pipeline",
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
