import { DatabaseSync } from "node:sqlite";

export interface RawEventRecord {
  id: number;
  pullRequestId: number;
  source: string;
  sourceId: string;
  eventType: string;
  actorLogin: string | null;
  payloadJson: string;
  occurredAt: string;
  ingestedAt: string;
}

export interface InsertRawEventInput {
  pullRequestId: number;
  source: string;
  sourceId: string;
  eventType: string;
  actorLogin?: string | null;
  payloadJson: string;
  occurredAt: string;
}

export interface InsertRawEventResult {
  outcome: "inserted" | "duplicate";
  rawEvent?: RawEventRecord;
}

export class RawEventRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawEventRepositoryError";
  }
}

export class RawEventRepository {
  constructor(private readonly database: DatabaseSync) {}

  insertRawEvent(input: InsertRawEventInput): InsertRawEventResult {
    try {
      const result = this.database
        .prepare(
          `
            INSERT INTO RawEvent (
              pull_request_id,
              source,
              source_id,
              event_type,
              actor_login,
              payload_json,
              occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, source_id) DO NOTHING
          `,
        )
        .run(
          input.pullRequestId,
          input.source,
          input.sourceId,
          input.eventType,
          input.actorLogin ?? null,
          input.payloadJson,
          input.occurredAt,
        );

      if (readInteger(result.changes, "changes") === 0) {
        return {
          outcome: "duplicate",
        };
      }

      return {
        outcome: "inserted",
        rawEvent: this.requireRawEventById(readInteger(result.lastInsertRowid, "lastInsertRowid")),
      };
    } catch (error) {
      if (error instanceof RawEventRepositoryError) {
        throw error;
      }

      throw new RawEventRepositoryError(
        `Failed to insert raw event ${input.source}/${input.sourceId}: ${getErrorMessage(error)}`,
      );
    }
  }

  listRawEventsForPullRequest(pullRequestId: number): RawEventRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM RawEvent
          WHERE pull_request_id = ?
          ORDER BY occurred_at ASC, id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapRawEventRow(row));
  }

  listUnnormalizedRawEventsForPullRequest(pullRequestId: number): RawEventRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT RawEvent.*
          FROM RawEvent
          LEFT JOIN NormalizedEvent
            ON NormalizedEvent.raw_event_id = RawEvent.id
          WHERE RawEvent.pull_request_id = ?
            AND NormalizedEvent.id IS NULL
          ORDER BY RawEvent.occurred_at ASC, RawEvent.id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapRawEventRow(row));
  }

  private requireRawEventById(id: number): RawEventRecord {
    const row = this.database.prepare("SELECT * FROM RawEvent WHERE id = ?").get(id);

    if (row === undefined) {
      throw new RawEventRepositoryError(`Raw event ${id} was not found after persistence`);
    }

    return mapRawEventRow(row);
  }
}

function mapRawEventRow(row: unknown): RawEventRecord {
  if (typeof row !== "object" || row === null) {
    throw new RawEventRepositoryError("Expected a raw event row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "RawEvent.id"),
    pullRequestId: readInteger(value.pull_request_id, "RawEvent.pull_request_id"),
    source: readString(value.source, "RawEvent.source"),
    sourceId: readString(value.source_id, "RawEvent.source_id"),
    eventType: readString(value.event_type, "RawEvent.event_type"),
    actorLogin: readNullableString(value.actor_login, "RawEvent.actor_login"),
    payloadJson: readString(value.payload_json, "RawEvent.payload_json"),
    occurredAt: readString(value.occurred_at, "RawEvent.occurred_at"),
    ingestedAt: readString(value.ingested_at, "RawEvent.ingested_at"),
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

  throw new RawEventRepositoryError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new RawEventRepositoryError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
