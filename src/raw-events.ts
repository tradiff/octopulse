import { DatabaseSync } from "node:sqlite";

import type {
  ActorClass,
  DecisionState,
  NotificationTiming,
} from "./normalized-event-repository.js";
import type { NotificationDeliveryStatus } from "./notification-record-repository.js";

export interface RawEventsEntry {
  id: number;
  pullRequestLabel: string;
  pullRequestTitle: string;
  pullRequestUrl: string;
  eventType: string;
  actorLogin: string | null;
  actorClass: ActorClass | null;
  decisionState: DecisionState | null;
  notificationTiming: NotificationTiming | null;
  occurredAt: string;
  rawPayloadJson: string | null;
  notificationSourceKind: "immediate" | "bundle" | null;
  notificationDeliveryStatus: NotificationDeliveryStatus | null;
}

export class RawEventsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawEventsError";
  }
}

export function listRawEvents(database: DatabaseSync): RawEventsEntry[] {
  try {
    const rows = database
      .prepare(
        `
          SELECT
            normalized_event.id,
            pull_request.repository_owner,
            pull_request.repository_name,
            pull_request.number,
            pull_request.url,
            pull_request.title,
            normalized_event.event_type,
            normalized_event.actor_login,
            normalized_event.actor_class,
            normalized_event.decision_state,
            normalized_event.notification_timing,
            normalized_event.occurred_at,
            raw_event.payload_json AS raw_payload_json,
            immediate_notification.delivery_status AS immediate_delivery_status,
            bundle_notification.delivery_status AS bundle_delivery_status
          FROM NormalizedEvent normalized_event
          INNER JOIN PullRequest pull_request
            ON pull_request.id = normalized_event.pull_request_id
          LEFT JOIN RawEvent raw_event
            ON raw_event.id = normalized_event.raw_event_id
          LEFT JOIN NotificationRecord immediate_notification
            ON immediate_notification.normalized_event_id = normalized_event.id
          LEFT JOIN NotificationRecord bundle_notification
            ON bundle_notification.event_bundle_id = normalized_event.event_bundle_id
          ORDER BY normalized_event.occurred_at DESC, normalized_event.id DESC
        `,
      )
      .all();

    return rows.map((row) => mapRawEventsEntry(row));
  } catch (error) {
    throw new RawEventsError(`Failed to list raw events: ${getErrorMessage(error)}`);
  }
}

function mapRawEventsEntry(row: unknown): RawEventsEntry {
  if (typeof row !== "object" || row === null) {
    throw new RawEventsError("Expected a raw events row from SQLite");
  }

  const value = row as Record<string, unknown>;
  const immediateDeliveryStatus = readNullableNotificationDeliveryStatus(
    value.immediate_delivery_status,
    "RawEvents.immediate_delivery_status",
  );
  const bundleDeliveryStatus = readNullableNotificationDeliveryStatus(
    value.bundle_delivery_status,
    "RawEvents.bundle_delivery_status",
  );

  return {
    id: readInteger(value.id, "RawEvents.id"),
    pullRequestLabel: `${readString(value.repository_owner, "RawEvents.repository_owner")}/${readString(value.repository_name, "RawEvents.repository_name")} #${readInteger(value.number, "RawEvents.number")}`,
    pullRequestTitle: readString(value.title, "RawEvents.title"),
    pullRequestUrl: readString(value.url, "RawEvents.url"),
    eventType: readString(value.event_type, "RawEvents.event_type"),
    actorLogin: readNullableString(value.actor_login, "RawEvents.actor_login"),
    actorClass: readNullableActorClass(value.actor_class, "RawEvents.actor_class"),
    decisionState: readNullableDecisionState(value.decision_state, "RawEvents.decision_state"),
    notificationTiming: readNullableNotificationTiming(
      value.notification_timing,
      "RawEvents.notification_timing",
    ),
    occurredAt: readString(value.occurred_at, "RawEvents.occurred_at"),
    rawPayloadJson: readNullableString(value.raw_payload_json, "RawEvents.raw_payload_json"),
    notificationSourceKind:
      immediateDeliveryStatus !== null ? "immediate" : bundleDeliveryStatus !== null ? "bundle" : null,
    notificationDeliveryStatus: immediateDeliveryStatus ?? bundleDeliveryStatus,
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

  throw new RawEventsError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new RawEventsError(`${fieldName} must be a string`);
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

  if (value === "self" || value === "human_other" || value === "bot") {
    return value;
  }

  throw new RawEventsError(`${fieldName} must be a supported actor class`);
}

function readNullableDecisionState(value: unknown, fieldName: string): DecisionState | null {
  if (value === null) {
    return null;
  }

  if (
    value === "notified" ||
    value === "notified_ai" ||
    value === "suppressed_self_action" ||
    value === "suppressed_rule" ||
    value === "notified_ai_fallback" ||
    value === "error"
  ) {
    return value;
  }

  throw new RawEventsError(`${fieldName} must be a supported decision state`);
}

function readNullableNotificationTiming(value: unknown, fieldName: string): NotificationTiming | null {
  if (value === null) {
    return null;
  }

  if (value === "immediate") {
    return value;
  }

  throw new RawEventsError(`${fieldName} must be a supported notification timing`);
}

function readNullableNotificationDeliveryStatus(
  value: unknown,
  fieldName: string,
): NotificationDeliveryStatus | null {
  if (value === null) {
    return null;
  }

  if (value === "pending" || value === "sent" || value === "failed") {
    return value;
  }

  throw new RawEventsError(`${fieldName} must be a supported delivery status`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
