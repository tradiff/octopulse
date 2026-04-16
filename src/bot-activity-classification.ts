import { DatabaseSync } from "node:sqlite";

import {
  NormalizedEventRepository,
  type DecisionState,
  type NormalizedEventRecord,
} from "./normalized-event-repository.js";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_TIMEOUT_MS = 10_000;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_CLASSIFICATION_PROMPT = [
  "You classify automated pull request comments.",
  "Your job is to decide whether the comment warrants user attention.",
  "Notify when the message is negative, blocking, or action-oriented,",
  "such as asking for a change, requesting follow-up, reporting a failure,",
  "saying something is broken, rejected, blocked,",
  "or otherwise needs human intervention,",
  "including a failing Sonar quality gate.",
  "Suppress when the message is positive, approving, or purely informational,",
  "such as LGTM, approval, praise, all checks passing,",
  "successful Sonar or CI results,",
  "Jira ticket creation or links",
  'Reply with strict JSON only: {"decision":"notify"|"suppress","reason":"short explanation"}.',
].join(" ");

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

export interface CreateOpenAiBotActivityClassifierOptions {
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
        reason: "OpenAI classification unavailable: api key not configured",
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
        reason: `OpenAI classification failed: ${getErrorMessage(error)}`,
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

export function createOpenAiBotActivityClassifier(
  options: CreateOpenAiBotActivityClassifierOptions,
): BotActivityClassifier {
  const apiKey = options.apiKey.trim();

  if (apiKey.length === 0) {
    throw new BotActivityClassificationError("OpenAI api key must be a non-empty string");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;

  return async (text: string): Promise<BotActivityAiClassification> => {
    let response: Response;

    try {
      response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: OPENAI_CLASSIFICATION_PROMPT,
            },
            {
              role: "user",
              content: text,
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BotActivityClassificationError(
        `OpenAI request failed: ${getErrorMessage(error)}`,
      );
    }

    if (!response.ok) {
      throw new BotActivityClassificationError(
        `OpenAI request failed with status ${response.status}`,
      );
    }

    let responseBody: unknown;

    try {
      responseBody = (await response.json()) as unknown;
    } catch (error) {
      throw new BotActivityClassificationError(
        `OpenAI response was not valid JSON: ${getErrorMessage(error)}`,
      );
    }

    return parseOpenAiClassificationResponse(responseBody);
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

function parseOpenAiClassificationResponse(responseBody: unknown): BotActivityAiClassification {
  const content = readOpenAiMessageContent(responseBody);
  return parseOpenAiClassificationContent(content);
}

function readOpenAiMessageContent(responseBody: unknown): string {
  const responseObject = requireObject(responseBody, "OpenAI response");
  const choices = responseObject.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new BotActivityClassificationError("OpenAI response must include at least one choice");
  }

  const firstChoice = requireObject(choices[0], "OpenAI response choice");
  const message = requireObject(firstChoice.message, "OpenAI response choice.message");
  const content = message.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content.flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) {
        return [];
      }

      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    });

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  throw new BotActivityClassificationError("OpenAI response message content must be a non-empty string");
}

function parseOpenAiClassificationContent(content: string): BotActivityAiClassification {
  const parsed = extractJsonObject(content);
  const decision = parsed.decision;
  const reason = parsed.reason;

  if (decision !== "notify" && decision !== "suppress") {
    throw new BotActivityClassificationError(
      'OpenAI response decision must be "notify" or "suppress"',
    );
  }

  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new BotActivityClassificationError("OpenAI response reason must be a non-empty string");
  }

  return {
    decision,
    reason: reason.trim(),
  };
}

function extractJsonObject(content: string): Record<string, unknown> {
  const trimmedContent = content.trim();
  const firstBraceIndex = trimmedContent.indexOf("{");
  const lastBraceIndex = trimmedContent.lastIndexOf("}");

  if (firstBraceIndex === -1 || lastBraceIndex < firstBraceIndex) {
    throw new BotActivityClassificationError("OpenAI response must contain a JSON object");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedContent.slice(firstBraceIndex, lastBraceIndex + 1)) as unknown;
  } catch (error) {
    throw new BotActivityClassificationError(
      `OpenAI response JSON could not be parsed: ${getErrorMessage(error)}`,
    );
  }

  return requireObject(parsed, "OpenAI response JSON");
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
