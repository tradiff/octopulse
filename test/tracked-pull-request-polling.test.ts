import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { EventBundleRepository } from "../src/event-bundling.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import {
  pollTrackedPullRequests,
  startRecurringTrackedPullRequestPolling,
} from "../src/tracked-pull-request-polling.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";
import { RawEventRepository } from "../src/raw-event-repository.js";
import {
  createIssueCommentFixture,
  createReviewCommentFixture,
  createReviewFixture,
  createTimelineEventFixture,
  createWorkflowRunFixture,
} from "./fixtures/github-pull-request-activity.js";

const POLLING_INTERVAL_MS = 60_000;
const OBSERVED_AT = "2026-04-10T12:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("pollTrackedPullRequests", () => {
  it("polls tracked pull requests and grace-period pull requests only", async () => {
    const { database, repository } = createRepository();
    const polledPullRequestIds: number[] = [];
    const pollPullRequest = vi.fn(async (_client: object, pullRequest: PullRequestRecord) => {
      polledPullRequestIds.push(pullRequest.githubPullRequestId);
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());
      repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 202,
          number: 8,
          url: "https://github.com/acme/octopulse/pull/8",
          title: "Poll merged pull requests during grace",
          state: "closed",
          closedAt: "2026-04-10T11:45:00.000Z",
          graceUntil: "2026-04-17T11:45:00.000Z",
          lastSeenHeadSha: "def456",
        }),
      );
      repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 303,
          number: 9,
          url: "https://github.com/acme/octopulse/pull/9",
          title: "Poll inactive grace-period pull requests",
          state: "closed",
          closedAt: "2026-04-10T11:30:00.000Z",
          graceUntil: "2026-04-17T11:30:00.000Z",
          tracking: {
            isTracked: false,
            trackingReason: "auto",
            isStickyUntracked: false,
          },
          lastSeenHeadSha: "ghi789",
        }),
      );
      repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 404,
          number: 10,
          url: "https://github.com/acme/octopulse/pull/10",
          title: "Skip expired grace-period pull requests",
          state: "closed",
          closedAt: "2026-04-01T11:30:00.000Z",
          graceUntil: "2026-04-08T11:30:00.000Z",
          tracking: {
            isTracked: false,
            trackingReason: "auto",
            isStickyUntracked: false,
          },
          lastSeenHeadSha: "jkl012",
        }),
      );
      repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 505,
          number: 11,
          url: "https://github.com/acme/octopulse/pull/11",
          title: "Skip sticky manually untracked pull requests",
          state: "closed",
          closedAt: "2026-04-10T11:15:00.000Z",
          graceUntil: "2026-04-17T11:15:00.000Z",
          tracking: {
            isTracked: false,
            trackingReason: "manual",
            isStickyUntracked: true,
          },
          lastSeenHeadSha: "mno345",
        }),
      );

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {},
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            pollPullRequest,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 3,
        polledCount: 3,
        failedCount: 0,
      });

      expect(polledPullRequestIds.sort((left, right) => left - right)).toEqual([101, 202, 303]);
    } finally {
      database.close();
    }
  });

  it("ingests raw pull request activity by default during polling", async () => {
    const { database, repository } = createRepository();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const request = vi.fn(async (route: string, parameters?: Record<string, unknown>) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return {
            data: [
              createIssueCommentFixture({
                id: 8101,
                actorLogin: "alice",
                createdAt: "2026-04-10T12:01:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              createReviewFixture({
                id: 8201,
                actorLogin: "bob",
                state: "APPROVED",
                submittedAt: "2026-04-10T12:02:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              createReviewCommentFixture({
                id: 8301,
                actorLogin: "carol",
                createdAt: "2026-04-10T12:03:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [
              createTimelineEventFixture({
                id: 8401,
                actorLogin: "octocat",
                event: "merged",
                createdAt: "2026-04-10T12:04:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          expect(parameters).toMatchObject({
            owner: "acme",
            repo: "octopulse",
            head_sha: "abc123",
          });

          return {
            data: {
              total_count: 2,
              workflow_runs: [
                createWorkflowRunFixture({
                  id: 8501,
                  actorLogin: "octocat",
                  actorType: "User",
                  headSha: "abc123",
                  status: "completed",
                  conclusion: "failure",
                  updatedAt: "2026-04-10T12:05:00.000Z",
                }),
                createWorkflowRunFixture({
                  id: 8502,
                  actorLogin: "octocat",
                  actorType: "User",
                  headSha: "abc123",
                  status: "completed",
                  conclusion: "success",
                  updatedAt: "2026-04-10T12:06:00.000Z",
                }),
              ],
            },
          };
        default:
          throw new Error(`Unexpected GitHub route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      expect(request).toHaveBeenCalledTimes(5);
      expect(request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/actions/runs",
        expect.objectContaining({
          owner: "acme",
          repo: "octopulse",
          head_sha: "abc123",
          page: 1,
          per_page: 100,
        }),
      );

      const pullRequest = repository.listTrackedPullRequests()[0];

      expect(pullRequest).toBeDefined();
      expect(
        rawEventRepository.listRawEventsForPullRequest(pullRequest?.id ?? -1).map((rawEvent) => ({
          source: rawEvent.source,
          sourceId: rawEvent.sourceId,
          eventType: rawEvent.eventType,
        })),
      ).toEqual([
        {
          source: "github_issue_comment",
          sourceId: "8101",
          eventType: "issue_comment",
        },
        {
          source: "github_pull_request_review",
          sourceId: "8201",
          eventType: "pull_request_review",
        },
        {
          source: "github_pull_request_review_comment",
          sourceId: "8301",
          eventType: "pull_request_review_comment",
        },
        {
          source: "github_issue_timeline",
          sourceId: "8401",
          eventType: "merged",
        },
        {
          source: "github_actions_workflow_run",
          sourceId: "8501:2026-04-10T12:05:00.000Z",
          eventType: "workflow_run",
        },
        {
          source: "github_actions_workflow_run",
          sourceId: "8502:2026-04-10T12:06:00.000Z",
          eventType: "workflow_run",
        },
      ]);
      expect(
        normalizedEventRepository
          .listNormalizedEventsForPullRequest(pullRequest?.id ?? -1)
          .map((event) => ({
            eventType: event.eventType,
            actorLogin: event.actorLogin,
            actorClass: event.actorClass,
            notificationTiming: event.notificationTiming,
          })),
      ).toEqual([
        {
          eventType: "issue_comment",
          actorLogin: "alice",
          actorClass: "human_other",
          notificationTiming: null,
        },
        {
          eventType: "review_approved",
          actorLogin: "bob",
          actorClass: "human_other",
          notificationTiming: "immediate",
        },
        {
          eventType: "review_inline_comment",
          actorLogin: "carol",
          actorClass: "human_other",
          notificationTiming: null,
        },
        {
          eventType: "pr_merged",
          actorLogin: "octocat",
          actorClass: "self",
          notificationTiming: null,
        },
        {
          eventType: "ci_failed",
          actorLogin: "octocat",
          actorClass: "self",
          notificationTiming: null,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("marks bot comments for fallback notify when no OpenAI classifier is configured", async () => {
    const { database, repository } = createRepository();
    const eventBundleRepository = new EventBundleRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const request = vi.fn(async (route: string) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return {
            data: [
              createIssueCommentFixture({
                id: 9701,
                actorLogin: "dependabot[bot]",
                actorType: "Bot",
                createdAt: "2026-04-10T12:10:00.000Z",
                body: "Routine dependency bump",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return { data: [] };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return { data: [] };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return { data: [] };
        case "GET /repos/{owner}/{repo}/actions/runs":
          return {
            data: {
              total_count: 0,
              workflow_runs: [],
            },
          };
        default:
          throw new Error(`Unexpected route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      const pullRequest = repository.listTrackedPullRequests()[0];
      const bundles = eventBundleRepository.listEventBundlesForPullRequest(pullRequest?.id ?? -1);

      expect(bundles).toHaveLength(1);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest?.id ?? -1).map((event) => ({
          eventType: event.eventType,
          decisionState: event.decisionState,
          eventBundleId: event.eventBundleId,
          payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
        })),
      ).toEqual([
        {
          eventType: "issue_comment",
          decisionState: "notified_ai_fallback",
          eventBundleId: bundles[0]?.id ?? null,
          payload: {
            commentId: 9701,
            bodyText: "Routine dependency bump",
            url: "https://github.com/acme/octopulse/pull/7#issuecomment-9701",
            aiFallbackReason: "OpenAI classification unavailable: api key not configured",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps repeated polling idempotent and reuses comment fetch cursors", async () => {
    const { database, repository } = createRepository();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const issueCommentSinceValues: Array<string | undefined> = [];
    const reviewCommentSinceValues: Array<string | undefined> = [];
    const request = vi.fn(async (route: string, parameters?: Record<string, unknown>) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments": {
          const since = typeof parameters?.since === "string" ? parameters.since : undefined;
          issueCommentSinceValues.push(since);

          return {
            data:
              since === undefined
                ? [
                    createIssueCommentFixture({
                      id: 9101,
                      actorLogin: "alice",
                      createdAt: "2026-04-10T12:11:00.000Z",
                    }),
                  ]
                : [],
          };
        }
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              createReviewFixture({
                id: 9201,
                actorLogin: "bob",
                state: "APPROVED",
                submittedAt: "2026-04-10T12:12:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": {
          const since = typeof parameters?.since === "string" ? parameters.since : undefined;
          reviewCommentSinceValues.push(since);

          return {
            data:
              since === undefined
                ? [
                    createReviewCommentFixture({
                      id: 9301,
                      actorLogin: "carol",
                      createdAt: "2026-04-10T12:13:00.000Z",
                    }),
                  ]
                : [],
          };
        }
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [
              createTimelineEventFixture({
                id: 9401,
                actorLogin: "octocat",
                event: "merged",
                createdAt: "2026-04-10T12:14:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          return {
            data: {
              total_count: 1,
              workflow_runs: [
                createWorkflowRunFixture({
                  id: 9501,
                  actorLogin: "octocat",
                  actorType: "User",
                  headSha: "abc123",
                  status: "completed",
                  conclusion: "success",
                  updatedAt: "2026-04-10T12:15:00.000Z",
                }),
              ],
            },
          };
        default:
          throw new Error(`Unexpected GitHub route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      expect(issueCommentSinceValues).toEqual([
        undefined,
        "2026-04-10T12:11:00.000Z",
      ]);
      expect(reviewCommentSinceValues).toEqual([
        undefined,
        "2026-04-10T12:13:00.000Z",
      ]);

      const pullRequest = repository.listTrackedPullRequests()[0];

      expect(pullRequest).toBeDefined();
      expect(
        rawEventRepository.listRawEventsForPullRequest(pullRequest?.id ?? -1).map((rawEvent) => ({
          source: rawEvent.source,
          sourceId: rawEvent.sourceId,
          eventType: rawEvent.eventType,
        })),
      ).toEqual([
        {
          source: "github_issue_comment",
          sourceId: "9101",
          eventType: "issue_comment",
        },
        {
          source: "github_pull_request_review",
          sourceId: "9201",
          eventType: "pull_request_review",
        },
        {
          source: "github_pull_request_review_comment",
          sourceId: "9301",
          eventType: "pull_request_review_comment",
        },
        {
          source: "github_issue_timeline",
          sourceId: "9401",
          eventType: "merged",
        },
        {
          source: "github_actions_workflow_run",
          sourceId: "9501:2026-04-10T12:15:00.000Z",
          eventType: "workflow_run",
        },
      ]);
      expect(
        normalizedEventRepository
          .listNormalizedEventsForPullRequest(pullRequest?.id ?? -1)
          .map((event) => ({
            eventType: event.eventType,
            actorLogin: event.actorLogin,
            actorClass: event.actorClass,
          })),
      ).toEqual([
        {
          eventType: "issue_comment",
          actorLogin: "alice",
          actorClass: "human_other",
        },
        {
          eventType: "review_approved",
          actorLogin: "bob",
          actorClass: "human_other",
        },
        {
          eventType: "review_inline_comment",
          actorLogin: "carol",
          actorClass: "human_other",
        },
        {
          eventType: "pr_merged",
          actorLogin: "octocat",
          actorClass: "self",
        },
        {
          eventType: "ci_succeeded",
          actorLogin: "octocat",
          actorClass: "self",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("bundles eligible pull request activity by default during polling", async () => {
    const { database, repository } = createRepository();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);
    const request = vi.fn(async (route: string, parameters?: Record<string, unknown>) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return {
            data: [
              createIssueCommentFixture({
                id: 9701,
                actorLogin: "alice",
                createdAt: "2026-04-10T12:31:00.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              createReviewFixture({
                id: 9702,
                actorLogin: "bob",
                state: "APPROVED",
                submittedAt: "2026-04-10T12:31:15.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              createReviewCommentFixture({
                id: 9703,
                actorLogin: "carol",
                createdAt: "2026-04-10T12:31:30.000Z",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          expect(parameters).toMatchObject({
            owner: "acme",
            repo: "octopulse",
            head_sha: "abc123",
          });

          return {
            data: {
              total_count: 1,
              workflow_runs: [
                createWorkflowRunFixture({
                  id: 9704,
                  actorLogin: "octocat",
                  actorType: "User",
                  headSha: "abc123",
                  status: "completed",
                  conclusion: "failure",
                  updatedAt: "2026-04-10T12:31:45.000Z",
                }),
              ],
            },
          };
        default:
          throw new Error(`Unexpected GitHub route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      const pullRequest = repository.listTrackedPullRequests()[0];
      const bundles = eventBundleRepository.listEventBundlesForPullRequest(pullRequest?.id ?? -1);

      expect(bundles).toHaveLength(1);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest?.id ?? -1).map((event) => ({
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
      expect(
        normalizedEventRepository.listNormalizedEventsForBundle(bundles[0]?.id ?? -1).map((event) => event.eventType),
      ).toEqual(["issue_comment", "review_inline_comment", "ci_failed"]);
    } finally {
      database.close();
    }
  });

  it("classifies bot comments and reviews before bundling", async () => {
    const { database, repository } = createRepository();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const eventBundleRepository = new EventBundleRepository(database);
    const botActivityClassifier = vi.fn(async (text: string) =>
      text.includes("failed")
        ? {
            decision: "notify" as const,
            reason: "Failure needs human attention",
          }
        : {
            decision: "suppress" as const,
            reason: "Routine bot update",
          },
    );
    const request = vi.fn(async (route: string) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return {
            data: [
              createIssueCommentFixture({
                id: 9801,
                actorLogin: "alice",
                createdAt: "2026-04-10T12:41:00.000Z",
                body: "Human update",
              }),
              createIssueCommentFixture({
                id: 9802,
                actorLogin: "dependabot[bot]",
                actorType: "Bot",
                createdAt: "2026-04-10T12:41:10.000Z",
                body: "Routine dependency bump",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              createReviewCommentFixture({
                id: 9803,
                actorLogin: "ci-bot[bot]",
                actorType: "Bot",
                createdAt: "2026-04-10T12:41:20.000Z",
                body: "Build failed on linux",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          return {
            data: {
              total_count: 0,
              workflow_runs: [],
            },
          };
        default:
          throw new Error(`Unexpected GitHub route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
            botActivityClassifier,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      const pullRequest = repository.listTrackedPullRequests()[0];
      const bundles = eventBundleRepository.listEventBundlesForPullRequest(pullRequest?.id ?? -1);

      expect(botActivityClassifier.mock.calls.map((call) => call[0])).toEqual([
        "Routine dependency bump",
        "Build failed on linux",
      ]);
      expect(bundles).toHaveLength(1);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest?.id ?? -1).map((event) => ({
          eventType: event.eventType,
          decisionState: event.decisionState,
          eventBundleId: event.eventBundleId,
          payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
        })),
      ).toEqual([
        {
          eventType: "issue_comment",
          decisionState: "notified",
          eventBundleId: bundles[0]?.id ?? null,
          payload: {
            commentId: 9801,
            bodyText: "Human update",
            url: "https://github.com/acme/octopulse/pull/7#issuecomment-9801",
          },
        },
        {
          eventType: "issue_comment",
          decisionState: "suppressed_rule",
          eventBundleId: null,
          payload: {
            commentId: 9802,
            bodyText: "Routine dependency bump",
            url: "https://github.com/acme/octopulse/pull/7#issuecomment-9802",
            aiDecision: "suppress",
            aiReasoning: "Routine bot update",
          },
        },
        {
          eventType: "review_inline_comment",
          decisionState: "notified_ai",
          eventBundleId: bundles[0]?.id ?? null,
          payload: {
            commentId: 9803,
            reviewId: null,
            inReplyToCommentId: null,
            bodyText: "Build failed on linux",
            path: "src/main.ts",
            url: "https://github.com/acme/octopulse/pull/7#discussion_r9803",
            aiDecision: "notify",
            aiReasoning: "Failure needs human attention",
          },
        },
      ]);
      expect(
        normalizedEventRepository.listNormalizedEventsForBundle(bundles[0]?.id ?? -1).map((event) => event.eventType),
      ).toEqual(["issue_comment", "review_inline_comment"]);
    } finally {
      database.close();
    }
  });

  it("dispatches immediate and ready bundled notification records during polling", async () => {
    const { database, repository } = createRepository();
    const notificationRecordRepository = new NotificationRecordRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };
    const request = vi.fn(async (route: string) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return {
            data: [
              createIssueCommentFixture({
                id: 9901,
                actorLogin: "alice",
                createdAt: "2026-04-10T12:00:00.000Z",
                body: "Please fix lint",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              createReviewFixture({
                id: 9902,
                actorLogin: "bob",
                state: "APPROVED",
                submittedAt: "2026-04-10T12:00:10.000Z",
                body: "LGTM",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              createReviewCommentFixture({
                id: 9903,
                actorLogin: "carol",
                createdAt: "2026-04-10T12:00:20.000Z",
                body: "Inline follow-up",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          return {
            data: {
              total_count: 0,
              workflow_runs: [],
            },
          };
        default:
          throw new Error(`Unexpected GitHub route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
            notificationPreparedAt: "2026-04-10T12:02:00.000Z",
            notificationDispatchedAt: "2026-04-10T12:02:05.000Z",
            notificationDispatcher,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      const pullRequest = repository.listTrackedPullRequests()[0];

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledTimes(2);
      expect(notificationRecordRepository.listNotificationRecordsForPullRequest(pullRequest?.id ?? -1)).toEqual([
        expect.objectContaining({
          normalizedEventId: expect.any(Number),
          eventBundleId: null,
          title: "acme/octopulse PR #7",
          body: "bob approved review\nAdd pull request polling",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "sent",
          deliveredAt: "2026-04-10T12:02:05.000Z",
        }),
        expect.objectContaining({
          normalizedEventId: null,
          eventBundleId: expect.any(Number),
          title: "acme/octopulse PR #7",
          body: "2 comments\nAdd pull request polling",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "sent",
          deliveredAt: "2026-04-10T12:02:05.000Z",
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("ignores comment and review edits during repeated polling", async () => {
    const { database, repository } = createRepository();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);
    let includeEditedBodies = false;
    const request = vi.fn(async (route: string) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return {
            data: [
              createIssueCommentFixture({
                id: 9601,
                actorLogin: "alice",
                createdAt: "2026-04-10T12:21:00.000Z",
                updatedAt: includeEditedBodies
                  ? "2026-04-10T12:25:00.000Z"
                  : "2026-04-10T12:21:00.000Z",
                body: includeEditedBodies ? "Ship it now" : "Ship it",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              createReviewFixture({
                id: 9602,
                actorLogin: "bob",
                state: "APPROVED",
                submittedAt: "2026-04-10T12:22:00.000Z",
                body: includeEditedBodies ? "Still looks great" : "Looks good",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              createReviewCommentFixture({
                id: 9603,
                actorLogin: "carol",
                createdAt: "2026-04-10T12:23:00.000Z",
                updatedAt: includeEditedBodies
                  ? "2026-04-10T12:26:00.000Z"
                  : "2026-04-10T12:23:00.000Z",
                body: includeEditedBodies ? "Inline note updated" : "Inline note",
                path: "src/main.ts",
              }),
            ],
          };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          return {
            data: {
              total_count: 0,
              workflow_runs: [],
            },
          };
        default:
          throw new Error(`Unexpected GitHub route: ${route}`);
      }
    });

    try {
      repository.upsertPullRequest(createPullRequestInput());

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      includeEditedBodies = true;

      await expect(
        pollTrackedPullRequests(
          database,
          {
            client: {
              request,
            },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        eligibleCount: 1,
        polledCount: 1,
        failedCount: 0,
      });

      const pullRequest = repository.listTrackedPullRequests()[0];

      expect(pullRequest).toBeDefined();
      expect(rawEventRepository.listRawEventsForPullRequest(pullRequest?.id ?? -1)).toHaveLength(3);
      expect(
        normalizedEventRepository
          .listNormalizedEventsForPullRequest(pullRequest?.id ?? -1)
          .map((event) => ({
            eventType: event.eventType,
            bodyText: (JSON.parse(event.payloadJson) as { bodyText?: string }).bodyText ?? null,
          })),
      ).toEqual([
        {
          eventType: "issue_comment",
          bodyText: "Ship it",
        },
        {
          eventType: "review_approved",
          bodyText: "Looks good",
        },
        {
          eventType: "review_inline_comment",
          bodyText: "Inline note",
        },
      ]);
    } finally {
      database.close();
    }
  });
});

describe("startRecurringTrackedPullRequestPolling", () => {
  it("runs tracked pull request polling on the configured interval", async () => {
    vi.useFakeTimers();

    const { database, repository } = createRepository();
    const polledPullRequestIds: number[] = [];
    const pollPullRequest = vi.fn(async (_client: object, pullRequest: PullRequestRecord) => {
      polledPullRequestIds.push(pullRequest.githubPullRequestId);
    });
    repository.upsertPullRequest(createPullRequestInput());

    const handle = startRecurringTrackedPullRequestPolling(
      database,
      {
        client: {},
        currentUserLogin: "octocat",
      },
      {
        intervalMs: POLLING_INTERVAL_MS,
        pullRequestRepository: repository,
        pollPullRequest,
      },
    );

    try {
      expect(pollPullRequest).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);

      expect(pollPullRequest).toHaveBeenCalledTimes(2);
      expect(polledPullRequestIds).toEqual([101, 101]);
    } finally {
      handle.stop();
      database.close();
    }
  });

  it("reports polling failures and continues on the next interval", async () => {
    vi.useFakeTimers();

    const { database, repository } = createRepository();
    const onError = vi.fn();
    let shouldFail = true;
    repository.upsertPullRequest(createPullRequestInput());

    const handle = startRecurringTrackedPullRequestPolling(
      database,
      {
        client: {},
        currentUserLogin: "octocat",
      },
      {
        intervalMs: POLLING_INTERVAL_MS,
        pullRequestRepository: repository,
        pollPullRequest: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("temporary GitHub outage");
          }
        },
        onError,
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({
        message: "Failed to poll pull request acme/octopulse#7: temporary GitHub outage",
      });

      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);

      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-tracked-pr-polling-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));

  return {
    database,
    repository: new PullRequestRepository(database),
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
    title: "Add pull request polling",
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
