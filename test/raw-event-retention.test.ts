import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import { NotificationRecordRepository } from "../src/notification-record-repository.js";
import { listNotificationHistory } from "../src/notification-history.js";
import { normalizePullRequestActivity } from "../src/pull-request-activity-normalization.js";
import { PullRequestRepository, type PullRequestRecord } from "../src/pull-request-repository.js";
import { RawEventRepository } from "../src/raw-event-repository.js";
import { pruneRawEventPayloads } from "../src/raw-event-retention.js";
import { listPullRequestTimeline } from "../src/raw-events.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const NOW = "2026-05-01T12:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("raw event payload retention", () => {
  it("prunes only payloads older than the retention boundary while preserving UI history", () => {
    const { database, pullRequest } = createPullRequest();
    const rawEventRepository = new RawEventRepository(database);
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const notificationRecordRepository = new NotificationRecordRepository(database);

    try {
      const oldComment = insertRawEvent(rawEventRepository, pullRequest.id, {
        sourceId: "old-comment",
        eventType: "issue_comment",
        occurredAt: "2026-04-01T11:59:59.999Z",
        payloadJson: JSON.stringify({ id: 1, body: "Keep this normalized comment" }),
      });
      const oldWorkflowRun = insertRawEvent(rawEventRepository, pullRequest.id, {
        sourceId: "workflow:1",
        eventType: "workflow_run",
        occurredAt: "2026-04-01T11:59:59.999Z",
        payloadJson: JSON.stringify({
          id: 1,
          head_sha: "abc123",
          status: "completed",
          conclusion: "success",
          name: "CI",
          html_url: "https://github.com/acme/octopulse/actions/runs/1",
          actor: { type: "Bot", avatar_url: "https://avatars.example.test/actions.png" },
          largeUnusedField: "x".repeat(10_000),
        }),
      });
      insertRawEvent(rawEventRepository, pullRequest.id, {
        sourceId: "old-unnormalized",
        eventType: "committed",
        occurredAt: "2026-04-01T11:59:59.999Z",
        payloadJson: JSON.stringify({ sha: "old" }),
      });
      const boundaryComment = insertRawEvent(rawEventRepository, pullRequest.id, {
        sourceId: "boundary-comment",
        eventType: "issue_comment",
        occurredAt: "2026-04-01T12:00:00.000Z",
        payloadJson: JSON.stringify({ id: 2, body: "Keep full payload at boundary" }),
      });
      const recentComment = insertRawEvent(rawEventRepository, pullRequest.id, {
        sourceId: "recent-comment",
        eventType: "issue_comment",
        occurredAt: "2026-04-02T12:00:00.000Z",
        payloadJson: JSON.stringify({ id: 3, body: "Keep recent full payload" }),
      });
      const normalizedEvent = normalizedEventRepository.insertNormalizedEvent({
        rawEventId: oldComment.id,
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "Keep this normalized comment" }),
        occurredAt: oldComment.occurredAt,
      });
      notificationRecordRepository.createNotificationRecord({
        normalizedEventId: normalizedEvent.id,
        pullRequestId: pullRequest.id,
        title: "alice commented",
        body: "Keep this normalized comment",
      });

      expect(pruneRawEventPayloads(database, RETENTION_MS, NOW)).toBe(3);

      const rawPayloads = database
        .prepare("SELECT source_id, payload_json FROM RawEvent ORDER BY id")
        .all()
        .map((row) => ({
          sourceId: String(row.source_id),
          payloadJson: String(row.payload_json),
        }));

      expect(JSON.parse(rawPayloads[0]!.payloadJson)).toEqual({ octopulse_payload_pruned: true });
      const compactedWorkflowPayload = JSON.parse(rawPayloads[1]!.payloadJson);
      expect(compactedWorkflowPayload).toMatchObject({
        _octopulse_compacted: 1,
        id: 1,
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        name: "CI",
      });
      expect(compactedWorkflowPayload).not.toHaveProperty("largeUnusedField");
      expect(JSON.parse(rawPayloads[2]!.payloadJson)).toEqual({ octopulse_payload_pruned: true });
      expect(rawPayloads[3]!.payloadJson).toBe(boundaryComment.payloadJson);
      expect(rawPayloads[4]!.payloadJson).toBe(recentComment.payloadJson);
      expect(
        rawEventRepository
          .listUnnormalizedRawEventsForPullRequest(pullRequest.id)
          .map((rawEvent) => rawEvent.sourceId),
      ).toEqual([oldWorkflowRun.sourceId, boundaryComment.sourceId, recentComment.sourceId]);
      expect(normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id)).toHaveLength(1);
      expect(listPullRequestTimeline(database).timelineByPullRequest[String(pullRequest.githubPullRequestId)])
        .toMatchObject([
          {
            eventType: "issue_comment",
            paragraph: { text: "💬 Keep this normalized comment" },
          },
        ]);
      expect(listNotificationHistory(database).entries).toMatchObject([
        { title: "alice commented", body: "Keep this normalized comment" },
      ]);
      expect(normalizePullRequestActivity(database, pullRequest, "octocat")).toEqual({
        processedCount: 3,
        normalizedCount: 3,
        skippedCount: 0,
      });

      expect(pruneRawEventPayloads(database, RETENTION_MS, NOW)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("reclaims database space when compaction follows pruning", () => {
    const homeDir = createTempDir("octopulse-retention-home-");
    const paths = resolveAppPaths({ homeDir });
    const database = initializeDatabase(paths);
    const pullRequest = new PullRequestRepository(database).upsertPullRequest(createPullRequestInput());
    const rawEventRepository = new RawEventRepository(database);

    try {
      insertRawEvent(rawEventRepository, pullRequest.id, {
        sourceId: "large-old-comment",
        eventType: "issue_comment",
        occurredAt: "2026-04-01T11:59:59.999Z",
        payloadJson: JSON.stringify({ body: "x".repeat(2_000_000) }),
      });
      const sizeBefore = statSync(paths.databasePath).size;

      expect(pruneRawEventPayloads(database, RETENTION_MS, NOW)).toBe(1);
      database.exec("VACUUM");

      expect(statSync(paths.databasePath).size).toBeLessThan(sizeBefore);
    } finally {
      database.close();
    }
  });
});

function createPullRequest(): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const homeDir = createTempDir("octopulse-retention-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));

  return {
    database,
    pullRequest: new PullRequestRepository(database).upsertPullRequest(createPullRequestInput()),
  };
}

function createPullRequestInput() {
  return {
    githubPullRequestId: 101,
    repositoryOwner: "acme",
    repositoryName: "octopulse",
    number: 7,
    url: "https://github.com/acme/octopulse/pull/7",
    authorLogin: "octocat",
    title: "Add retention",
    state: "open",
    isDraft: false,
    lastSeenAt: "2026-04-01T12:00:00.000Z",
    lastSeenHeadSha: "abc123",
  };
}

function insertRawEvent(
  repository: RawEventRepository,
  pullRequestId: number,
  input: { sourceId: string; eventType: string; occurredAt: string; payloadJson: string },
) {
  const result = repository.insertRawEvent({
    pullRequestId,
    source: "test",
    sourceId: input.sourceId,
    eventType: input.eventType,
    actorLogin: "alice",
    payloadJson: input.payloadJson,
    occurredAt: input.occurredAt,
  });

  if (result.rawEvent === undefined) {
    throw new Error(`Expected inserted raw event ${input.sourceId}`);
  }

  return result.rawEvent;
}

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
