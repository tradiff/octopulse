import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
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
              {
                id: 8101,
                user: {
                  login: "alice",
                },
                created_at: "2026-04-10T12:01:00.000Z",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              {
                id: 8201,
                user: {
                  login: "bob",
                },
                state: "APPROVED",
                submitted_at: "2026-04-10T12:02:00.000Z",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              {
                id: 8301,
                user: {
                  login: "carol",
                },
                created_at: "2026-04-10T12:03:00.000Z",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [
              {
                id: 8401,
                actor: {
                  login: "octocat",
                },
                event: "merged",
                created_at: "2026-04-10T12:04:00.000Z",
              },
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
                {
                  id: 8501,
                  head_sha: "abc123",
                  actor: {
                    login: "octocat",
                  },
                  status: "completed",
                  conclusion: "failure",
                  updated_at: "2026-04-10T12:05:00.000Z",
                },
                {
                  id: 8502,
                  head_sha: "abc123",
                  actor: {
                    login: "octocat",
                  },
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-04-10T12:06:00.000Z",
                },
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
                    {
                      id: 9101,
                      user: {
                        login: "alice",
                      },
                      created_at: "2026-04-10T12:11:00.000Z",
                    },
                  ]
                : [],
          };
        }
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              {
                id: 9201,
                user: {
                  login: "bob",
                },
                state: "APPROVED",
                submitted_at: "2026-04-10T12:12:00.000Z",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": {
          const since = typeof parameters?.since === "string" ? parameters.since : undefined;
          reviewCommentSinceValues.push(since);

          return {
            data:
              since === undefined
                ? [
                    {
                      id: 9301,
                      user: {
                        login: "carol",
                      },
                      created_at: "2026-04-10T12:13:00.000Z",
                    },
                  ]
                : [],
          };
        }
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
          return {
            data: [
              {
                id: 9401,
                actor: {
                  login: "octocat",
                },
                event: "merged",
                created_at: "2026-04-10T12:14:00.000Z",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/actions/runs":
          return {
            data: {
              total_count: 1,
              workflow_runs: [
                {
                  id: 9501,
                  head_sha: "abc123",
                  actor: {
                    login: "octocat",
                  },
                  status: "completed",
                  conclusion: "success",
                  updated_at: "2026-04-10T12:15:00.000Z",
                },
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
              {
                id: 9601,
                user: {
                  login: "alice",
                },
                created_at: "2026-04-10T12:21:00.000Z",
                updated_at: includeEditedBodies
                  ? "2026-04-10T12:25:00.000Z"
                  : "2026-04-10T12:21:00.000Z",
                body: includeEditedBodies ? "Ship it now" : "Ship it",
                html_url: "https://github.com/acme/octopulse/pull/7#issuecomment-9601",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return {
            data: [
              {
                id: 9602,
                user: {
                  login: "bob",
                },
                state: "APPROVED",
                submitted_at: "2026-04-10T12:22:00.000Z",
                body: includeEditedBodies ? "Still looks great" : "Looks good",
                html_url: "https://github.com/acme/octopulse/pull/7#pullrequestreview-9602",
              },
            ],
          };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
          return {
            data: [
              {
                id: 9603,
                user: {
                  login: "carol",
                },
                created_at: "2026-04-10T12:23:00.000Z",
                updated_at: includeEditedBodies
                  ? "2026-04-10T12:26:00.000Z"
                  : "2026-04-10T12:23:00.000Z",
                body: includeEditedBodies ? "Inline note updated" : "Inline note",
                path: "src/main.ts",
                html_url: "https://github.com/acme/octopulse/pull/7#discussion_r9603",
              },
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
