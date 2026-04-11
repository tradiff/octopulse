import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { ingestPullRequestActivity } from "../src/pull-request-activity-ingestion.js";
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

describe("ingestPullRequestActivity", () => {
  it("persists raw pull request activity with source ids", async () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    let fetchedWorkflowHeadSha: string | null = null;

    try {
      await expect(
        ingestPullRequestActivity(database, { kind: "fake-client" }, pullRequest, {
          fetchIssueComments: async () => [
            createIssueCommentFixture(),
          ],
          fetchPullRequestReviews: async () => [
            createReviewFixture({
              id: 2001,
              actorLogin: "bob",
              state: "APPROVED",
              submittedAt: "2026-04-10T12:02:00.000Z",
              body: "Looks good to me",
            }),
            createReviewFixture({
              id: 2002,
              actorLogin: "carol",
              state: "COMMENTED",
              submittedAt: "2026-04-10T12:03:00.000Z",
              body: "One small question",
            }),
            createReviewFixture({
              id: 2003,
              actorLogin: "pending-reviewer",
              state: "PENDING",
              submittedAt: null,
              body: "Draft review should stay out",
            }),
          ],
          fetchPullRequestReviewComments: async () => [
            createReviewCommentFixture(),
          ],
          fetchPullRequestTimeline: async () => [
            createTimelineEventFixture({
              id: 4001,
              actorLogin: "octocat",
              event: "closed",
              createdAt: "2026-04-10T12:05:00.000Z",
            }),
            createTimelineEventFixture({
              id: 4002,
              actorLogin: "octocat",
              event: "ready_for_review",
              createdAt: "2026-04-10T12:06:00.000Z",
            }),
            createTimelineEventFixture({
              id: 4003,
              actorLogin: "octocat",
              event: "labeled",
              createdAt: "2026-04-10T12:07:00.000Z",
            }),
          ],
          fetchWorkflowRuns: async (_client, requestedPullRequest) => {
            fetchedWorkflowHeadSha = requestedPullRequest.lastSeenHeadSha;

            return [
              createWorkflowRunFixture({
                id: 5001,
                actorLogin: "octocat",
                headSha: "abc123",
                status: "completed",
                conclusion: "failure",
                updatedAt: "2026-04-10T12:08:00.000Z",
              }),
              createWorkflowRunFixture({
                id: 5002,
                actorLogin: "octocat",
                headSha: "abc123",
                status: "completed",
                conclusion: "success",
                updatedAt: "2026-04-10T12:09:00.000Z",
              }),
            ];
          },
        }),
      ).resolves.toEqual({
        processedCount: 8,
        insertedCount: 8,
        duplicateCount: 0,
      });

      const rawEvents = rawEventRepository.listRawEventsForPullRequest(pullRequest.id);

      expect(
        rawEvents.map((rawEvent) => ({
          source: rawEvent.source,
          sourceId: rawEvent.sourceId,
          eventType: rawEvent.eventType,
          actorLogin: rawEvent.actorLogin,
          occurredAt: rawEvent.occurredAt,
        })),
      ).toEqual([
        {
          source: "github_issue_comment",
          sourceId: "1001",
          eventType: "issue_comment",
          actorLogin: "alice",
          occurredAt: "2026-04-10T12:01:00.000Z",
        },
        {
          source: "github_pull_request_review",
          sourceId: "2001",
          eventType: "pull_request_review",
          actorLogin: "bob",
          occurredAt: "2026-04-10T12:02:00.000Z",
        },
        {
          source: "github_pull_request_review",
          sourceId: "2002",
          eventType: "pull_request_review",
          actorLogin: "carol",
          occurredAt: "2026-04-10T12:03:00.000Z",
        },
        {
          source: "github_pull_request_review_comment",
          sourceId: "3001",
          eventType: "pull_request_review_comment",
          actorLogin: "dave",
          occurredAt: "2026-04-10T12:04:00.000Z",
        },
        {
          source: "github_issue_timeline",
          sourceId: "4001",
          eventType: "closed",
          actorLogin: "octocat",
          occurredAt: "2026-04-10T12:05:00.000Z",
        },
        {
          source: "github_issue_timeline",
          sourceId: "4002",
          eventType: "ready_for_review",
          actorLogin: "octocat",
          occurredAt: "2026-04-10T12:06:00.000Z",
        },
        {
          source: "github_actions_workflow_run",
          sourceId: "5001:2026-04-10T12:08:00.000Z",
          eventType: "workflow_run",
          actorLogin: "octocat",
          occurredAt: "2026-04-10T12:08:00.000Z",
        },
        {
          source: "github_actions_workflow_run",
          sourceId: "5002:2026-04-10T12:09:00.000Z",
          eventType: "workflow_run",
          actorLogin: "octocat",
          occurredAt: "2026-04-10T12:09:00.000Z",
        },
      ]);

      expect(fetchedWorkflowHeadSha).toBe("abc123");
      expect(JSON.parse(rawEvents[0]?.payloadJson ?? "null")).toEqual(createIssueCommentFixture());
      expect(JSON.parse(rawEvents[6]?.payloadJson ?? "null")).toMatchObject({
        head_sha: "abc123",
        conclusion: "failure",
      });
      expect(JSON.parse(rawEvents[7]?.payloadJson ?? "null")).toMatchObject({
        head_sha: "abc123",
        conclusion: "success",
      });
    } finally {
      database.close();
    }
  });

  it("dedupes repeated ingestion and reuses comment fetch cursors", async () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    const issueCommentSinceValues: Array<string | undefined> = [];
    const reviewCommentSinceValues: Array<string | undefined> = [];

    try {
      await expect(
        ingestPullRequestActivity(database, { kind: "fake-client" }, pullRequest, {
          fetchIssueComments: async (_client, _pullRequest, since) => {
            issueCommentSinceValues.push(since);
            return [createIssueCommentFixture()];
          },
          fetchPullRequestReviews: async () => [],
          fetchPullRequestReviewComments: async (_client, _pullRequest, since) => {
            reviewCommentSinceValues.push(since);
            return [createReviewCommentFixture()];
          },
          fetchPullRequestTimeline: async () => [],
          fetchWorkflowRuns: async () => [],
        }),
      ).resolves.toEqual({
        processedCount: 2,
        insertedCount: 2,
        duplicateCount: 0,
      });

      await expect(
        ingestPullRequestActivity(database, { kind: "fake-client" }, pullRequest, {
          fetchIssueComments: async (_client, _pullRequest, since) => {
            issueCommentSinceValues.push(since);
            return [createIssueCommentFixture()];
          },
          fetchPullRequestReviews: async () => [],
          fetchPullRequestReviewComments: async (_client, _pullRequest, since) => {
            reviewCommentSinceValues.push(since);
            return [createReviewCommentFixture()];
          },
          fetchPullRequestTimeline: async () => [],
          fetchWorkflowRuns: async () => [],
        }),
      ).resolves.toEqual({
        processedCount: 2,
        insertedCount: 0,
        duplicateCount: 2,
      });

      expect(issueCommentSinceValues).toEqual([
        undefined,
        "2026-04-10T12:01:00.000Z",
      ]);
      expect(reviewCommentSinceValues).toEqual([
        undefined,
        "2026-04-10T12:04:00.000Z",
      ]);
      expect(
        readAppStateValue(
          database,
          `pull_request_activity_cursor:${pullRequest.id}:github_issue_comment`,
        ),
      ).toBe("2026-04-10T12:01:00.000Z");
      expect(
        readAppStateValue(
          database,
          `pull_request_activity_cursor:${pullRequest.id}:github_pull_request_review_comment`,
        ),
      ).toBe("2026-04-10T12:04:00.000Z");
      expect(rawEventRepository.listRawEventsForPullRequest(pullRequest.id)).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});

function createPullRequest(): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const homeDir = createTempDir("octopulse-pr-activity-home-");
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

function createIssueCommentFixture(): Record<string, unknown> {
  return {
    id: 1001,
    user: {
      login: "alice",
    },
    created_at: "2026-04-10T12:01:00.000Z",
    body: "Ship it",
    html_url: "https://github.com/acme/octopulse/pull/7#issuecomment-1001",
  };
}

function createReviewFixture(overrides: {
  id: number;
  actorLogin: string;
  state: string;
  submittedAt: string | null;
  body: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    user: {
      login: overrides.actorLogin,
    },
    state: overrides.state,
    submitted_at: overrides.submittedAt,
    body: overrides.body,
    html_url: `https://github.com/acme/octopulse/pull/7#pullrequestreview-${overrides.id}`,
  };
}

function createReviewCommentFixture(): Record<string, unknown> {
  return {
    id: 3001,
    user: {
      login: "dave",
    },
    created_at: "2026-04-10T12:04:00.000Z",
    body: "Inline note",
    path: "src/main.ts",
    html_url: "https://github.com/acme/octopulse/pull/7#discussion_r3001",
  };
}

function createTimelineEventFixture(overrides: {
  id: number;
  actorLogin: string;
  event: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    actor: {
      login: overrides.actorLogin,
    },
    event: overrides.event,
    created_at: overrides.createdAt,
  };
}

function createWorkflowRunFixture(overrides: {
  id: number;
  actorLogin: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    name: `CI run ${overrides.id}`,
    head_sha: overrides.headSha,
    status: overrides.status,
    conclusion: overrides.conclusion,
    actor: {
      login: overrides.actorLogin,
    },
    updated_at: overrides.updatedAt,
    created_at: overrides.updatedAt,
    html_url: `https://github.com/acme/octopulse/actions/runs/${overrides.id}`,
  };
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
    title: "Add pull request activity ingestion",
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

function readAppStateValue(
  database: ReturnType<typeof initializeDatabase>,
  key: string,
): string | undefined {
  const row = database.prepare("SELECT value FROM AppState WHERE key = ?").get(key);

  if (row === undefined || typeof row !== "object" || row === null) {
    return undefined;
  }

  const value = (row as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}
