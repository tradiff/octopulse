import { DatabaseSync } from "node:sqlite";

export type ActorClass = "self" | "human_other" | "bot";

export type DecisionState =
  | "notified"
  | "notified_ai"
  | "suppressed_self_action"
  | "suppressed_rule"
  | "notified_ai_fallback"
  | "error";

export type NotificationTiming = "immediate";

const BUNDLE_ELIGIBLE_DECISION_STATES = [
  "notified",
  "notified_ai",
  "notified_ai_fallback",
] as const;
const BUNDLE_ELIGIBLE_EVENT_TYPES = [
  "issue_comment",
  "review_submitted",
  "review_inline_comment",
  "ci_failed",
  "ci_succeeded",
  "pr_closed",
  "pr_merged",
  "pr_reopened",
  "ready_for_review",
  "converted_to_draft",
] as const;
const AI_ELIGIBLE_EVENT_TYPES = [
  "issue_comment",
  "review_submitted",
  "review_inline_comment",
  "review_approved",
  "review_changes_requested",
] as const;

export interface NormalizedEventRecord {
  id: number;
  rawEventId: number | null;
  eventBundleId: number | null;
  pullRequestId: number;
  eventType: string;
  actorLogin: string | null;
  actorClass: ActorClass | null;
  decisionState: DecisionState | null;
  notificationTiming: NotificationTiming | null;
  summary: string | null;
  payloadJson: string;
  occurredAt: string;
  createdAt: string;
}

export interface InsertNormalizedEventInput {
  rawEventId?: number | null;
  eventBundleId?: number | null;
  pullRequestId: number;
  eventType: string;
  actorLogin?: string | null;
  actorClass?: ActorClass | null;
  decisionState?: DecisionState | null;
  notificationTiming?: NotificationTiming | null;
  summary?: string | null;
  payloadJson?: string;
  occurredAt: string;
}

export class NormalizedEventRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizedEventRepositoryError";
  }
}

export class NormalizedEventRepository {
  constructor(private readonly database: DatabaseSync) {}

  insertNormalizedEvent(input: InsertNormalizedEventInput): NormalizedEventRecord {
    try {
      const result = this.database
        .prepare(
          `
            INSERT INTO NormalizedEvent (
              raw_event_id,
              event_bundle_id,
              pull_request_id,
              event_type,
              actor_login,
              actor_class,
              decision_state,
              notification_timing,
              summary,
              payload_json,
              occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.rawEventId ?? null,
          input.eventBundleId ?? null,
          input.pullRequestId,
          input.eventType,
          input.actorLogin ?? null,
          input.actorClass ?? null,
          input.decisionState ?? null,
          input.notificationTiming ?? null,
          input.summary ?? null,
          input.payloadJson ?? "{}",
          input.occurredAt,
        );

      return this.requireNormalizedEventById(readInteger(result.lastInsertRowid, "lastInsertRowid"));
    } catch (error) {
      if (error instanceof NormalizedEventRepositoryError) {
        throw error;
      }

      throw new NormalizedEventRepositoryError(
        `Failed to insert normalized event ${input.eventType} for pull request ${input.pullRequestId}: ${getErrorMessage(error)}`,
      );
    }
  }

  listNormalizedEventsForPullRequest(pullRequestId: number): NormalizedEventRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM NormalizedEvent
          WHERE pull_request_id = ?
          ORDER BY occurred_at ASC, id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapNormalizedEventRow(row));
  }

  listNormalizedEventsForBundle(eventBundleId: number): NormalizedEventRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM NormalizedEvent
          WHERE event_bundle_id = ?
          ORDER BY occurred_at ASC, id ASC
        `,
      )
      .all(eventBundleId);

    return rows.map((row) => mapNormalizedEventRow(row));
  }

  listBundleEligibleUnbundledEventsForPullRequest(pullRequestId: number): NormalizedEventRecord[] {
    const decisionStatePlaceholders = BUNDLE_ELIGIBLE_DECISION_STATES.map(() => "?").join(", ");
    const eventTypePlaceholders = BUNDLE_ELIGIBLE_EVENT_TYPES.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM NormalizedEvent
          WHERE pull_request_id = ?
            AND event_bundle_id IS NULL
            AND notification_timing IS NULL
            AND decision_state IN (${decisionStatePlaceholders})
            AND event_type IN (${eventTypePlaceholders})
          ORDER BY occurred_at ASC, id ASC
        `,
      )
      .all(
        pullRequestId,
        ...BUNDLE_ELIGIBLE_DECISION_STATES,
        ...BUNDLE_ELIGIBLE_EVENT_TYPES,
      );

    return rows.map((row) => mapNormalizedEventRow(row));
  }

  listAiEligibleUnbundledEventsForPullRequest(pullRequestId: number): NormalizedEventRecord[] {
    const eventTypePlaceholders = AI_ELIGIBLE_EVENT_TYPES.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM NormalizedEvent
          WHERE pull_request_id = ?
            AND event_bundle_id IS NULL
            AND actor_class = 'bot'
            AND decision_state = 'notified'
            AND event_type IN (${eventTypePlaceholders})
          ORDER BY occurred_at ASC, id ASC
        `,
      )
      .all(pullRequestId, ...AI_ELIGIBLE_EVENT_TYPES);

    return rows.map((row) => mapNormalizedEventRow(row));
  }

  listImmediateEligibleUnnotifiedEventsForPullRequest(
    pullRequestId: number,
  ): NormalizedEventRecord[] {
    const decisionStatePlaceholders = BUNDLE_ELIGIBLE_DECISION_STATES.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `
          SELECT normalized_event.*
          FROM NormalizedEvent normalized_event
          LEFT JOIN NotificationRecord notification_record
            ON notification_record.normalized_event_id = normalized_event.id
          WHERE normalized_event.pull_request_id = ?
            AND normalized_event.notification_timing = 'immediate'
            AND normalized_event.decision_state IN (${decisionStatePlaceholders})
            AND notification_record.id IS NULL
          ORDER BY normalized_event.occurred_at ASC, normalized_event.id ASC
        `,
      )
      .all(pullRequestId, ...BUNDLE_ELIGIBLE_DECISION_STATES);

    return rows.map((row) => mapNormalizedEventRow(row));
  }

  assignEventBundle(normalizedEventIds: readonly number[], eventBundleId: number): void {
    if (normalizedEventIds.length === 0) {
      return;
    }

    try {
      const placeholders = normalizedEventIds.map(() => "?").join(", ");

      this.database
        .prepare(
          `
            UPDATE NormalizedEvent
            SET event_bundle_id = ?
            WHERE id IN (${placeholders})
              AND event_bundle_id IS NULL
          `,
        )
        .run(eventBundleId, ...normalizedEventIds);
    } catch (error) {
      throw new NormalizedEventRepositoryError(
        `Failed to assign normalized events to bundle ${eventBundleId}: ${getErrorMessage(error)}`,
      );
    }
  }

  updateNormalizedEventDecision(
    id: number,
    input: { decisionState: DecisionState; payloadJson: string },
  ): NormalizedEventRecord {
    try {
      this.database
        .prepare(
          `
            UPDATE NormalizedEvent
            SET decision_state = ?, payload_json = ?
            WHERE id = ?
          `,
        )
        .run(input.decisionState, input.payloadJson, id);

      return this.requireNormalizedEventById(id);
    } catch (error) {
      if (error instanceof NormalizedEventRepositoryError) {
        throw error;
      }

      throw new NormalizedEventRepositoryError(
        `Failed to update normalized event ${id} decision state: ${getErrorMessage(error)}`,
      );
    }
  }

  private requireNormalizedEventById(id: number): NormalizedEventRecord {
    const row = this.database.prepare("SELECT * FROM NormalizedEvent WHERE id = ?").get(id);

    if (row === undefined) {
      throw new NormalizedEventRepositoryError(
        `Normalized event ${id} was not found after persistence`,
      );
    }

    return mapNormalizedEventRow(row);
  }
}

function mapNormalizedEventRow(row: unknown): NormalizedEventRecord {
  if (typeof row !== "object" || row === null) {
    throw new NormalizedEventRepositoryError("Expected a normalized event row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "NormalizedEvent.id"),
    rawEventId: readNullableInteger(value.raw_event_id, "NormalizedEvent.raw_event_id"),
    eventBundleId: readNullableInteger(value.event_bundle_id, "NormalizedEvent.event_bundle_id"),
    pullRequestId: readInteger(value.pull_request_id, "NormalizedEvent.pull_request_id"),
    eventType: readString(value.event_type, "NormalizedEvent.event_type"),
    actorLogin: readNullableString(value.actor_login, "NormalizedEvent.actor_login"),
    actorClass: readNullableActorClass(value.actor_class, "NormalizedEvent.actor_class"),
    decisionState: readNullableDecisionState(value.decision_state, "NormalizedEvent.decision_state"),
    notificationTiming: readNullableNotificationTiming(
      value.notification_timing,
      "NormalizedEvent.notification_timing",
    ),
    summary: readNullableString(value.summary, "NormalizedEvent.summary"),
    payloadJson: readString(value.payload_json, "NormalizedEvent.payload_json"),
    occurredAt: readString(value.occurred_at, "NormalizedEvent.occurred_at"),
    createdAt: readString(value.created_at, "NormalizedEvent.created_at"),
  };
}

function readInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const numericValue = Number(value);

    if (Number.isSafeInteger(numericValue)) {
      return numericValue;
    }
  }

  throw new NormalizedEventRepositoryError(`${fieldName} must be a safe integer`);
}

function readNullableInteger(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }

  return readInteger(value, fieldName);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new NormalizedEventRepositoryError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readNullableActorClass(value: unknown, fieldName: string): ActorClass | null {
  if (value === null) {
    return null;
  }

  const actorClass = readString(value, fieldName);

  if (actorClass === "self" || actorClass === "human_other" || actorClass === "bot") {
    return actorClass;
  }

  throw new NormalizedEventRepositoryError(
    `${fieldName} must be self, human_other, bot, or null`,
  );
}

function readNullableDecisionState(value: unknown, fieldName: string): DecisionState | null {
  if (value === null) {
    return null;
  }

  const decisionState = readString(value, fieldName);

  if (
    decisionState === "notified" ||
    decisionState === "notified_ai" ||
    decisionState === "suppressed_self_action" ||
    decisionState === "suppressed_rule" ||
    decisionState === "notified_ai_fallback" ||
    decisionState === "error"
  ) {
    return decisionState;
  }

  throw new NormalizedEventRepositoryError(
    `${fieldName} must be notified, notified_ai, suppressed_self_action, suppressed_rule, notified_ai_fallback, error, or null`,
  );
}

function readNullableNotificationTiming(
  value: unknown,
  fieldName: string,
): NotificationTiming | null {
  if (value === null) {
    return null;
  }

  const notificationTiming = readString(value, fieldName);

  if (notificationTiming === "immediate") {
    return notificationTiming;
  }

  throw new NormalizedEventRepositoryError(`${fieldName} must be immediate or null`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
