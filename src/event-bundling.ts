import { DatabaseSync } from "node:sqlite";

import { NormalizedEventRepository, type NormalizedEventRecord } from "./normalized-event-repository.js";

const DEFAULT_BUNDLE_WINDOW_MS = 60_000;

export type EventBundleStatus = "pending" | "sent" | "suppressed";

export interface EventBundleRecord {
  id: number;
  pullRequestId: number;
  status: EventBundleStatus;
  windowStartedAt: string;
  windowEndsAt: string;
  summary: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface CreateEventBundleInput {
  pullRequestId: number;
  status?: EventBundleStatus;
  windowStartedAt: string;
  windowEndsAt: string;
  summary?: string | null;
  sentAt?: string | null;
}

export interface BundlePullRequestEventsOptions {
  windowMs?: number;
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "assignEventBundle" | "listBundleEligibleUnbundledEventsForPullRequest"
  >;
  eventBundleRepository?: Pick<
    EventBundleRepository,
    "createEventBundle" | "findPendingEventBundleForTime" | "updateEventBundleWindowEnd"
  >;
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
              window_started_at,
              window_ends_at,
              summary,
              sent_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.pullRequestId,
          input.status ?? "pending",
          input.windowStartedAt,
          input.windowEndsAt,
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

  findPendingEventBundleForTime(pullRequestId: number, occurredAt: string): EventBundleRecord | null {
    try {
      const row = this.database
        .prepare(
          `
            SELECT *
            FROM EventBundle
            WHERE pull_request_id = ?
              AND status = 'pending'
              AND window_started_at <= ?
              AND window_ends_at >= ?
            ORDER BY window_started_at DESC, id DESC
            LIMIT 1
          `,
        )
        .get(pullRequestId, occurredAt, occurredAt);

      return row === undefined ? null : mapEventBundleRow(row);
    } catch (error) {
      if (error instanceof EventBundlingError) {
        throw error;
      }

      throw new EventBundlingError(
        `Failed to load event bundles for pull request ${pullRequestId}: ${getErrorMessage(error)}`,
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
          ORDER BY window_started_at ASC, id ASC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapEventBundleRow(row));
  }

  listReadyPendingUnnotifiedBundlesForPullRequest(
    pullRequestId: number,
    readyAt: string,
  ): EventBundleRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT event_bundle.*
          FROM EventBundle event_bundle
          LEFT JOIN NotificationRecord notification_record
            ON notification_record.event_bundle_id = event_bundle.id
          WHERE event_bundle.pull_request_id = ?
            AND event_bundle.status = 'pending'
            AND event_bundle.window_ends_at <= ?
            AND notification_record.id IS NULL
          ORDER BY event_bundle.window_started_at ASC, event_bundle.id ASC
        `,
      )
      .all(pullRequestId, readyAt);

    return rows.map((row) => mapEventBundleRow(row));
  }

  updateEventBundleWindowEnd(id: number, windowEndsAt: string): EventBundleRecord {
    try {
      this.database
        .prepare(
          `
            UPDATE EventBundle
            SET window_ends_at = ?
            WHERE id = ?
          `,
        )
        .run(windowEndsAt, id);

      return this.requireEventBundleById(id);
    } catch (error) {
      if (error instanceof EventBundlingError) {
        throw error;
      }

      throw new EventBundlingError(
        `Failed to extend event bundle ${id}: ${getErrorMessage(error)}`,
      );
    }
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
  const windowMs = options.windowMs ?? DEFAULT_BUNDLE_WINDOW_MS;

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new EventBundlingError("Bundle window must be greater than zero milliseconds");
  }

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

  let currentBundle: EventBundleRecord | null = null;
  let createdBundleCount = 0;

  try {
    for (const event of eligibleEvents) {
      const windowEndsAt = addWindowDuration(event.occurredAt, windowMs);

      if (currentBundle === null || isTimestampAfter(event.occurredAt, currentBundle.windowEndsAt)) {
        currentBundle = eventBundleRepository.findPendingEventBundleForTime(
          pullRequestId,
          event.occurredAt,
        );

        if (currentBundle === null) {
          currentBundle = eventBundleRepository.createEventBundle({
            pullRequestId,
            windowStartedAt: event.occurredAt,
            windowEndsAt,
          });
          createdBundleCount += 1;
        }
      }

      normalizedEventRepository.assignEventBundle([event.id], currentBundle.id);

      if (isTimestampAfter(windowEndsAt, currentBundle.windowEndsAt)) {
        currentBundle = eventBundleRepository.updateEventBundleWindowEnd(currentBundle.id, windowEndsAt);
      }
    }
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
    createdBundleCount,
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
    windowStartedAt: readString(value.window_started_at, "EventBundle.window_started_at"),
    windowEndsAt: readString(value.window_ends_at, "EventBundle.window_ends_at"),
    summary: readNullableString(value.summary, "EventBundle.summary"),
    createdAt: readString(value.created_at, "EventBundle.created_at"),
    sentAt: readNullableString(value.sent_at, "EventBundle.sent_at"),
  };
}

function addWindowDuration(occurredAt: string, windowMs: number): string {
  const timestamp = Date.parse(occurredAt);

  if (Number.isNaN(timestamp)) {
    throw new EventBundlingError(`Invalid event timestamp ${occurredAt}`);
  }

  return new Date(timestamp + windowMs).toISOString();
}

function isTimestampAfter(left: string, right: string): boolean {
  return left.localeCompare(right) > 0;
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
