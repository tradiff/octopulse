import { DatabaseSync } from "node:sqlite";

const DEFAULT_TRACKING_REASON = "auto";

export interface PullRequestRecord {
  id: number;
  githubPullRequestId: number;
  repositoryOwner: string;
  repositoryName: string;
  number: number;
  url: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  title: string;
  state: string;
  isDraft: boolean;
  isTracked: boolean;
  trackingReason: string;
  isStickyUntracked: boolean;
  lastSeenAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  graceUntil: string | null;
  lastSeenHeadSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestTrackingState {
  isTracked: boolean;
  trackingReason: string;
  isStickyUntracked: boolean;
}

export interface UpsertPullRequestInput {
  githubPullRequestId: number;
  repositoryOwner: string;
  repositoryName: string;
  number: number;
  url: string;
  authorLogin: string;
  authorAvatarUrl?: string | null;
  title: string;
  state: string;
  isDraft: boolean;
  lastSeenAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  graceUntil?: string | null;
  lastSeenHeadSha?: string | null;
  tracking?: PullRequestTrackingState;
}

export class PullRequestRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestRepositoryError";
  }
}

export class PullRequestRepository {
  constructor(private readonly database: DatabaseSync) {}

  getPullRequestById(id: number): PullRequestRecord | undefined {
    return this.readPullRequestById(id);
  }

  getPullRequestByGitHubPullRequestId(githubPullRequestId: number): PullRequestRecord | undefined {
    return this.readPullRequestByGitHubPullRequestId(githubPullRequestId);
  }

  getPullRequestByRepositoryCoordinates(
    repositoryOwner: string,
    repositoryName: string,
    number: number,
  ): PullRequestRecord | undefined {
    return this.readPullRequestByRepositoryCoordinates(repositoryOwner, repositoryName, number);
  }

  upsertPullRequest(input: UpsertPullRequestInput): PullRequestRecord {
    try {
      return withinTransaction(this.database, () => {
        const existing = this.readExistingPullRequest(input);
        const tracking = input.tracking ?? readTrackingState(existing);

        if (existing) {
          this.database
            .prepare(
              `
                UPDATE PullRequest
                SET github_pull_request_id = ?,
                    repository_owner = ?,
                    repository_name = ?,
                    number = ?,
                    url = ?,
                    author_login = ?,
                    author_avatar_url = ?,
                    title = ?,
                    state = ?,
                    is_draft = ?,
                    is_tracked = ?,
                    tracking_reason = ?,
                    is_sticky_untracked = ?,
                    last_seen_at = ?,
                    closed_at = ?,
                    merged_at = ?,
                    grace_until = ?,
                    last_seen_head_sha = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `,
            )
            .run(
              input.githubPullRequestId,
              input.repositoryOwner,
              input.repositoryName,
              input.number,
              input.url,
              input.authorLogin,
              resolveNullableField(input.authorAvatarUrl, existing.authorAvatarUrl),
              input.title,
              input.state,
              writeBoolean(input.isDraft),
              writeBoolean(tracking.isTracked),
              tracking.trackingReason,
              writeBoolean(tracking.isStickyUntracked),
              resolveNullableField(input.lastSeenAt, existing.lastSeenAt),
              resolveNullableField(input.closedAt, existing.closedAt),
              resolveNullableField(input.mergedAt, existing.mergedAt),
              resolveNullableField(input.graceUntil, existing.graceUntil),
              resolveNullableField(input.lastSeenHeadSha, existing.lastSeenHeadSha),
              existing.id,
            );

          return this.requirePullRequestById(existing.id);
        }

        const result = this.database
          .prepare(
            `
              INSERT INTO PullRequest (
                github_pull_request_id,
                repository_owner,
                repository_name,
                number,
                url,
                author_login,
                author_avatar_url,
                title,
                state,
                is_draft,
                is_tracked,
                tracking_reason,
                is_sticky_untracked,
                last_seen_at,
                closed_at,
                merged_at,
                grace_until,
                last_seen_head_sha
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            input.githubPullRequestId,
            input.repositoryOwner,
            input.repositoryName,
            input.number,
            input.url,
            input.authorLogin,
            input.authorAvatarUrl ?? null,
            input.title,
            input.state,
            writeBoolean(input.isDraft),
            writeBoolean(tracking.isTracked),
            tracking.trackingReason,
            writeBoolean(tracking.isStickyUntracked),
            input.lastSeenAt ?? null,
            input.closedAt ?? null,
            input.mergedAt ?? null,
            input.graceUntil ?? null,
            input.lastSeenHeadSha ?? null,
          );

        return this.requirePullRequestById(readInteger(result.lastInsertRowid, "lastInsertRowid"));
      });
    } catch (error) {
      if (error instanceof PullRequestRepositoryError) {
        throw error;
      }

      throw new PullRequestRepositoryError(
        `Failed to upsert pull request ${formatPullRequestLabel(input)}: ${getErrorMessage(error)}`,
      );
    }
  }

  listTrackedPullRequests(): PullRequestRecord[] {
    return this.listByTrackedState(true);
  }

  listInactivePullRequests(): PullRequestRecord[] {
    return this.listByTrackedState(false);
  }

  listPullRequestsForPolling(observedAt: string): PullRequestRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM PullRequest
          WHERE is_tracked = 1
             OR (
                  is_tracked = 0
              AND is_sticky_untracked = 0
              AND grace_until IS NOT NULL
              AND grace_until > ?
                )
          ORDER BY updated_at DESC, id DESC
        `,
      )
      .all(observedAt);

    return rows.map((row) => mapPullRequestRow(row));
  }

  updatePullRequestTrackingState(
    githubPullRequestId: number,
    tracking: PullRequestTrackingState,
  ): PullRequestRecord {
    try {
      return withinTransaction(this.database, () => {
        const existing = this.readPullRequestByGitHubPullRequestId(githubPullRequestId);

        if (!existing) {
          throw new PullRequestRepositoryError(
            `Pull request ${githubPullRequestId} does not exist in the repository`,
          );
        }

        this.database
          .prepare(
            `
              UPDATE PullRequest
              SET is_tracked = ?,
                  tracking_reason = ?,
                  is_sticky_untracked = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE github_pull_request_id = ?
            `,
          )
          .run(
            writeBoolean(tracking.isTracked),
            tracking.trackingReason,
            writeBoolean(tracking.isStickyUntracked),
            githubPullRequestId,
          );

        return this.requirePullRequestById(existing.id);
      });
    } catch (error) {
      if (error instanceof PullRequestRepositoryError) {
        throw error;
      }

      throw new PullRequestRepositoryError(
        `Failed to update tracking state for pull request ${githubPullRequestId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private listByTrackedState(isTracked: boolean): PullRequestRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM PullRequest
          WHERE is_tracked = ?
          ORDER BY updated_at DESC, id DESC
        `,
      )
      .all(writeBoolean(isTracked));

    return rows.map((row) => mapPullRequestRow(row));
  }

  private requirePullRequestById(id: number): PullRequestRecord {
    const pullRequest = this.readPullRequestById(id);

    if (!pullRequest) {
      throw new PullRequestRepositoryError(`Pull request ${id} was not found after persistence`);
    }

    return pullRequest;
  }

  private readExistingPullRequest(input: UpsertPullRequestInput): PullRequestRecord | undefined {
    const byGitHubPullRequestId = this.readPullRequestByGitHubPullRequestId(input.githubPullRequestId);
    const byRepositoryCoordinates = this.readPullRequestByRepositoryCoordinates(
      input.repositoryOwner,
      input.repositoryName,
      input.number,
    );

    if (
      byGitHubPullRequestId &&
      byRepositoryCoordinates &&
      byGitHubPullRequestId.id !== byRepositoryCoordinates.id
    ) {
      throw new PullRequestRepositoryError(
        `Conflicting pull request rows exist for ${formatPullRequestLabel(input)}`,
      );
    }

    return byGitHubPullRequestId ?? byRepositoryCoordinates;
  }

  private readPullRequestById(id: number): PullRequestRecord | undefined {
    const row = this.database.prepare("SELECT * FROM PullRequest WHERE id = ?").get(id);
    return row === undefined ? undefined : mapPullRequestRow(row);
  }

  private readPullRequestByGitHubPullRequestId(
    githubPullRequestId: number,
  ): PullRequestRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM PullRequest WHERE github_pull_request_id = ?")
      .get(githubPullRequestId);

    return row === undefined ? undefined : mapPullRequestRow(row);
  }

  private readPullRequestByRepositoryCoordinates(
    repositoryOwner: string,
    repositoryName: string,
    number: number,
  ): PullRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM PullRequest
          WHERE repository_owner = ?
            AND repository_name = ?
            AND number = ?
        `,
      )
      .get(repositoryOwner, repositoryName, number);

    return row === undefined ? undefined : mapPullRequestRow(row);
  }
}

function mapPullRequestRow(row: unknown): PullRequestRecord {
  if (typeof row !== "object" || row === null) {
    throw new PullRequestRepositoryError("Expected a pull request row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "PullRequest.id"),
    githubPullRequestId: readInteger(
      value.github_pull_request_id,
      "PullRequest.github_pull_request_id",
    ),
    repositoryOwner: readString(value.repository_owner, "PullRequest.repository_owner"),
    repositoryName: readString(value.repository_name, "PullRequest.repository_name"),
    number: readInteger(value.number, "PullRequest.number"),
    url: readString(value.url, "PullRequest.url"),
    authorLogin: readString(value.author_login, "PullRequest.author_login"),
    authorAvatarUrl: readNullableString(value.author_avatar_url, "PullRequest.author_avatar_url"),
    title: readString(value.title, "PullRequest.title"),
    state: readString(value.state, "PullRequest.state"),
    isDraft: readBoolean(value.is_draft, "PullRequest.is_draft"),
    isTracked: readBoolean(value.is_tracked, "PullRequest.is_tracked"),
    trackingReason: readString(value.tracking_reason, "PullRequest.tracking_reason"),
    isStickyUntracked: readBoolean(
      value.is_sticky_untracked,
      "PullRequest.is_sticky_untracked",
    ),
    lastSeenAt: readNullableString(value.last_seen_at, "PullRequest.last_seen_at"),
    closedAt: readNullableString(value.closed_at, "PullRequest.closed_at"),
    mergedAt: readNullableString(value.merged_at, "PullRequest.merged_at"),
    graceUntil: readNullableString(value.grace_until, "PullRequest.grace_until"),
    lastSeenHeadSha: readNullableString(
      value.last_seen_head_sha,
      "PullRequest.last_seen_head_sha",
    ),
    createdAt: readString(value.created_at, "PullRequest.created_at"),
    updatedAt: readString(value.updated_at, "PullRequest.updated_at"),
  };
}

function readTrackingState(pullRequest: PullRequestRecord | undefined): PullRequestTrackingState {
  if (pullRequest) {
    return {
      isTracked: pullRequest.isTracked,
      trackingReason: pullRequest.trackingReason,
      isStickyUntracked: pullRequest.isStickyUntracked,
    };
  }

  return {
    isTracked: true,
    trackingReason: DEFAULT_TRACKING_REASON,
    isStickyUntracked: false,
  };
}

function resolveNullableField(
  nextValue: string | null | undefined,
  existingValue: string | null,
): string | null {
  return nextValue === undefined ? existingValue : nextValue;
}

function withinTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) {
    return operation();
  }

  database.exec("BEGIN");

  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function rollbackQuietly(database: DatabaseSync): void {
  if (!database.isTransaction) {
    return;
  }

  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original repository failure.
  }
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

  throw new PullRequestRepositoryError(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new PullRequestRepositoryError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readBoolean(value: unknown, fieldName: string): boolean {
  const numericValue = readInteger(value, fieldName);

  if (numericValue === 0) {
    return false;
  }

  if (numericValue === 1) {
    return true;
  }

  throw new PullRequestRepositoryError(`${fieldName} must be stored as 0 or 1`);
}

function writeBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function formatPullRequestLabel(
  input: Pick<UpsertPullRequestInput, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${input.repositoryOwner}/${input.repositoryName}#${input.number}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
