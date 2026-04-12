import { DatabaseSync } from "node:sqlite";

import { NormalizedEventRepository, type NormalizedEventRecord } from "./normalized-event-repository.js";

export type EventBundleStatus = "pending" | "sent" | "suppressed";

export interface EventBundleRecord {
  id: number;
  pullRequestId: number;
  status: EventBundleStatus;
  firstEventOccurredAt: string;
  lastEventOccurredAt: string;
  summary: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface CreateEventBundleInput {
  pullRequestId: number;
  status?: EventBundleStatus;
  firstEventOccurredAt: string;
  lastEventOccurredAt: string;
  summary?: string | null;
  sentAt?: string | null;
}

export interface BundlePullRequestEventsOptions {
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "assignEventBundle" | "listBundleEligibleUnbundledEventsForPullRequest"
  >;
  eventBundleRepository?: Pick<EventBundleRepository, "createEventBundle">;
}

export interface BundlePullRequestEventsResult {
  eligibleCount: number;
  bundledCount: number;
  createdBundleCount: number;
}

export class EventBundlingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventBundlingError";
  }
}

export class EventBundleRepository {
  constructor(private readonly database: DatabaseSync) {}

  createEventBundle(input: CreateEventBundleInput): EventBundleRecord {
    try {
      const result = this.database
        .prepare(
          `
            INSERT INTO EventBundle (
              pull_request_id,
              status,
              first_event_occurred_at,
              last_event_occurred_at,
              summary,
              sent_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.pullRequestId,
          input.status ?? "pending",
          input.firstEventOccurredAt,
          input.lastEventOccurredAt,
          input.summary ?? null,
          input.sentAt ?? null,
        );

      return this.requireEventBundleById(readInteger(result.lastInsertRowid, "lastInsertRowid"));
    } catch (error) {
      if (error instanceof EventBundlingError) {
        throw error;
      }

      throw new EventBundlingError(
        `Failed to create event bundle for pull request ${input.pullRequestId}: ${getErrorMessage(error)}`,
      );
    }
  }

  listEventBundlesForPullRequest(pullRequestId: number): EventBundleRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM EventBundle
          WHERE pull_request_id = ?
          ORDER BY first_event_occurred_at ASC, id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapEventBundleRow(row));
  }

  listPendingUnnotifiedBundlesForPullRequest(pullRequestId: number): EventBundleRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT event_bundle.*
          FROM EventBundle event_bundle
          LEFT JOIN NotificationRecord notification_record
            ON notification_record.event_bundle_id = event_bundle.id
          WHERE event_bundle.pull_request_id = ?
            AND event_bundle.status = 'pending'
            AND notification_record.id IS NULL
          ORDER BY event_bundle.first_event_occurred_at ASC, event_bundle.id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapEventBundleRow(row));
  }

  private requireEventBundleById(id: number): EventBundleRecord {
    const row = this.database.prepare("SELECT * FROM EventBundle WHERE id = ?").get(id);

    if (row === undefined) {
      throw new EventBundlingError(`Event bundle ${id} was not found after persistence`);
    }

    return mapEventBundleRow(row);
  }
}

export function bundlePullRequestEvents(
  database: DatabaseSync,
  pullRequestId: number,
  options: BundlePullRequestEventsOptions = {},
): BundlePullRequestEventsResult {
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);
  const eventBundleRepository = options.eventBundleRepository ?? new EventBundleRepository(database);

  let eligibleEvents: NormalizedEventRecord[];

  try {
    eligibleEvents = normalizedEventRepository.listBundleEligibleUnbundledEventsForPullRequest(
      pullRequestId,
    );
  } catch (error) {
    if (error instanceof EventBundlingError) {
      throw error;
    }

    throw new EventBundlingError(
      `Failed to load bundle-eligible events for pull request ${pullRequestId}: ${getErrorMessage(error)}`,
    );
  }

  if (eligibleEvents.length === 0) {
    return {
      eligibleCount: 0,
      bundledCount: 0,
      createdBundleCount: 0,
    };
  }

  const firstEvent = eligibleEvents[0];
  const lastEvent = eligibleEvents[eligibleEvents.length - 1];

  if (firstEvent === undefined || lastEvent === undefined) {
    throw new EventBundlingError(
      `Bundle-eligible events disappeared for pull request ${pullRequestId} before bundling`,
    );
  }

  try {
    const bundle = eventBundleRepository.createEventBundle({
      pullRequestId,
      firstEventOccurredAt: firstEvent.occurredAt,
      lastEventOccurredAt: lastEvent.occurredAt,
    });

    normalizedEventRepository.assignEventBundle(
      eligibleEvents.map((event) => event.id),
      bundle.id,
    );
  } catch (error) {
    if (error instanceof EventBundlingError) {
      throw error;
    }

    throw new EventBundlingError(
      `Failed to bundle events for pull request ${pullRequestId}: ${getErrorMessage(error)}`,
    );
  }

  return {
    eligibleCount: eligibleEvents.length,
    bundledCount: eligibleEvents.length,
    createdBundleCount: 1,
  };
}

function mapEventBundleRow(row: unknown): EventBundleRecord {
  if (typeof row !== "object" || row === null) {
    throw new EventBundlingError("Expected an event bundle row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "EventBundle.id"),
    pullRequestId: readInteger(value.pull_request_id, "EventBundle.pull_request_id"),
    status: readEventBundleStatus(value.status, "EventBundle.status"),
    firstEventOccurredAt: readString(
      value.first_event_occurred_at,
      "EventBundle.first_event_occurred_at",
    ),
    lastEventOccurredAt: readString(
      value.last_event_occurred_at,
      "EventBundle.last_event_occurred_at",
    ),
    summary: readNullableString(value.summary, "EventBundle.summary"),
    createdAt: readString(value.created_at, "EventBundle.created_at"),
    sentAt: readNullableString(value.sent_at, "EventBundle.sent_at"),
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

  throw new EventBundlingError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new EventBundlingError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readEventBundleStatus(value: unknown, fieldName: string): EventBundleStatus {
  const status = readString(value, fieldName);

  if (status === "pending" || status === "sent" || status === "suppressed") {
    return status;
  }

  throw new EventBundlingError(`${fieldName} must be pending, sent, or suppressed`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
