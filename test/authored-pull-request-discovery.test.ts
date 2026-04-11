import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import {
  runFirstRunAuthoredPullRequestDiscovery,
  startRecurringAuthoredPullRequestDiscovery,
  type DiscoveredPullRequest,
  type PullRequestCoordinates,
} from "../src/authored-pull-request-discovery.js";
import {
  PullRequestRepository,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";

const FIRST_RUN_DISCOVERY_COMPLETED_KEY = "first_run_authored_pull_request_discovery_completed";
const DISCOVERY_INTERVAL_MS = 5 * 60_000;
const OBSERVED_AT = "2026-04-10T12:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("runFirstRunAuthoredPullRequestDiscovery", () => {
  it("persists discovered pull requests and records first-run completion", async () => {
    const { database, repository } = createRepository();
    const client = { kind: "fake-client" };
    const searchOpenAuthoredPullRequests = vi.fn(async () => [
      {
        repositoryOwner: "acme",
        repositoryName: "octopulse",
        number: 7,
      },
      {
        repositoryOwner: "widgets",
        repositoryName: "dashboard",
        number: 42,
      },
    ] satisfies PullRequestCoordinates[]);
    const fetchPullRequestDetail = vi.fn(
      async (_client: typeof client, coordinates: PullRequestCoordinates) =>
        createDiscoveredPullRequest(coordinates),
    );

    try {
      await expect(
        runFirstRunAuthoredPullRequestDiscovery(
          database,
          {
            client,
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            searchOpenAuthoredPullRequests,
            fetchPullRequestDetail,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        didRun: true,
        discoveredCount: 2,
      });

      expect(searchOpenAuthoredPullRequests).toHaveBeenCalledWith(client, "octocat");
      expect(fetchPullRequestDetail).toHaveBeenCalledTimes(2);

      const trackedPullRequests = repository
        .listTrackedPullRequests()
        .sort((left, right) => left.githubPullRequestId - right.githubPullRequestId);

      expect(trackedPullRequests).toHaveLength(2);
      expect(trackedPullRequests.map((pullRequest) => pullRequest.githubPullRequestId)).toEqual([
        101,
        4201,
      ]);
      expect(trackedPullRequests.every((pullRequest) => pullRequest.isTracked)).toBe(true);
      expect(
        trackedPullRequests.every((pullRequest) => pullRequest.isStickyUntracked === false),
      ).toBe(true);
      expect(trackedPullRequests.every((pullRequest) => pullRequest.trackingReason === "auto")).toBe(
        true,
      );
      expect(trackedPullRequests.every((pullRequest) => pullRequest.lastSeenAt === OBSERVED_AT)).toBe(
        true,
      );
      expect(readAppStateValue(database, FIRST_RUN_DISCOVERY_COMPLETED_KEY)).toBe("true");
    } finally {
      database.close();
    }
  });

  it("keeps sticky manual untrack state when discovery sees an existing pull request", async () => {
    const { database, repository } = createRepository();

    try {
      repository.upsertPullRequest(createPullRequestInput());
      repository.updatePullRequestTrackingState(101, {
        isTracked: false,
        trackingReason: "manual",
        isStickyUntracked: true,
      });

      await runFirstRunAuthoredPullRequestDiscovery(
        database,
        {
          client: { kind: "fake-client" },
          currentUserLogin: "octocat",
        },
        {
          pullRequestRepository: repository,
          searchOpenAuthoredPullRequests: async () => [
            {
              repositoryOwner: "acme",
              repositoryName: "octopulse",
              number: 7,
            },
          ],
          fetchPullRequestDetail: async (_client, coordinates) =>
            createDiscoveredPullRequest(coordinates, {
              title: "Refresh authored PR discovery",
              lastSeenHeadSha: "def456",
            }),
          observedAt: OBSERVED_AT,
        },
      );

      expect(repository.listTrackedPullRequests()).toHaveLength(0);

      const inactivePullRequests = repository.listInactivePullRequests();
      expect(inactivePullRequests).toHaveLength(1);
      expect(inactivePullRequests[0]?.githubPullRequestId).toBe(101);
      expect(inactivePullRequests[0]?.isTracked).toBe(false);
      expect(inactivePullRequests[0]?.trackingReason).toBe("manual");
      expect(inactivePullRequests[0]?.isStickyUntracked).toBe(true);
      expect(inactivePullRequests[0]?.title).toBe("Refresh authored PR discovery");
      expect(inactivePullRequests[0]?.lastSeenHeadSha).toBe("def456");
      expect(inactivePullRequests[0]?.lastSeenAt).toBe(OBSERVED_AT);
    } finally {
      database.close();
    }
  });

  it("skips discovery after first-run completion is already persisted", async () => {
    const { database, repository } = createRepository();
    const searchOpenAuthoredPullRequests = vi.fn(async () => [] as PullRequestCoordinates[]);
    const fetchPullRequestDetail = vi.fn();

    try {
      writeAppStateValue(database, FIRST_RUN_DISCOVERY_COMPLETED_KEY, "true");

      await expect(
        runFirstRunAuthoredPullRequestDiscovery(
          database,
          {
            client: { kind: "fake-client" },
            currentUserLogin: "octocat",
          },
          {
            pullRequestRepository: repository,
            searchOpenAuthoredPullRequests,
            fetchPullRequestDetail,
            observedAt: OBSERVED_AT,
          },
        ),
      ).resolves.toEqual({
        didRun: false,
        discoveredCount: 0,
      });

      expect(searchOpenAuthoredPullRequests).not.toHaveBeenCalled();
      expect(fetchPullRequestDetail).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});

describe("startRecurringAuthoredPullRequestDiscovery", () => {
  it("runs discovery on the configured interval and persists newly opened pull requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const { database, repository } = createRepository();
    const client = { kind: "fake-client" };
    let currentCoordinates: PullRequestCoordinates[] = [
      {
        repositoryOwner: "acme",
        repositoryName: "octopulse",
        number: 7,
      },
    ];
    const searchOpenAuthoredPullRequests = vi.fn(async () =>
      currentCoordinates.map((coordinates) => ({ ...coordinates })),
    );
    const fetchPullRequestDetail = vi.fn(
      async (_client: typeof client, coordinates: PullRequestCoordinates) =>
        createDiscoveredPullRequest(coordinates),
    );

    const handle = startRecurringAuthoredPullRequestDiscovery(
      database,
      {
        client,
        currentUserLogin: "octocat",
      },
      {
        intervalMs: DISCOVERY_INTERVAL_MS,
        pullRequestRepository: repository,
        searchOpenAuthoredPullRequests,
        fetchPullRequestDetail,
      },
    );

    try {
      expect(searchOpenAuthoredPullRequests).not.toHaveBeenCalled();
      expect(repository.listTrackedPullRequests()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      expect(searchOpenAuthoredPullRequests).toHaveBeenCalledTimes(1);
      expect(fetchPullRequestDetail).toHaveBeenCalledTimes(1);
      expect(repository.listTrackedPullRequests()).toHaveLength(1);
      expect(repository.listTrackedPullRequests()[0]?.githubPullRequestId).toBe(101);

      currentCoordinates = [
        {
          repositoryOwner: "acme",
          repositoryName: "octopulse",
          number: 7,
        },
        {
          repositoryOwner: "widgets",
          repositoryName: "dashboard",
          number: 42,
        },
      ];

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      const trackedPullRequests = repository
        .listTrackedPullRequests()
        .sort((left, right) => left.githubPullRequestId - right.githubPullRequestId);

      expect(searchOpenAuthoredPullRequests).toHaveBeenCalledTimes(2);
      expect(fetchPullRequestDetail).toHaveBeenCalledTimes(3);
      expect(trackedPullRequests).toHaveLength(2);
      expect(trackedPullRequests.map((pullRequest) => pullRequest.githubPullRequestId)).toEqual([
        101,
        4201,
      ]);
      expect(trackedPullRequests.every((pullRequest) => pullRequest.lastSeenAt === "2026-04-10T12:10:00.000Z")).toBe(true);
    } finally {
      handle.stop();
      database.close();
    }
  });

  it("keeps sticky manual untrack state during recurring discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const { database, repository } = createRepository();
    repository.upsertPullRequest(createPullRequestInput());
    repository.updatePullRequestTrackingState(101, {
      isTracked: false,
      trackingReason: "manual",
      isStickyUntracked: true,
    });

    const handle = startRecurringAuthoredPullRequestDiscovery(
      database,
      {
        client: { kind: "fake-client" },
        currentUserLogin: "octocat",
      },
      {
        intervalMs: DISCOVERY_INTERVAL_MS,
        pullRequestRepository: repository,
        searchOpenAuthoredPullRequests: async () => [
          {
            repositoryOwner: "acme",
            repositoryName: "octopulse",
            number: 7,
          },
        ],
        fetchPullRequestDetail: async (_client, coordinates) =>
          createDiscoveredPullRequest(coordinates, {
            title: "Refresh recurring authored PR discovery",
            lastSeenHeadSha: "def456",
          }),
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      expect(repository.listTrackedPullRequests()).toHaveLength(0);

      const inactivePullRequests = repository.listInactivePullRequests();
      expect(inactivePullRequests).toHaveLength(1);
      expect(inactivePullRequests[0]?.githubPullRequestId).toBe(101);
      expect(inactivePullRequests[0]?.isTracked).toBe(false);
      expect(inactivePullRequests[0]?.trackingReason).toBe("manual");
      expect(inactivePullRequests[0]?.isStickyUntracked).toBe(true);
      expect(inactivePullRequests[0]?.title).toBe("Refresh recurring authored PR discovery");
      expect(inactivePullRequests[0]?.lastSeenHeadSha).toBe("def456");
      expect(inactivePullRequests[0]?.lastSeenAt).toBe("2026-04-10T12:05:00.000Z");
    } finally {
      handle.stop();
      database.close();
    }
  });

  it("reports recurring discovery failures and continues on the next interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const { database, repository } = createRepository();
    const onError = vi.fn();
    let shouldFail = true;

    const handle = startRecurringAuthoredPullRequestDiscovery(
      database,
      {
        client: { kind: "fake-client" },
        currentUserLogin: "octocat",
      },
      {
        intervalMs: DISCOVERY_INTERVAL_MS,
        pullRequestRepository: repository,
        searchOpenAuthoredPullRequests: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("temporary GitHub outage");
          }

          return [
            {
              repositoryOwner: "acme",
              repositoryName: "octopulse",
              number: 7,
            },
          ];
        },
        fetchPullRequestDetail: async (_client, coordinates) => createDiscoveredPullRequest(coordinates),
        onError,
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({
        message: "Failed to discover open authored pull requests: temporary GitHub outage",
      });
      expect(repository.listTrackedPullRequests()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(DISCOVERY_INTERVAL_MS);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(repository.listTrackedPullRequests()).toHaveLength(1);
      expect(repository.listTrackedPullRequests()[0]?.githubPullRequestId).toBe(101);
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
  const homeDir = createTempDir("octopulse-first-run-discovery-home-");
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
  const githubPullRequestId = coordinates.number === 42 ? 4201 : 101;

  return {
    githubPullRequestId,
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
    lastSeenHeadSha: coordinates.number === 42 ? "xyz789" : "abc123",
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

  if (row?.value === undefined) {
    return undefined;
  }

  return String(row.value);
}

function writeAppStateValue(
  database: ReturnType<typeof initializeDatabase>,
  key: string,
  value: string,
): void {
  database.prepare("INSERT INTO AppState (key, value) VALUES (?, ?)").run(key, value);
}
