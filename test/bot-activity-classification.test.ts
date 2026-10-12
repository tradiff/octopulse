import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  classifyBotPullRequestActivity,
  createSystemOneBotActivityClassifier,
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

  it("suppresses bot comments on other people's pull requests without calling System One", async () => {
    const { database, pullRequest } = createPullRequest({ authorLogin: "alice" });
    const normalizedEventRepository = new NormalizedEventRepository(database);
    const classifier = vi.fn(async () => ({
      decision: "notify" as const,
      reason: "Needs attention",
    }));

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
          currentUserLogin: "octocat",
          pullRequestAuthorLogin: pullRequest.authorLogin,
        }),
      ).resolves.toEqual({
        eligibleCount: 2,
        classifiedCount: 0,
        notifiedCount: 0,
        suppressedCount: 2,
        fallbackCount: 0,
      });

      expect(classifier).not.toHaveBeenCalled();
      expect(
        normalizedEventRepository.listNormalizedEventsForPullRequest(pullRequest.id).map((event) => ({
          eventType: event.eventType,
          decisionState: event.decisionState,
          payload: parsePayload(event.payloadJson),
        })),
      ).toEqual([
        {
          eventType: "issue_comment",
          decisionState: "suppressed_rule",
          payload: {
            bodyText: "Routine dependency bump",
          },
        },
        {
          eventType: "review_inline_comment",
          decisionState: "suppressed_rule",
          payload: {
            bodyText: "Build failed on ubuntu-latest",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("marks bot activity for fallback notify when System One is not configured", async () => {
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
            aiFallbackReason: "System One classification unavailable: provider not configured",
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
            aiFallbackReason: "System One classification failed: request timed out",
          },
        },
      ]);
    } finally {
      database.close();
    }
  });
});

describe("createSystemOneBotActivityClassifier", () => {
  it.each([
    "https://openrouter.ai/api",
    "https://openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1/",
  ])("sends only bot text as state using base URL %s", async (baseUrl) => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return Response.json({
        model: "typesafe/jev-1.13",
        answers: {
          notification: {
            type: "choice",
            choice: "notify",
            probabilities: { notify: 0.95, suppress: 0.05 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.0000042 },
      });
    });
    const classifier = createSystemOneBotActivityClassifier({
      baseUrl,
      apiKey: " test-key ",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(classifier("Dependabot says tests are failing")).resolves.toEqual({
      decision: "notify",
      reason: "System One selected notify (probability: 0.95, confidence: 0.9).",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/systemone", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer test-key", "Content-Type": "application/json" }),
      signal: expect.any(AbortSignal),
    }));
    expect(requestBody).toEqual({
      model: "jev-latest",
      state: "Dependabot says tests are failing",
      questions: {
        notification: {
          type: "choice",
          instructions: expect.stringContaining("warrants user attention"),
          criteria: {
            notify: expect.stringContaining("failing Sonar quality gate"),
            suppress: expect.stringContaining("successful Sonar or CI results"),
          },
        },
      },
    });
  });

  it("supports another compatible provider and a model override", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      answers: {
        notification: {
          type: "choice", choice: "suppress",
          probabilities: { notify: 0.1, suppress: 0.9 }, confidence: 0.8,
        },
      },
    }));
    const classifier = createSystemOneBotActivityClassifier({
      baseUrl: "https://api.typesafe.ai", apiKey: "other-key",
      model: "jev-1.13.0", fetch: fetchImpl as typeof fetch,
    });
    await expect(classifier("LGTM")).resolves.toEqual({
      decision: "suppress",
      reason: "System One selected suppress (probability: 0.9, confidence: 0.8).",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({
      body: expect.stringContaining('"model":"jev-1.13.0"'),
    }));
  });

  it.each([
    null, {}, { answers: [] }, { answers: { notification: {} } },
    { answers: { notification: { type: "noul", noul: 0.9 } } },
    { answers: { notification: { type: "choice", choice: "other" } } },
    ...[
      { probabilities: undefined },
      { probabilities: { notify: "0.9", suppress: 0.1 } },
      { probabilities: { notify: 1.1, suppress: -0.1 } },
      { probabilities: { notify: 0.9, suppress: 0.9 } },
      { confidence: undefined }, { confidence: 2 },
    ].map((override) => ({ answers: { notification: {
      type: "choice", choice: "notify", probabilities: { notify: 0.9, suppress: 0.1 },
      confidence: 0.8, ...override,
    } } })),
  ])("rejects malformed provider responses: %j", async (body) => {
    const classifier = createSystemOneBotActivityClassifier({
      baseUrl: "https://provider.example/v1", apiKey: "test-key",
      fetch: vi.fn(async () => Response.json(body)) as typeof fetch,
    });
    await expect(classifier("Bot text")).rejects.toThrow("System One response");
  });

  it.each([401, 429, 500])("rejects HTTP status %i without exposing secrets", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("secret-key", { status }));
    const classifier = createSystemOneBotActivityClassifier({
      baseUrl: "https://provider.example/v1", apiKey: "secret-key",
      fetch: fetchImpl as typeof fetch,
    });
    await expect(classifier("Bot text")).rejects.toThrow(`System One request failed with status ${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON", async () => {
    const classifier = createSystemOneBotActivityClassifier({
      baseUrl: "https://provider.example/v1", apiKey: "test-key",
      fetch: vi.fn(async () => new Response("not JSON")) as typeof fetch,
    });
    await expect(classifier("Bot text")).rejects.toThrow("System One response must be an object");
  });

  it("wraps transport failures and applies the timeout override", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing abort signal");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return Response.json({});
    });
    const classifier = createSystemOneBotActivityClassifier({
      baseUrl: "http://localhost:8080/v1", apiKey: "test-key", timeoutMs: 5,
      fetch: fetchImpl as typeof fetch,
    });
    await expect(classifier("Bot text")).rejects.toThrow("System One request failed:");
  });

  it.each([
    { apiKey: " " }, { model: " " }, { baseUrl: "not a URL" },
    { baseUrl: "ftp://provider.example" }, { baseUrl: "https://user:secret@provider.example" },
    { baseUrl: "https://provider.example?key=secret" }, { baseUrl: "https://provider.example#fragment" },
  ])("rejects invalid provider options: %j", (override) => {
    expect(() => createSystemOneBotActivityClassifier({
      baseUrl: "https://provider.example/v1", apiKey: "test-key", ...override,
    })).toThrow("System One");
  });
});

function parsePayload(payloadJson: string): Record<string, unknown> {
  return JSON.parse(payloadJson) as Record<string, unknown>;
}

function createPullRequest(): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
}

function createPullRequest(overrides: Partial<UpsertPullRequestInput>): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
}

function createPullRequest(overrides: Partial<UpsertPullRequestInput> = {}): {
  database: ReturnType<typeof initializeDatabase>;
  pullRequest: PullRequestRecord;
} {
  const homeDir = createTempDir("octopulse-bot-activity-classification-home-");
  const database = initializeDatabase(resolveAppPaths({ homeDir }));
  const repository = new PullRequestRepository(database);

  return {
    database,
    pullRequest: repository.upsertPullRequest(createPullRequestInput(overrides)),
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
