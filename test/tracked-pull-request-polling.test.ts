import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import {
  pollTrackedPullRequests,
  startRecurringTrackedPullRequestPolling,
} from "../src/tracked-pull-request-polling.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";

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
