import { DatabaseSync } from "node:sqlite";

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED";

export interface PullRequestReviewStateRecord {
  id: number;
  pullRequestId: number;
  reviewerLogin: string;
  reviewerAvatarUrl: string | null;
  reviewState: ReviewState;
  updatedAt: string;
}

export interface UpsertReviewStateInput {
  pullRequestId: number;
  reviewerLogin: string;
  reviewerAvatarUrl?: string | null;
  reviewState: ReviewState;
}

export class PullRequestReviewStateRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestReviewStateRepositoryError";
  }
}

export class PullRequestReviewStateRepository {
  constructor(private readonly database: DatabaseSync) {}

  upsertReviewState(input: UpsertReviewStateInput): void {
    try {
      this.database
        .prepare(
          `
            INSERT INTO PullRequestReviewState (
              pull_request_id,
              reviewer_login,
              reviewer_avatar_url,
              review_state,
              updated_at
            ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(pull_request_id, reviewer_login) DO UPDATE SET
              reviewer_avatar_url = COALESCE(excluded.reviewer_avatar_url, reviewer_avatar_url),
              review_state = excluded.review_state,
              updated_at = CURRENT_TIMESTAMP
          `,
        )
        .run(
          input.pullRequestId,
          input.reviewerLogin,
          input.reviewerAvatarUrl ?? null,
          input.reviewState,
        );
    } catch (error) {
      throw new PullRequestReviewStateRepositoryError(
        `Failed to upsert review state for ${input.reviewerLogin} on pull request ${input.pullRequestId}: ${getErrorMessage(error)}`,
      );
    }
  }

  hasReviewStatesForPullRequest(pullRequestId: number): boolean {
    const row = this.database
      .prepare("SELECT 1 FROM PullRequestReviewState WHERE pull_request_id = ? LIMIT 1")
      .get(pullRequestId);

    return row !== undefined;
  }

  listReviewStatesForPullRequest(pullRequestId: number): PullRequestReviewStateRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM PullRequestReviewState
          WHERE pull_request_id = ?
          ORDER BY updated_at DESC, id DESC
        `,
      )
      .all(pullRequestId);

    return rows.map((row) => mapReviewStateRow(row));
  }
}

function mapReviewStateRow(row: unknown): PullRequestReviewStateRecord {
  if (typeof row !== "object" || row === null) {
    throw new PullRequestReviewStateRepositoryError("Expected a review state row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "PullRequestReviewState.id"),
    pullRequestId: readInteger(value.pull_request_id, "PullRequestReviewState.pull_request_id"),
    reviewerLogin: readString(value.reviewer_login, "PullRequestReviewState.reviewer_login"),
    reviewerAvatarUrl: readNullableString(
      value.reviewer_avatar_url,
      "PullRequestReviewState.reviewer_avatar_url",
    ),
    reviewState: readReviewState(value.review_state),
    updatedAt: readString(value.updated_at, "PullRequestReviewState.updated_at"),
  };
}

function readReviewState(value: unknown): ReviewState {
  if (
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "DISMISSED" ||
    value === "COMMENTED"
  ) {
    return value;
  }

  throw new PullRequestReviewStateRepositoryError(
    `PullRequestReviewState.review_state must be APPROVED, CHANGES_REQUESTED, DISMISSED, or COMMENTED; got ${String(value)}`,
  );
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

  throw new PullRequestReviewStateRepositoryError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new PullRequestReviewStateRepositoryError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
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
