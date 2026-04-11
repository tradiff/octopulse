import { DatabaseSync } from "node:sqlite";

export type ActorClass = "self" | "human_other" | "bot";

export interface NormalizedEventRecord {
  id: number;
  rawEventId: number | null;
  pullRequestId: number;
  eventType: string;
  actorLogin: string | null;
  actorClass: ActorClass | null;
  decisionState: string | null;
  summary: string | null;
  payloadJson: string;
  occurredAt: string;
  createdAt: string;
}

export interface InsertNormalizedEventInput {
  rawEventId?: number | null;
  pullRequestId: number;
  eventType: string;
  actorLogin?: string | null;
  actorClass?: ActorClass | null;
  decisionState?: string | null;
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
              pull_request_id,
              event_type,
              actor_login,
              actor_class,
              decision_state,
              summary,
              payload_json,
              occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.rawEventId ?? null,
          input.pullRequestId,
          input.eventType,
          input.actorLogin ?? null,
          input.actorClass ?? null,
          input.decisionState ?? null,
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
    pullRequestId: readInteger(value.pull_request_id, "NormalizedEvent.pull_request_id"),
    eventType: readString(value.event_type, "NormalizedEvent.event_type"),
    actorLogin: readNullableString(value.actor_login, "NormalizedEvent.actor_login"),
    actorClass: readNullableActorClass(value.actor_class, "NormalizedEvent.actor_class"),
    decisionState: readNullableString(value.decision_state, "NormalizedEvent.decision_state"),
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
