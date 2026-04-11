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
  it("persists comment and review payload needed for later rules", () => {
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
        payloadJson: JSON.stringify(
          createIssueCommentPayload({
            id: 1001,
            actorLogin: "alice",
            actorType: "User",
            body: "Ship it",
            createdAt: "2026-04-10T12:01:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:01:00.000Z",
      }).rawEvent;
      const botIssueCommentRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_comment",
        sourceId: "1002",
        eventType: "issue_comment",
        actorLogin: "renovate[bot]",
        payloadJson: JSON.stringify(
          createIssueCommentPayload({
            id: 1002,
            actorLogin: "renovate[bot]",
            actorType: "Bot",
            body: "Automerge blocked until checks pass",
            createdAt: "2026-04-10T12:02:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:02:00.000Z",
      }).rawEvent;
      const reviewRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2001",
        eventType: "pull_request_review",
        actorLogin: "bob",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2001,
            actorLogin: "bob",
            actorType: "User",
            state: "APPROVED",
            body: "LGTM",
            submittedAt: "2026-04-10T12:03:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:03:00.000Z",
      }).rawEvent;
      const changesRequestedReviewRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2002",
        eventType: "pull_request_review",
        actorLogin: "carol",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2002,
            actorLogin: "carol",
            actorType: "User",
            state: "CHANGES_REQUESTED",
            body: "Need test coverage",
            submittedAt: "2026-04-10T12:04:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:04:00.000Z",
      }).rawEvent;
      const submittedReviewRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2003",
        eventType: "pull_request_review",
        actorLogin: "review-bot[bot]",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2003,
            actorLogin: "review-bot[bot]",
            actorType: "Bot",
            state: "COMMENTED",
            body: "Formatter suggests one change",
            submittedAt: "2026-04-10T12:05:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:05:00.000Z",
      }).rawEvent;
      const inlineCommentRawEvent = rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review_comment",
        sourceId: "3001",
        eventType: "pull_request_review_comment",
        actorLogin: "review-bot[bot]",
        payloadJson: JSON.stringify(
          createReviewCommentPayload({
            id: 3001,
            actorLogin: "review-bot[bot]",
            actorType: "Bot",
            reviewId: 2003,
            body: "Inline note",
            path: "src/main.ts",
            createdAt: "2026-04-10T12:06:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:06:00.000Z",
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
        occurredAt: "2026-04-10T12:07:00.000Z",
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
        occurredAt: "2026-04-10T12:08:00.000Z",
      });

      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 8,
        normalizedCount: 7,
        skippedCount: 1,
      });

      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          rawEventId: event.rawEventId,
          eventType: event.eventType,
          actorLogin: event.actorLogin,
          actorClass: event.actorClass,
          payload: parseNormalizedPayload(event.payloadJson),
        })),
      ).toEqual([
        {
          rawEventId: issueCommentRawEvent?.id ?? null,
          eventType: "issue_comment",
          actorLogin: "alice",
          actorClass: "human_other",
          payload: {
            commentId: 1001,
            bodyText: "Ship it",
            url: "https://github.com/acme/octopulse/pull/7#issuecomment-1001",
          },
        },
        {
          rawEventId: botIssueCommentRawEvent?.id ?? null,
          eventType: "issue_comment",
          actorLogin: "renovate[bot]",
          actorClass: "bot",
          payload: {
            commentId: 1002,
            bodyText: "Automerge blocked until checks pass",
            url: "https://github.com/acme/octopulse/pull/7#issuecomment-1002",
          },
        },
        {
          rawEventId: reviewRawEvent?.id ?? null,
          eventType: "review_approved",
          actorLogin: "bob",
          actorClass: "human_other",
          payload: {
            reviewId: 2001,
            reviewState: "APPROVED",
            bodyText: "LGTM",
            url: "https://github.com/acme/octopulse/pull/7#pullrequestreview-2001",
          },
        },
        {
          rawEventId: changesRequestedReviewRawEvent?.id ?? null,
          eventType: "review_changes_requested",
          actorLogin: "carol",
          actorClass: "human_other",
          payload: {
            reviewId: 2002,
            reviewState: "CHANGES_REQUESTED",
            bodyText: "Need test coverage",
            url: "https://github.com/acme/octopulse/pull/7#pullrequestreview-2002",
          },
        },
        {
          rawEventId: submittedReviewRawEvent?.id ?? null,
          eventType: "review_submitted",
          actorLogin: "review-bot[bot]",
          actorClass: "bot",
          payload: {
            reviewId: 2003,
            reviewState: "COMMENTED",
            bodyText: "Formatter suggests one change",
            url: "https://github.com/acme/octopulse/pull/7#pullrequestreview-2003",
          },
        },
        {
          rawEventId: inlineCommentRawEvent?.id ?? null,
          eventType: "review_inline_comment",
          actorLogin: "review-bot[bot]",
          actorClass: "bot",
          payload: {
            commentId: 3001,
            reviewId: 2003,
            inReplyToCommentId: null,
            bodyText: "Inline note",
            path: "src/main.ts",
            url: "https://github.com/acme/octopulse/pull/7#discussion_r3001",
          },
        },
        {
          rawEventId: timelineRawEvent?.id ?? null,
          eventType: "pr_merged",
          actorLogin: "octocat",
          actorClass: "self",
          payload: {},
        },
      ]);

      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 1,
        normalizedCount: 0,
        skippedCount: 1,
      });
      expect(normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id)).toHaveLength(7);
    } finally {
      database.close();
    }
  });

  it("maps pull request state changes and commit pushes from timeline activity", () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);

    try {
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "4101",
        eventType: "closed",
        actorLogin: "alice",
        payloadJson: JSON.stringify(
          createTimelineEventPayload({
            id: 4101,
            actorLogin: "alice",
            actorType: "User",
            event: "closed",
            createdAt: "2026-04-10T12:21:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:21:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "4102",
        eventType: "merged",
        actorLogin: "bob",
        payloadJson: JSON.stringify(
          createTimelineEventPayload({
            id: 4102,
            actorLogin: "bob",
            actorType: "User",
            event: "merged",
            createdAt: "2026-04-10T12:22:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:22:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "4103",
        eventType: "reopened",
        actorLogin: "carol",
        payloadJson: JSON.stringify(
          createTimelineEventPayload({
            id: 4103,
            actorLogin: "carol",
            actorType: "User",
            event: "reopened",
            createdAt: "2026-04-10T12:23:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:23:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "4104",
        eventType: "ready_for_review",
        actorLogin: "dave",
        payloadJson: JSON.stringify(
          createTimelineEventPayload({
            id: 4104,
            actorLogin: "dave",
            actorType: "User",
            event: "ready_for_review",
            createdAt: "2026-04-10T12:24:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:24:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "4105",
        eventType: "convert_to_draft",
        actorLogin: "erin",
        payloadJson: JSON.stringify(
          createTimelineEventPayload({
            id: 4105,
            actorLogin: "erin",
            actorType: "User",
            event: "convert_to_draft",
            createdAt: "2026-04-10T12:25:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:25:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_issue_timeline",
        sourceId: "feedface",
        eventType: "committed",
        actorLogin: "frank",
        payloadJson: JSON.stringify(
          createCommittedTimelinePayload({
            actorLogin: "frank",
            actorType: "User",
            sha: "feedface",
            message: "Refactor notification bundle\n\nTighten event grouping.",
            committedAt: "2026-04-10T12:26:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:26:00.000Z",
      });

      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 6,
        normalizedCount: 6,
        skippedCount: 0,
      });

      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          eventType: event.eventType,
          actorLogin: event.actorLogin,
          actorClass: event.actorClass,
          payload: parseNormalizedPayload(event.payloadJson),
        })),
      ).toEqual([
        {
          eventType: "pr_closed",
          actorLogin: "alice",
          actorClass: "human_other",
          payload: {},
        },
        {
          eventType: "pr_merged",
          actorLogin: "bob",
          actorClass: "human_other",
          payload: {},
        },
        {
          eventType: "pr_reopened",
          actorLogin: "carol",
          actorClass: "human_other",
          payload: {},
        },
        {
          eventType: "ready_for_review",
          actorLogin: "dave",
          actorClass: "human_other",
          payload: {},
        },
        {
          eventType: "converted_to_draft",
          actorLogin: "erin",
          actorClass: "human_other",
          payload: {},
        },
        {
          eventType: "commit_pushed",
          actorLogin: "frank",
          actorClass: "human_other",
          payload: {
            commitSha: "feedface",
            messageHeadline: "Refactor notification bundle",
            url: "https://github.com/acme/octopulse/commit/feedface",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("maps review states to normalized review event types", () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);

    try {
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2101",
        eventType: "pull_request_review",
        actorLogin: "alice",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2101,
            actorLogin: "alice",
            actorType: "User",
            state: "APPROVED",
            body: "Approved",
            submittedAt: "2026-04-10T12:11:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:11:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2102",
        eventType: "pull_request_review",
        actorLogin: "bob",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2102,
            actorLogin: "bob",
            actorType: "User",
            state: "CHANGES_REQUESTED",
            body: "Please revise",
            submittedAt: "2026-04-10T12:12:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:12:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2103",
        eventType: "pull_request_review",
        actorLogin: "carol",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2103,
            actorLogin: "carol",
            actorType: "User",
            state: "COMMENTED",
            body: "Question",
            submittedAt: "2026-04-10T12:13:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:13:00.000Z",
      });
      rawEventRepository.insertRawEvent({
        pullRequestId: pullRequest.id,
        source: "github_pull_request_review",
        sourceId: "2104",
        eventType: "pull_request_review",
        actorLogin: "dave",
        payloadJson: JSON.stringify(
          createReviewPayload({
            id: 2104,
            actorLogin: "dave",
            actorType: "User",
            state: "DISMISSED",
            body: "Dismissed after rebase",
            submittedAt: "2026-04-10T12:14:00.000Z",
          }),
        ),
        occurredAt: "2026-04-10T12:14:00.000Z",
      });

      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 4,
        normalizedCount: 4,
        skippedCount: 0,
      });

      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          eventType: event.eventType,
          reviewState: parseNormalizedPayload(event.payloadJson).reviewState,
        })),
      ).toEqual([
        {
          eventType: "review_approved",
          reviewState: "APPROVED",
        },
        {
          eventType: "review_changes_requested",
          reviewState: "CHANGES_REQUESTED",
        },
        {
          eventType: "review_submitted",
          reviewState: "COMMENTED",
        },
        {
          eventType: "review_submitted",
          reviewState: "DISMISSED",
        },
      ]);
    } finally {
      database.close();
    }
  });
});

function parseNormalizedPayload(payloadJson: string): Record<string, unknown> {
  return JSON.parse(payloadJson) as Record<string, unknown>;
}

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

function createIssueCommentPayload(overrides: {
  id: number;
  actorLogin: string;
  actorType: string;
  body: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    user: {
      login: overrides.actorLogin,
      type: overrides.actorType,
    },
    body: overrides.body,
    created_at: overrides.createdAt,
    html_url: `https://github.com/acme/octopulse/pull/7#issuecomment-${overrides.id}`,
  };
}

function createReviewPayload(overrides: {
  id: number;
  actorLogin: string;
  actorType: string;
  state: string;
  body: string;
  submittedAt: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    user: {
      login: overrides.actorLogin,
      type: overrides.actorType,
    },
    state: overrides.state,
    body: overrides.body,
    submitted_at: overrides.submittedAt,
    html_url: `https://github.com/acme/octopulse/pull/7#pullrequestreview-${overrides.id}`,
  };
}

function createReviewCommentPayload(overrides: {
  id: number;
  actorLogin: string;
  actorType: string;
  reviewId: number;
  body: string;
  path: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    user: {
      login: overrides.actorLogin,
      type: overrides.actorType,
    },
    pull_request_review_id: overrides.reviewId,
    body: overrides.body,
    path: overrides.path,
    created_at: overrides.createdAt,
    html_url: `https://github.com/acme/octopulse/pull/7#discussion_r${overrides.id}`,
  };
}

function createTimelineEventPayload(overrides: {
  id: number;
  actorLogin: string;
  actorType: string;
  event: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    actor: {
      login: overrides.actorLogin,
      type: overrides.actorType,
    },
    event: overrides.event,
    created_at: overrides.createdAt,
  };
}

function createCommittedTimelinePayload(overrides: {
  actorLogin: string;
  actorType: string;
  sha: string;
  message: string;
  committedAt: string;
}): Record<string, unknown> {
  return {
    event: "committed",
    sha: overrides.sha,
    node_id: `C_${overrides.sha}`,
    html_url: `https://github.com/acme/octopulse/commit/${overrides.sha}`,
    author: {
      login: overrides.actorLogin,
      type: overrides.actorType,
    },
    committer: {
      login: overrides.actorLogin,
      type: overrides.actorType,
    },
    commit: {
      message: overrides.message,
      author: {
        date: overrides.committedAt,
      },
      committer: {
        date: overrides.committedAt,
      },
    },
  };
}
