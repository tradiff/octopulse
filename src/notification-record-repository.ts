import { DatabaseSync } from "node:sqlite";

export type NotificationDeliveryStatus = "pending" | "sent" | "failed";

export interface NotificationRecord {
  id: number;
  eventBundleId: number | null;
  normalizedEventId: number | null;
  pullRequestId: number;
  title: string;
  body: string;
  clickUrl: string | null;
  deliveryStatus: NotificationDeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
}

export interface CreateNotificationRecordInput {
  eventBundleId?: number | null;
  normalizedEventId?: number | null;
  pullRequestId: number;
  title: string;
  body: string;
  clickUrl?: string | null;
  deliveryStatus?: NotificationDeliveryStatus;
  deliveredAt?: string | null;
}

export interface UpdateNotificationRecordDeliveryInput {
  deliveryStatus: NotificationDeliveryStatus;
  deliveredAt?: string | null;
}

export class NotificationRecordRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationRecordRepositoryError";
  }
}

export class NotificationRecordRepository {
  constructor(private readonly database: DatabaseSync) {}

  createNotificationRecord(input: CreateNotificationRecordInput): NotificationRecord {
    validateNotificationTarget(input);

    try {
      const result = this.database
        .prepare(
          `
            INSERT INTO NotificationRecord (
              event_bundle_id,
              normalized_event_id,
              pull_request_id,
              title,
              body,
              click_url,
              delivery_status,
              delivered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.eventBundleId ?? null,
          input.normalizedEventId ?? null,
          input.pullRequestId,
          input.title,
          input.body,
          input.clickUrl ?? null,
          input.deliveryStatus ?? "pending",
          input.deliveredAt ?? null,
        );

      return this.requireNotificationRecordById(readInteger(result.lastInsertRowid, "lastInsertRowid"));
    } catch (error) {
      if (error instanceof NotificationRecordRepositoryError) {
        throw error;
      }

      throw new NotificationRecordRepositoryError(
        `Failed to create notification record for pull request ${input.pullRequestId}: ${getErrorMessage(error)}`,
      );
    }
  }

  getNotificationRecordForEventBundle(eventBundleId: number): NotificationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM NotificationRecord WHERE event_bundle_id = ?")
      .get(eventBundleId);

    return row === undefined ? null : mapNotificationRecordRow(row);
  }

  getNotificationRecordForNormalizedEvent(normalizedEventId: number): NotificationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM NotificationRecord WHERE normalized_event_id = ?")
      .get(normalizedEventId);

    return row === undefined ? null : mapNotificationRecordRow(row);
  }

  listNotificationRecordsForPullRequest(pullRequestId: number): NotificationRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM NotificationRecord
          WHERE pull_request_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapNotificationRecordRow(row));
  }

  listPendingNotificationRecordsForPullRequest(pullRequestId: number): NotificationRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM NotificationRecord
          WHERE pull_request_id = ?
            AND delivery_status = 'pending'
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapNotificationRecordRow(row));
  }

  updateNotificationRecordDelivery(
    id: number,
    input: UpdateNotificationRecordDeliveryInput,
  ): NotificationRecord {
    try {
      this.database
        .prepare(
          `
            UPDATE NotificationRecord
            SET delivery_status = ?, delivered_at = ?
            WHERE id = ?
          `,
        )
        .run(input.deliveryStatus, input.deliveredAt ?? null, id);

      return this.requireNotificationRecordById(id);
    } catch (error) {
      if (error instanceof NotificationRecordRepositoryError) {
        throw error;
      }

      throw new NotificationRecordRepositoryError(
        `Failed to update notification record ${id} delivery: ${getErrorMessage(error)}`,
      );
    }
  }

  private requireNotificationRecordById(id: number): NotificationRecord {
    const row = this.database.prepare("SELECT * FROM NotificationRecord WHERE id = ?").get(id);

    if (row === undefined) {
      throw new NotificationRecordRepositoryError(
        `Notification record ${id} was not found after persistence`,
      );
    }

    return mapNotificationRecordRow(row);
  }
}

function validateNotificationTarget(input: CreateNotificationRecordInput): void {
  const targetCount = [input.eventBundleId ?? null, input.normalizedEventId ?? null].filter(
    (value) => value !== null,
  ).length;

  if (targetCount !== 1) {
    throw new NotificationRecordRepositoryError(
      "Notification record must target exactly one event bundle or normalized event",
    );
  }
}

function mapNotificationRecordRow(row: unknown): NotificationRecord {
  if (typeof row !== "object" || row === null) {
    throw new NotificationRecordRepositoryError("Expected a notification record row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "NotificationRecord.id"),
    eventBundleId: readNullableInteger(value.event_bundle_id, "NotificationRecord.event_bundle_id"),
    normalizedEventId: readNullableInteger(
      value.normalized_event_id,
      "NotificationRecord.normalized_event_id",
    ),
    pullRequestId: readInteger(value.pull_request_id, "NotificationRecord.pull_request_id"),
    title: readString(value.title, "NotificationRecord.title"),
    body: readString(value.body, "NotificationRecord.body"),
    clickUrl: readNullableString(value.click_url, "NotificationRecord.click_url"),
    deliveryStatus: readNotificationDeliveryStatus(
      value.delivery_status,
      "NotificationRecord.delivery_status",
    ),
    createdAt: readString(value.created_at, "NotificationRecord.created_at"),
    deliveredAt: readNullableString(value.delivered_at, "NotificationRecord.delivered_at"),
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

  throw new NotificationRecordRepositoryError(`${fieldName} must be a safe integer`);
}

function readNullableInteger(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }

  return readInteger(value, fieldName);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new NotificationRecordRepositoryError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readNotificationDeliveryStatus(
  value: unknown,
  fieldName: string,
): NotificationDeliveryStatus {
  const deliveryStatus = readString(value, fieldName);

  if (deliveryStatus === "pending" || deliveryStatus === "sent" || deliveryStatus === "failed") {
    return deliveryStatus;
  }

  throw new NotificationRecordRepositoryError(`${fieldName} must be pending, sent, or failed`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
