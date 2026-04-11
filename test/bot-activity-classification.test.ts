import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  classifyBotPullRequestActivity,
  createOpenAiBotActivityClassifier,
} from "../src/bot-activity-classification.js";
import { resolveAppPaths } from "../src/config.js";
import { initializeDatabase } from "../src/database.js";
import { NormalizedEventRepository } from "../src/normalized-event-repository.js";
import {
  PullRequestRepository,
  type PullRequestRecord,
  type UpsertPullRequestInput,
} from "../src/pull-request-repository.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("classifyBotPullRequestActivity", () => {
  it("routes only bot comment and review text and persists AI decisions", async () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const classifier = vi.fn(async (text: string) =>
      text.includes("failed")
        ? {
            decision: "notify" as const,
            reason: "Bot reports failure needing human attention",
          }
        : {
            decision: "suppress" as const,
            reason: "Routine automation update",
          },
    );

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "alice",
        actorClass: "human_other",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "Human note" }),
        occurredAt: "2026-04-10T12:00:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "dependabot[bot]",
        actorClass: "bot",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "Bump deps from 1.0.0 to 1.1.0" }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_inline_comment",
        actorLogin: "ci-bot[bot]",
        actorClass: "bot",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "Build failed on ubuntu-latest" }),
        occurredAt: "2026-04-10T12:02:00.000Z",
      });
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "ci_failed",
        actorLogin: "github-actions[bot]",
        actorClass: "bot",
        decisionState: "notified",
        payloadJson: JSON.stringify({ workflowName: "CI" }),
        occurredAt: "2026-04-10T12:03:00.000Z",
      });

      await expect(
        classifyBotPullRequestActivity(database, pullRequest.id, {
          botActivityClassifier: classifier,
        }),
      ).resolves.toEqual({
        eligibleCount: 2,
        classifiedCount: 2,
        notifiedCount: 1,
        suppressedCount: 1,
        fallbackCount: 0,
      });

      expect(classifier).toHaveBeenCalledTimes(2);
      expect(classifier.mock.calls.map((call) => call[0])).toEqual([
        "Bump deps from 1.0.0 to 1.1.0",
        "Build failed on ubuntu-latest",
      ]);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          eventType: event.eventType,
          decisionState: event.decisionState,
          payload: parsePayload(event.payloadJson),
        })),
      ).toEqual([
        {
          eventType: "issue_comment",
          decisionState: "notified",
          payload: {
            bodyText: "Human note",
          },
        },
        {
          eventType: "issue_comment",
          decisionState: "suppressed_rule",
          payload: {
            bodyText: "Bump deps from 1.0.0 to 1.1.0",
            aiDecision: "suppress",
            aiReasoning: "Routine automation update",
          },
        },
        {
          eventType: "review_inline_comment",
          decisionState: "notified_ai",
          payload: {
            bodyText: "Build failed on ubuntu-latest",
            aiDecision: "notify",
            aiReasoning: "Bot reports failure needing human attention",
          },
        },
        {
          eventType: "ci_failed",
          decisionState: "notified",
          payload: {
            workflowName: "CI",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("marks bot activity for fallback notify when OpenAI is not configured", async () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "issue_comment",
        actorLogin: "dependabot[bot]",
        actorClass: "bot",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "Routine dependency bump" }),
        occurredAt: "2026-04-10T12:01:00.000Z",
      });

      await expect(
        classifyBotPullRequestActivity(database, pullRequest.id, {}),
      ).resolves.toEqual({
        eligibleCount: 1,
        classifiedCount: 0,
        notifiedCount: 1,
        suppressedCount: 0,
        fallbackCount: 1,
      });

      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          decisionState: event.decisionState,
          payload: parsePayload(event.payloadJson),
        })),
      ).toEqual([
        {
          decisionState: "notified_ai_fallback",
          payload: {
            bodyText: "Routine dependency bump",
            aiFallbackReason: "OpenAI classification unavailable: api key not configured",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("falls back to notify when AI classification fails", async () => {
    const { database, pullRequest } = createPullRequest();
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const classifier = vi.fn(async () => {
      throw new Error("request timed out");
    });

    try {
      normalizedEventRepository.insertNormalizedEvent({
        pullRequestId: pullRequest.id,
        eventType: "review_inline_comment",
        actorLogin: "ci-bot[bot]",
        actorClass: "bot",
        decisionState: "notified",
        payloadJson: JSON.stringify({ bodyText: "Build failed on ubuntu-latest" }),
        occurredAt: "2026-04-10T12:02:00.000Z",
      });

      await expect(
        classifyBotPullRequestActivity(database, pullRequest.id, {
          botActivityClassifier: classifier,
        }),
      ).resolves.toEqual({
        eligibleCount: 1,
        classifiedCount: 0,
        notifiedCount: 1,
        suppressedCount: 0,
        fallbackCount: 1,
      });

      expect(classifier).toHaveBeenCalledTimes(1);
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          decisionState: event.decisionState,
          payload: parsePayload(event.payloadJson),
        })),
      ).toEqual([
        {
          decisionState: "notified_ai_fallback",
          payload: {
            bodyText: "Build failed on ubuntu-latest",
            aiFallbackReason: "OpenAI classification failed: request timed out",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });
});

describe("createOpenAiBotActivityClassifier", () => {
  it("sends only bot text to OpenAI", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"decision":"notify","reason":"Needs attention"}',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });
    const classifier = createOpenAiBotActivityClassifier({
      apiKey: "test-key",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(classifier("Dependabot says tests are failing")).resolves.toEqual({
      decision: "notify",
      reason: "Needs attention",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: expect.any(String),
        },
        {
          role: "user",
          content: "Dependabot says tests are failing",
        },
      ],
    });
  });
});

function parsePayload(payloadJson: string): Record<string, unknown> {
  return JSON.parse(payloadJson) as Record<string, unknown>;
}

function createPullRequest(): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const homeDir = createTempDir("octopulse-bot-activity-classification-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));
  const repository = new PullRequestRepository(database);

  return {
    database,
    pullRequest: repository.upsertPullRequest(createPullRequestInput()),
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
    title: "Add bot activity classification",
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
