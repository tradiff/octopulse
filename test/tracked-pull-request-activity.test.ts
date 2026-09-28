import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverOpenAuthoredPullRequests } from "../src/authored-pull-request-discovery.js";
import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";
import { PullRequestReviewStateRepository } from "../src/pull-request-review-state-repository.js";
import { RawEventRepository } from "../src/raw-event-repository.js";
import { mapPullRequestSnapshot } from "../src/pull-request-snapshot.js";
import { processTrackedPullRequestActivity } from "../src/tracked-pull-request-activity.js";
import {
  createIssueCommentFixture,
  createReviewFixture,
  createTimelineEventFixture,
} from "./fixtures/github-pull-request-activity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("processTrackedPullRequestActivity", () => {
  it("owns the tracked pull request activity workflow behind one interface", async () => {
    const { database, pullRequest } = createPullRequest();
    const notificationRecordRepository = new NotificationRecordRepository(database);
    const notificationDispatcher = {
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      request: vi.fn(async (route: string, parameters?: Record<string, unknown>) => {
        switch (route) {
          case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
            expect(parameters).toMatchObject({
              owner: "acme",
              repo: "octopulse",
              pull_number: 7,
            });

            return createPullRequestDetailResponse();
          case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
            return {
              data: [
                createIssueCommentFixture({
                  id: 8101,
                  actorLogin: "alice",
                  createdAt: "2026-04-10T12:01:00.000Z",
                  body: "Need test coverage",
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
            return { data: [] };
          case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
            return { data: [] };
          case "GET /repos/{owner}/{repo}/actions/runs":
            return { data: { workflow_runs: [] } };
          default:
            throw new Error(`Unexpected GitHub route: ${route}`);
        }
      }),
    };

    try {
      await expect(
        processTrackedPullRequestActivity(database, client, pullRequest, {
          currentUserLogin: "octocat",
          notificationDispatcher,
          notificationDispatchedAt: "2026-04-10T12:03:00.000Z",
        }),
      ).resolves.toEqual({
        pullRequest: expect.objectContaining({
          id: pullRequest.id,
          title: "Refresh pull request polling",
          lastSeenHeadSha: "def456",
        }),
        skipActivityFanout: false,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledTimes(2);
      expect(notificationDispatcher.dispatchNotification).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          body: "bob: ✅ Looks good to me",
          sticky: true,
        }),
      );
      expect(notificationDispatcher.dispatchNotification).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          body: "alice: 💬 Need test coverage",
          sticky: true,
        }),
      );
      expect(notificationRecordRepository.listNotificationRecordsForPullRequest(pullRequest.id)).toEqual([
        expect.objectContaining({
          deliveryStatus: "sent",
          normalizedEventId: expect.any(Number),
          eventBundleId: null,
        }),
        expect.objectContaining({
          deliveryStatus: "sent",
          normalizedEventId: null,
          eventBundleId: expect.any(Number),
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("notifies the requested reviewer on an existing PR without replaying old or unrelated requests", async () => {
    const { database, pullRequest } = createPullRequest({ authorLogin: "wenottingham" });
    database.prepare("UPDATE AppState SET value = ? WHERE key = 'review_request_notifications_since'")
      .run("2026-04-10T12:00:00.000Z");
    const notificationDispatcher = { dispatchNotification: vi.fn().mockResolvedValue(undefined) };
    const reviewRequest = (id: number, reviewerLogin: string, createdAt: string) => ({
      ...createTimelineEventFixture({ id, actorLogin: "wenottingham", event: "review_requested", createdAt }),
      requested_reviewer: { login: reviewerLogin },
      requested_team: null,
    });
    const client = {
      request: vi.fn(async (route: string) => {
        switch (route) {
          case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
            return createPullRequestDetailResponse({ requestedReviewerLogins: ["tradiff"] });
          case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
            return {
              data: [createReviewFixture({
                actorLogin: "tradiff",
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-04-10T12:05:00.000Z",
              })],
            };
          case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
            return {
              data: [
                reviewRequest(4001, "tradiff", "2026-04-10T11:58:00.000Z"),
                reviewRequest(4002, "someone-else", "2026-04-10T12:07:00.000Z"),
                {
                  ...createTimelineEventFixture({
                    id: 4004,
                    actorLogin: "wenottingham",
                    event: "review_requested",
                    createdAt: "2026-04-10T12:08:00.000Z",
                  }),
                  requested_reviewer: null,
                  requested_team: { slug: "platform" },
                },
                reviewRequest(4003, "tradiff", "2026-04-10T12:10:00.000Z"),
              ],
            };
          case "GET /repos/{owner}/{repo}/actions/runs":
            return { data: { workflow_runs: [] } };
          case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
            return { data: [] };
          default:
            throw new Error(`Unexpected GitHub route: ${route}`);
        }
      }),
    };

    try {
      const options = {
        currentUserLogin: "tradiff",
        notificationDispatcher,
        notificationDispatchedAt: "2026-04-10T12:11:00.000Z",
      };
      await processTrackedPullRequestActivity(database, client, pullRequest, options);
      await processTrackedPullRequestActivity(database, client, pullRequest, options);

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledTimes(1);
      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({
        body: "wenottingham: 👀 review requested",
        sticky: true,
      }));
      expect(new PullRequestRepository(database).getPullRequestById(pullRequest.id)?.requestedReviewerLogins)
        .toEqual(["tradiff"]);
      expect(new PullRequestReviewStateRepository(database).listReviewStatesForPullRequest(pullRequest.id))
        .toEqual([expect.objectContaining({ reviewerLogin: "tradiff", reviewState: "CHANGES_REQUESTED" })]);
      expect(new RawEventRepository(database).listRawEventsForPullRequest(pullRequest.id)
        .filter((event) => event.eventType === "review_requested")).toHaveLength(4);
      expect(new NormalizedEventRepository(database).listNormalizedEventsForPullRequest(pullRequest.id)
        .filter((event) => event.eventType === "review_requested")
        .map((event) => ({ decisionState: event.decisionState, notificationTiming: event.notificationTiming })))
        .toEqual([
          { decisionState: "suppressed_rule", notificationTiming: null },
          { decisionState: "suppressed_rule", notificationTiming: null },
          { decisionState: "suppressed_rule", notificationTiming: null },
          { decisionState: "notified", notificationTiming: "immediate" },
        ]);
      expect(new NotificationRecordRepository(database).listNotificationRecordsForPullRequest(pullRequest.id))
        .toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("does not duplicate the first request notification sent by discovery", async () => {
    const { database, repository } = createRepository();
    database.prepare("UPDATE AppState SET value = ? WHERE key = 'review_request_notifications_since'")
      .run("2026-04-10T12:00:00.000Z");
    const notificationDispatcher = { dispatchNotification: vi.fn().mockResolvedValue(undefined) };
    const coordinates = { repositoryOwner: "acme", repositoryName: "octopulse", number: 7 };
    const detail = createPullRequestDetailResponse({ requestedReviewerLogins: ["tradiff"] });
    detail.data.user = { login: "wenottingham", avatar_url: null };

    try {
      await discoverOpenAuthoredPullRequests(database, { client: {}, currentUserLogin: "tradiff" }, {
        searchOpenAuthoredPullRequests: async () => [],
        searchOpenReviewRequestedPullRequests: async () => [coordinates],
        fetchPullRequestDetail: async () => mapPullRequestSnapshot(detail.data, coordinates, (message) => new Error(message)),
        observedAt: "2026-04-10T12:12:00.000Z",
        notificationDispatcher,
      });

      const pullRequest = repository.getPullRequestByGitHubPullRequestId(101)!;
      const timelineEvents = [{
        ...createTimelineEventFixture({
          actorLogin: "wenottingham",
          event: "review_requested",
          createdAt: "2026-04-10T12:10:00.000Z",
        }),
        requested_reviewer: { login: "tradiff" },
        requested_team: null,
      }];
      const client = {
        request: vi.fn(async (route: string) => {
          switch (route) {
            case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
              return detail;
            case "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline":
              return { data: timelineEvents };
            case "GET /repos/{owner}/{repo}/actions/runs":
              return { data: { workflow_runs: [] } };
            case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
            case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
            case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
              return { data: [] };
            default:
              throw new Error(`Unexpected GitHub route: ${route}`);
          }
        }),
      };

      await processTrackedPullRequestActivity(database, client, pullRequest, {
        currentUserLogin: "tradiff",
        notificationDispatcher,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledTimes(1);
      expect(new NormalizedEventRepository(database).listNormalizedEventsForPullRequest(pullRequest.id)
        .filter((event) => event.eventType === "review_requested")
        .map((event) => event.decisionState)).toEqual(["suppressed_rule", "notified"]);

      timelineEvents.push({
        ...createTimelineEventFixture({
          id: 4002,
          actorLogin: "wenottingham",
          event: "review_requested",
          createdAt: "2026-04-10T12:14:00.000Z",
        }),
        requested_reviewer: { login: "tradiff" },
        requested_team: null,
      });
      await processTrackedPullRequestActivity(database, client, pullRequest, {
        currentUserLogin: "tradiff",
        notificationDispatcher,
      });

      expect(notificationDispatcher.dispatchNotification).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-tracked-activity-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));

  return {
    database,
    repository: new PullRequestRepository(database),
  };
}

function createPullRequest(
  overrides: Partial<UpsertPullRequestInput> = {},
): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const { database, repository } = createRepository();

  return {
    database,
    pullRequest: repository.upsertPullRequest(createPullRequestInput(overrides)),
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
    authorAvatarUrl: "https://avatars.example.test/octocat.png",
    title: "Add notifications",
    state: "open",
    isDraft: false,
    lastSeenAt: "2026-04-10T11:55:00.000Z",
    closedAt: null,
    mergedAt: null,
    graceUntil: null,
    lastSeenHeadSha: "abc123",
    baseBranch: "main",
    mergeable: true,
    mergeableState: "clean",
    requestedReviewTeamSlugs: [],
    ...overrides,
  };
}

function createPullRequestDetailResponse(
  overrides: {
    status?: number;
    etag?: string | null;
    title?: string;
    state?: string;
    isDraft?: boolean;
    closedAt?: string | null;
    mergedAt?: string | null;
    headSha?: string | null;
    mergeable?: boolean | null;
    mergeableState?: string | null;
    requestedReviewerLogins?: string[];
    requestedReviewTeamSlugs?: string[];
  } = {},
): {
  status: number;
  headers: Record<string, string>;
  data: Record<string, unknown>;
} {
  return {
    status: overrides.status ?? 200,
    headers: overrides.etag ? { etag: overrides.etag } : {},
    data: {
      id: 101,
      number: 7,
      html_url: "https://github.com/acme/octopulse/pull/7",
      user: {
        login: "octocat",
        avatar_url: "https://avatars.example.test/octocat.png",
      },
      title: overrides.title ?? "Refresh pull request polling",
      state: overrides.state ?? "open",
      draft: overrides.isDraft ?? false,
      mergeable: overrides.mergeable ?? true,
      mergeable_state: overrides.mergeableState ?? "clean",
      closed_at: overrides.closedAt ?? null,
      merged_at: overrides.mergedAt ?? null,
      requested_reviewers: (overrides.requestedReviewerLogins ?? []).map((login) => ({ login })),
      requested_teams: (overrides.requestedReviewTeamSlugs ?? []).map((slug) => ({ slug })),
      head: {
        sha: overrides.headSha ?? "def456",
      },
      base: {
        ref: "main",
      },
    },
  };
}

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
