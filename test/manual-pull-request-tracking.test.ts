import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscoveredPullRequest, PullRequestCoordinates } from "../src/authored-pull-request-discovery.js";
import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import {
  ManualPullRequestTrackingError,
  parseGitHubPullRequestUrl,
  trackPullRequestByUrl,
  untrackPullRequest,
} from "../src/manual-pull-request-tracking.js";
import {
  PullRequestRepository,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";

const OBSERVED_AT = "2026-04-10T12:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("parseGitHubPullRequestUrl", () => {
  it("parses github.com pull request URLs", () => {
    expect(
      parseGitHubPullRequestUrl("https://github.com/acme/octopulse/pull/7/?tab=files#discussion_r1"),
    ).toEqual({
      repositoryOwner: "acme",
      repositoryName: "octopulse",
      number: 7,
    });
  });

  it("rejects non-github.com pull request URLs", () => {
    expect(() => parseGitHubPullRequestUrl("https://example.com/acme/octopulse/pull/7")).toThrow(
      new ManualPullRequestTrackingError(
        "Manual tracking only supports github.com pull request URLs",
      ),
    );
  });
});

describe("trackPullRequestByUrl", () => {
  it("persists a manually tracked pull request from its URL", async () => {
    const { database, repository } = createRepository();
    const client = { kind: "fake-client" };
    const fetchPullRequestDetail = vi.fn(
      async (_client: typeof client, coordinates: PullRequestCoordinates) =>
        createDiscoveredPullRequest(coordinates),
    );

    try {
      await expect(
        trackPullRequestByUrl(
          database,
          {
            client,
            currentUserLogin: "octocat",
          },
          " https://github.com/acme/octopulse/pull/7 ",
          {
            pullRequestRepository: repository,
            fetchPullRequestDetail,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toMatchObject({
        outcome: "tracked",
        pullRequest: {
          githubPullRequestId: 101,
          isTracked: true,
          trackingReason: "manual",
          isStickyUntracked: false,
          lastSeenAt: OBSERVED_AT,
        },
      });

      expect(fetchPullRequestDetail).toHaveBeenCalledWith(client, {
        repositoryOwner: "acme",
        repositoryName: "octopulse",
        number: 7,
      });
      expect(repository.listTrackedPullRequests()).toHaveLength(1);
      expect(repository.listInactivePullRequests()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("clears sticky manual untrack when manually retracking an inactive pull request", async () => {
    const { database, repository } = createRepository();
    repository.upsertPullRequest(createPullRequestInput());
    repository.updatePullRequestTrackingState(101, {
      isTracked: false,
      trackingReason: "manual",
      isStickyUntracked: true,
    });

    try {
      await expect(
        trackPullRequestByUrl(
          database,
          {
            client: { kind: "fake-client" },
            currentUserLogin: "octocat",
          },
          "https://github.com/acme/octopulse/pull/7",
          {
            pullRequestRepository: repository,
            fetchPullRequestDetail: async (_client, coordinates) =>
              createDiscoveredPullRequest(coordinates, {
                title: "Refresh manual tracking metadata",
                lastSeenHeadSha: "def456",
              }),
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toMatchObject({
        outcome: "tracked",
        pullRequest: {
          githubPullRequestId: 101,
          title: "Refresh manual tracking metadata",
          isTracked: true,
          trackingReason: "manual",
          isStickyUntracked: false,
          lastSeenHeadSha: "def456",
          lastSeenAt: OBSERVED_AT,
        },
      });

      expect(repository.listTrackedPullRequests()).toHaveLength(1);
      expect(repository.listInactivePullRequests()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("returns a no-op result when the pull request is already tracked", async () => {
    const { database, repository } = createRepository();
    repository.upsertPullRequest(
      createPullRequestInput({
        title: "Persisted title",
        lastSeenAt: "2026-04-10T11:55:00.000Z",
      }),
    );

    try {
      await expect(
        trackPullRequestByUrl(
          database,
          {
            client: { kind: "fake-client" },
            currentUserLogin: "octocat",
          },
          "https://github.com/acme/octopulse/pull/7",
          {
            pullRequestRepository: repository,
            fetchPullRequestDetail: async (_client, coordinates) =>
              createDiscoveredPullRequest(coordinates, {
                title: "Fetched title that should not overwrite",
              }),
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toMatchObject({
        outcome: "already_tracked",
        pullRequest: {
          githubPullRequestId: 101,
          title: "Persisted title",
          trackingReason: "auto",
        },
      });

      const trackedPullRequests = repository.listTrackedPullRequests();
      expect(trackedPullRequests).toHaveLength(1);
      expect(trackedPullRequests[0]?.title).toBe("Persisted title");
      expect(trackedPullRequests[0]?.lastSeenAt).toBe("2026-04-10T11:55:00.000Z");
    } finally {
      database.close();
    }
  });
});

describe("untrackPullRequest", () => {
  it("marks a tracked pull request as inactive with sticky manual untrack state", async () => {
    const { database, repository } = createRepository();
    repository.upsertPullRequest(createPullRequestInput());

    try {
      await expect(
        untrackPullRequest(database, 101, {
          pullRequestRepository: repository,
        }),
      ).resolves.toMatchObject({
        outcome: "untracked",
        pullRequest: {
          githubPullRequestId: 101,
          isTracked: false,
          trackingReason: "manual",
          isStickyUntracked: true,
        },
      });

      expect(repository.listTrackedPullRequests()).toHaveLength(0);
      expect(repository.listInactivePullRequests()).toHaveLength(1);
      expect(repository.listInactivePullRequests()[0]?.githubPullRequestId).toBe(101);
    } finally {
      database.close();
    }
  });

  it("returns a no-op result when the pull request is already manually untracked", async () => {
    const { database, repository } = createRepository();
    repository.upsertPullRequest(createPullRequestInput());
    repository.updatePullRequestTrackingState(101, {
      isTracked: false,
      trackingReason: "manual",
      isStickyUntracked: true,
    });

    try {
      await expect(
        untrackPullRequest(database, 101, {
          pullRequestRepository: repository,
        }),
      ).resolves.toMatchObject({
        outcome: "already_untracked",
        pullRequest: {
          githubPullRequestId: 101,
          isTracked: false,
          trackingReason: "manual",
          isStickyUntracked: true,
        },
      });

      expect(repository.listTrackedPullRequests()).toHaveLength(0);
      expect(repository.listInactivePullRequests()).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-manual-tracking-home-");
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

function createDiscoveredPullRequest(
  coordinates: PullRequestCoordinates,
  overrides: Partial<DiscoveredPullRequest> = {},
): DiscoveredPullRequest {
  return {
    githubPullRequestId: 101,
    repositoryOwner: coordinates.repositoryOwner,
    repositoryName: coordinates.repositoryName,
    number: coordinates.number,
    url: `https://github.com/${coordinates.repositoryOwner}/${coordinates.repositoryName}/pull/${coordinates.number}`,
    authorLogin: "octocat",
    title: `Pull request ${coordinates.number}`,
    state: "open",
    isDraft: false,
    closedAt: null,
    mergedAt: null,
    lastSeenHeadSha: "abc123",
    ...overrides,
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
    title: "Add pull request polling",
    state: "open",
    isDraft: false,
    lastSeenAt: "2026-04-10T11:50:00.000Z",
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
