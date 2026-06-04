import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import { PullRequestCiJobStateRepository } from "../src/pull-request-ci-job-state-repository.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";
import { listPullRequestTimeline } from "../src/raw-events.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("listPullRequestTimeline", () => {
  it("omits redundant review-submitted entries while preserving top-level review comments", () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_submitted",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ reviewId: 42, bodyText: "   " }),
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_inline_comment",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ reviewId: 42, bodyText: "nit: rename this" }),
        occurredAt: "2026-04-10T12:00:15.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_submitted",
        actorLogin: "bob",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ reviewId: 84, bodyText: "Looks good overall" }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      });

      const result = listPullRequestTimeline(database);

      expect(result.timelineByPullRequest[String(pullRequest.githubPullRequestId)]).toEqual([
        {
          id: expect.any(Number),
          eventType: "review_submitted",
          occurredAt: "2026-04-10T12:01:00.000Z",
          paragraph: {
            actorLogin: "bob",
            actorAvatarKey: "bob",
            actorAvatarUrl: null,
            text: "💬 Looks good overall",
          },
        },
        {
          id: expect.any(Number),
          eventType: "review_inline_comment",
          occurredAt: "2026-04-10T12:00:15.000Z",
          paragraph: {
            actorLogin: "alice",
            actorAvatarKey: "alice",
            actorAvatarUrl: null,
            text: "💬 nit: rename this",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("returns only the latest ci job states for the current head sha", () => {
    const { database, pullRequest } = createPullRequest({ lastSeenHeadSha: "def456" });
    const ciJobStateRepository = new PullRequestCiJobStateRepository(database);

    try {
      ciJobStateRepository.upsertCiJobState({
        pullRequestId: pullRequest.id,
        workflowRunId: "5001",
        workflowRunName: "Build",
        workflowRunUpdatedAt: "2026-04-10T12:01:00.000Z",
        headSha: "abc123",
        jobId: "7001",
        jobName: "Artifactory / Promote",
        jobStatus: "in_progress",
        jobConclusion: null,
        isBlockingMerge: true,
      });
      ciJobStateRepository.upsertCiJobState({
        pullRequestId: pullRequest.id,
        workflowRunId: "5002",
        workflowRunName: "Build",
        workflowRunUpdatedAt: "2026-04-10T12:02:00.000Z",
        headSha: "def456",
        jobId: "7002",
        jobName: "Artifactory / Promote",
        jobStatus: "in_progress",
        jobConclusion: null,
        isBlockingMerge: true,
      });
      ciJobStateRepository.upsertCiJobState({
        pullRequestId: pullRequest.id,
        workflowRunId: "5003",
        workflowRunName: "Build",
        workflowRunUpdatedAt: "2026-04-10T12:03:00.000Z",
        headSha: "def456",
        jobId: "7003",
        jobName: "Artifactory / Promote",
        jobStatus: "completed",
        jobConclusion: "success",
        isBlockingMerge: true,
      });
      ciJobStateRepository.upsertCiJobState({
        pullRequestId: pullRequest.id,
        workflowRunId: "5004",
        workflowRunName: "Build",
        workflowRunUpdatedAt: "2026-04-10T12:02:30.000Z",
        headSha: "def456",
        jobId: "7004",
        jobName: "Test / Domain shared",
        jobStatus: "completed",
        jobConclusion: "success",
        isBlockingMerge: false,
      });

      const result = listPullRequestTimeline(database);
      const ciJobs = result.ciJobStatesByPullRequest[String(pullRequest.githubPullRequestId)] ?? [];

      expect(
        ciJobs.map((job) => ({
          workflowRunId: job.workflowRunId,
          workflowRunName: job.workflowRunName,
          headSha: job.headSha,
          jobName: job.jobName,
          jobStatus: job.jobStatus,
          jobConclusion: job.jobConclusion,
          isBlockingMerge: job.isBlockingMerge,
        })),
      ).toEqual([
        {
          workflowRunId: "5003",
          workflowRunName: "Build",
          headSha: "def456",
          jobName: "Artifactory / Promote",
          jobStatus: "completed",
          jobConclusion: "success",
          isBlockingMerge: true,
        },
        {
          workflowRunId: "5004",
          workflowRunName: "Build",
          headSha: "def456",
          jobName: "Test / Domain shared",
          jobStatus: "completed",
          jobConclusion: "success",
          isBlockingMerge: false,
        },
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
  const homeDir = createTempDir("octopulse-raw-events-home-");
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
    title: "Add notifications",
    state: "open",
    isDraft: false,
    lastSeenAt: "2026-04-10T12:00:00.000Z",
    lastSeenHeadSha: "abc123",
    ...overrides,
  };
}

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
