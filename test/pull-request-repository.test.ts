import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import {
  PullRequestRepository,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("PullRequestRepository", () => {
  it("upserts pull requests while preserving sticky tracking state by default", () => {
    const { database, repository } = createRepository();

    try {
      const inserted = repository.upsertPullRequest(createPullRequestInput());

      expect(inserted.githubPullRequestId).toBe(101);
      expect(inserted.isTracked).toBe(true);
      expect(inserted.trackingReason).toBe("auto");
      expect(inserted.isStickyUntracked).toBe(false);
      expect(inserted.graceUntil).toBeNull();
      expect(inserted.lastSeenHeadSha).toBe("abc123");

      repository.updatePullRequestTrackingState(101, {
        isTracked: false,
        trackingReason: "manual",
        isStickyUntracked: true,
      });

      const updated = repository.upsertPullRequest(
        createPullRequestInput({
          title: "Close polling gaps",
          state: "closed",
          isDraft: true,
          closedAt: "2026-04-10T12:30:00.000Z",
          graceUntil: "2026-04-17T12:30:00.000Z",
          lastSeenHeadSha: null,
        }),
      );

      expect(updated.id).toBe(inserted.id);
      expect(updated.title).toBe("Close polling gaps");
      expect(updated.state).toBe("closed");
      expect(updated.isDraft).toBe(true);
      expect(updated.closedAt).toBe("2026-04-10T12:30:00.000Z");
      expect(updated.graceUntil).toBe("2026-04-17T12:30:00.000Z");
      expect(updated.lastSeenHeadSha).toBeNull();
      expect(updated.isTracked).toBe(false);
      expect(updated.trackingReason).toBe("manual");
      expect(updated.isStickyUntracked).toBe(true);
    } finally {
      database.close();
    }
  });

  it("lists tracked and inactive pull requests separately", () => {
    const { database, repository } = createRepository();

    try {
      repository.upsertPullRequest(createPullRequestInput());
      repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 202,
          number: 8,
          url: "https://github.com/acme/octopulse/pull/8",
          title: "Track review digests",
          lastSeenHeadSha: "def456",
        }),
      );
      repository.upsertPullRequest(
        createPullRequestInput({
          githubPullRequestId: 303,
          number: 9,
          url: "https://github.com/acme/octopulse/pull/9",
          title: "Archive inactive pull requests",
          lastSeenHeadSha: "ghi789",
        }),
      );

      repository.updatePullRequestTrackingState(202, {
        isTracked: false,
        trackingReason: "manual",
        isStickyUntracked: true,
      });

      expect(
        repository
          .listTrackedPullRequests()
          .map((pullRequest) => pullRequest.githubPullRequestId)
          .sort((left, right) => left - right),
      ).toEqual([101, 303]);
      expect(
        repository
          .listInactivePullRequests()
          .map((pullRequest) => pullRequest.githubPullRequestId)
          .sort((left, right) => left - right),
      ).toEqual([202]);
    } finally {
      database.close();
    }
  });

  it("updates sticky manual untrack state and clears it on manual retrack", () => {
    const { database, repository } = createRepository();

    try {
      repository.upsertPullRequest(createPullRequestInput());

      const manuallyUntracked = repository.updatePullRequestTrackingState(101, {
        isTracked: false,
        trackingReason: "manual",
        isStickyUntracked: true,
      });

      expect(manuallyUntracked.isTracked).toBe(false);
      expect(manuallyUntracked.trackingReason).toBe("manual");
      expect(manuallyUntracked.isStickyUntracked).toBe(true);
      expect(repository.listInactivePullRequests()).toHaveLength(1);

      const manuallyRetracked = repository.updatePullRequestTrackingState(101, {
        isTracked: true,
        trackingReason: "manual",
        isStickyUntracked: false,
      });

      expect(manuallyRetracked.isTracked).toBe(true);
      expect(manuallyRetracked.trackingReason).toBe("manual");
      expect(manuallyRetracked.isStickyUntracked).toBe(false);
      expect(repository.listInactivePullRequests()).toHaveLength(0);
      expect(repository.listTrackedPullRequests()).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

function createRepository(): {
  database: ReturnType<typeof initializeDatabase>;
  repository: PullRequestRepository;
} {
  const homeDir = createTempDir("octopulse-pr-repo-home-");
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
    lastSeenAt: "2026-04-10T12:00:00.000Z",
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
