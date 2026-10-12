import { DatabaseSync } from "node:sqlite";

import { APIError, choice, TypeSafeClient } from "@typesafe-ai/sdk";

import {
  NormalizedEventRepository,
  type DecisionState,
  type NormalizedEventRecord,
} from "./normalized-event-repository.js";
import { DEFAULT_SYSTEM_ONE_MODEL, normalizeSystemOneBaseUrl } from "./system-one.js";

const DEFAULT_SYSTEM_ONE_TIMEOUT_MS = 10_000;
const SYSTEM_ONE_CLASSIFICATION_CRITERIA = {
  notify: "The message is negative, blocking, or action-oriented: asking for a change, requesting follow-up, reporting a failure, saying something is broken, rejected, or blocked, or otherwise needs human intervention, including a failing Sonar quality gate.",
  suppress: "The message is positive, approving, or purely informational: LGTM, approval, praise, all checks passing, successful Sonar or CI results, Jira ticket creation or links.",
};

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

export type BotActivityAiDecision = "notify" | "suppress";

export interface BotActivityAiClassification {
  decision: BotActivityAiDecision;
  reason: string;
}

export type BotActivityClassifier = (
  text: string,
) => Promise<BotActivityAiClassification> | BotActivityAiClassification;

export interface ClassifyBotPullRequestActivityOptions {
  botActivityClassifier?: BotActivityClassifier;
  currentUserLogin?: string;
  pullRequestAuthorLogin?: string;
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "listAiEligibleUnbundledEventsForPullRequest" | "updateNormalizedEventDecision"
  >;
}

export interface ClassifyBotPullRequestActivityResult {
  eligibleCount: number;
  classifiedCount: number;
  notifiedCount: number;
  suppressedCount: number;
  fallbackCount: number;
}

export interface CreateSystemOneBotActivityClassifierOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class BotActivityClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotActivityClassificationError";
  }
}

export async function classifyBotPullRequestActivity(
  database: DatabaseSync,
  pullRequestId: number,
  options: ClassifyBotPullRequestActivityOptions,
): Promise<ClassifyBotPullRequestActivityResult> {
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);

  let eligibleEvents: NormalizedEventRecord[];

  try {
    eligibleEvents = normalizedEventRepository.listAiEligibleUnbundledEventsForPullRequest(
      pullRequestId,
    );
  } catch (error) {
    throw new BotActivityClassificationError(
      `Failed to load AI-eligible normalized events for pull request ${pullRequestId}: ${getErrorMessage(error)}`,
    );
  }

  let classifiedCount = 0;
  let notifiedCount = 0;
  let suppressedCount = 0;
  let fallbackCount = 0;
  const suppressBotActivityForNonAuthoredPullRequest =
    shouldSuppressBotActivityForNonAuthoredPullRequest(options);

  for (const event of eligibleEvents) {
    if (suppressBotActivityForNonAuthoredPullRequest) {
      persistSuppressedDecision(normalizedEventRepository, event);
      suppressedCount += 1;
      continue;
    }

    const payload = parseNormalizedPayload(event);
    const bodyText = readBodyText(payload);

    if (bodyText === null || bodyText.trim().length === 0) {
      continue;
    }

    if (!options.botActivityClassifier) {
      persistFallbackDecision(normalizedEventRepository, event, payload, {
        reason: "System One classification unavailable: provider not configured",
      });
      fallbackCount += 1;
      notifiedCount += 1;
      continue;
    }

    let classification: BotActivityAiClassification;

    try {
      classification = await options.botActivityClassifier(bodyText);
    } catch (error) {
      persistFallbackDecision(normalizedEventRepository, event, payload, {
        reason: `System One classification failed: ${getErrorMessage(error)}`,
      });
      fallbackCount += 1;
      notifiedCount += 1;
      continue;
    }

    const decisionState = mapAiDecisionToDecisionState(classification.decision);
    const payloadJson = serializePayload(event, {
      ...payload,
      aiDecision: classification.decision,
      aiReasoning: classification.reason,
    });

    try {
      normalizedEventRepository.updateNormalizedEventDecision(event.id, {
        decisionState,
        payloadJson,
      });
    } catch (error) {
      throw new BotActivityClassificationError(
        `Failed to persist AI decision for normalized event ${event.id}: ${getErrorMessage(error)}`,
      );
    }

    classifiedCount += 1;

    if (decisionState === "notified_ai") {
      notifiedCount += 1;
    } else {
      suppressedCount += 1;
    }
  }

  return {
    eligibleCount: eligibleEvents.length,
    classifiedCount,
    notifiedCount,
    suppressedCount,
    fallbackCount,
  };
}

export function createSystemOneBotActivityClassifier(
  options: CreateSystemOneBotActivityClassifierOptions,
): BotActivityClassifier {
  const apiKey = options.apiKey.trim();

  if (apiKey.length === 0) {
    throw new BotActivityClassificationError("System One api key must be a non-empty string");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const model = (options.model ?? DEFAULT_SYSTEM_ONE_MODEL).trim();
  if (model.length === 0) {
    throw new BotActivityClassificationError("System One model must be a non-empty string");
  }
  let client: TypeSafeClient;
  try {
    client = new TypeSafeClient({
      apiKey,
      baseURL: normalizeSystemOneBaseUrl(options.baseUrl),
      defaultModel: model,
      timeout: options.timeoutMs ?? DEFAULT_SYSTEM_ONE_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      logLevel: "off",
      fetch: (input, init) => fetchImpl(input, { ...init, redirect: "error" }),
    });
  } catch (error) {
    throw new BotActivityClassificationError(getErrorMessage(error));
  }

  return async (text: string): Promise<BotActivityAiClassification> => {
    let responseBody: unknown;

    try {
      responseBody = await client.systemOne({
        state: text,
        questions: {
          notification: choice(
            "Decide whether this automated pull request comment warrants user attention.",
            SYSTEM_ONE_CLASSIFICATION_CRITERIA,
          ),
        },
      });
    } catch (error) {
      if (error instanceof APIError && error.status !== undefined) {
        throw new BotActivityClassificationError(
          `System One request failed with status ${error.status}`,
        );
      }
      throw new BotActivityClassificationError(
        `System One request failed: ${getErrorMessage(error)}`,
      );
    }

    return parseSystemOneClassificationResponse(responseBody);
  };
}

function mapAiDecisionToDecisionState(decision: BotActivityAiDecision): DecisionState {
  return decision === "notify" ? "notified_ai" : "suppressed_rule";
}

function parseNormalizedPayload(event: Pick<NormalizedEventRecord, "id" | "payloadJson">): JsonObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(event.payloadJson) as unknown;
  } catch (error) {
    throw new BotActivityClassificationError(
      `Normalized event ${event.id} payload must be valid JSON: ${getErrorMessage(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BotActivityClassificationError(`Normalized event ${event.id} payload must be an object`);
  }

  return parsed as JsonObject;
}

function readBodyText(payload: JsonObject): string | null {
  const bodyText = payload.bodyText;
  return typeof bodyText === "string" ? bodyText : null;
}

function serializePayload(
  event: Pick<NormalizedEventRecord, "id">,
  payload: JsonObject,
): string {
  try {
    const payloadJson = JSON.stringify(payload);

    if (payloadJson === undefined) {
      throw new Error("Normalized payload must be serializable JSON");
    }

    return payloadJson;
  } catch (error) {
    throw new BotActivityClassificationError(
      `Failed to serialize normalized payload for event ${event.id}: ${getErrorMessage(error)}`,
    );
  }
}

function persistSuppressedDecision(
  normalizedEventRepository: Pick<NormalizedEventRepository, "updateNormalizedEventDecision">,
  event: Pick<NormalizedEventRecord, "id" | "payloadJson">,
): void {
  try {
    normalizedEventRepository.updateNormalizedEventDecision(event.id, {
      decisionState: "suppressed_rule",
      payloadJson: event.payloadJson,
    });
  } catch (error) {
    throw new BotActivityClassificationError(
      `Failed to persist suppression decision for normalized event ${event.id}: ${getErrorMessage(error)}`,
    );
  }
}

function persistFallbackDecision(
  normalizedEventRepository: Pick<NormalizedEventRepository, "updateNormalizedEventDecision">,
  event: Pick<NormalizedEventRecord, "id">,
  payload: JsonObject,
  input: { reason: string },
): void {
  const payloadJson = serializePayload(event, {
    ...payload,
    aiFallbackReason: input.reason,
  });

  try {
    normalizedEventRepository.updateNormalizedEventDecision(event.id, {
      decisionState: "notified_ai_fallback",
      payloadJson,
    });
  } catch (error) {
    throw new BotActivityClassificationError(
      `Failed to persist AI fallback decision for normalized event ${event.id}: ${getErrorMessage(error)}`,
    );
  }
}

function parseSystemOneClassificationResponse(responseBody: unknown): BotActivityAiClassification {
  const response = requireObject(responseBody, "System One response");
  const answers = requireObject(response.answers, "System One response answers");
  const answer = requireObject(answers.notification, "System One response answers.notification");
  const decision = answer.choice;

  if (answer.type !== "choice" || (decision !== "notify" && decision !== "suppress")) {
    throw new BotActivityClassificationError('System One response must include a notify or suppress Choice answer');
  }

  const probabilities = requireObject(answer.probabilities, "System One response probabilities");
  const notify = requireProbability(probabilities.notify, "notify probability");
  const suppress = requireProbability(probabilities.suppress, "suppress probability");
  const confidence = requireProbability(answer.confidence, "confidence");
  if (Math.abs(notify + suppress - 1) > 0.001) {
    throw new BotActivityClassificationError("System One response probabilities must sum to 1");
  }

  return {
    decision,
    reason: `System One selected ${decision} (probability: ${probabilities[decision]}, confidence: ${confidence}).`,
  };
}

function requireProbability(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BotActivityClassificationError(`System One response ${field} must be a number between 0 and 1`);
  }
  return value;
}

function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BotActivityClassificationError(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function shouldSuppressBotActivityForNonAuthoredPullRequest(
  options: Pick<ClassifyBotPullRequestActivityOptions, "currentUserLogin" | "pullRequestAuthorLogin">,
): boolean {
  if (!options.currentUserLogin || !options.pullRequestAuthorLogin) {
    return false;
  }

  return normalizeLogin(options.currentUserLogin) !== normalizeLogin(options.pullRequestAuthorLogin);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
