import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";
import { processTrackedPullRequestActivity } from "../src/tracked-pull-request-activity.js";
import {
  createIssueCommentFixture,
  createReviewFixture,
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
