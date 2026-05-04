import { DatabaseSync } from "node:sqlite";

export interface PullRequestCiJobStateRecord {
  id: number;
  pullRequestId: number;
  workflowRunId: string;
  workflowRunName: string;
  workflowRunUpdatedAt: string;
  jobId: string;
  jobName: string;
  jobStatus: string;
  jobConclusion: string | null;
  isBlockingMerge: boolean | null;
  updatedAt: string;
}

export interface UpsertCiJobStateInput {
  pullRequestId: number;
  workflowRunId: string;
  workflowRunName: string;
  workflowRunUpdatedAt: string;
  jobId: string;
  jobName: string;
  jobStatus: string;
  jobConclusion: string | null;
  isBlockingMerge: boolean | null;
}

export class PullRequestCiJobStateRepository {
  constructor(private readonly database: DatabaseSync) {}

  upsertCiJobState(input: UpsertCiJobStateInput): void {
    try {
      this.database
        .prepare(
          `
            INSERT INTO PullRequestCiJobState (
              pull_request_id,
              workflow_run_id,
              workflow_run_name,
              workflow_run_updated_at,
              job_id,
              job_name,
              job_status,
              job_conclusion,
              is_blocking_merge,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(pull_request_id, job_id) DO UPDATE SET
              workflow_run_id = excluded.workflow_run_id,
              workflow_run_name = excluded.workflow_run_name,
              workflow_run_updated_at = excluded.workflow_run_updated_at,
              job_name = excluded.job_name,
              job_status = excluded.job_status,
              job_conclusion = excluded.job_conclusion,
              is_blocking_merge = COALESCE(excluded.is_blocking_merge, is_blocking_merge),
              updated_at = CURRENT_TIMESTAMP
          `,
        )
        .run(
          input.pullRequestId,
          input.workflowRunId,
          input.workflowRunName,
          input.workflowRunUpdatedAt,
          input.jobId,
          input.jobName,
          input.jobStatus,
          input.jobConclusion ?? null,
          input.isBlockingMerge === null ? null : input.isBlockingMerge ? 1 : 0,
        );
    } catch (error) {
      throw new Error(
        `Failed to upsert CI job state for job ${input.jobId} on pull request ${input.pullRequestId}: ${getErrorMessage(error)}`,
      );
    }
  }

  hasJobsForWorkflowRun(pullRequestId: number, workflowRunId: string, workflowRunUpdatedAt: string): boolean {
    const row = this.database
      .prepare(
        `
          SELECT 1 FROM PullRequestCiJobState
          WHERE pull_request_id = ?
            AND workflow_run_id = ?
            AND workflow_run_updated_at = ?
          LIMIT 1
        `,
      )
      .get(pullRequestId, workflowRunId, workflowRunUpdatedAt);

    return row !== undefined;
  }

  listCiJobStatesForPullRequest(pullRequestId: number): PullRequestCiJobStateRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM PullRequestCiJobState
          WHERE pull_request_id = ?
          ORDER BY workflow_run_name ASC, job_name ASC
        `,
      )
      .all(pullRequestId);

    return rows.map(mapCiJobStateRow);
  }
}

function mapCiJobStateRow(row: unknown): PullRequestCiJobStateRecord {
  if (typeof row !== "object" || row === null) {
    throw new Error("Expected a CI job state row from SQLite");
  }

  const value = row as Record<string, unknown>;

  return {
    id: readInteger(value.id, "PullRequestCiJobState.id"),
    pullRequestId: readInteger(value.pull_request_id, "PullRequestCiJobState.pull_request_id"),
    workflowRunId: readString(value.workflow_run_id, "PullRequestCiJobState.workflow_run_id"),
    workflowRunName: readString(value.workflow_run_name, "PullRequestCiJobState.workflow_run_name"),
    workflowRunUpdatedAt: readString(value.workflow_run_updated_at, "PullRequestCiJobState.workflow_run_updated_at"),
    jobId: readString(value.job_id, "PullRequestCiJobState.job_id"),
    jobName: readString(value.job_name, "PullRequestCiJobState.job_name"),
    jobStatus: readString(value.job_status, "PullRequestCiJobState.job_status"),
    jobConclusion: readNullableString(value.job_conclusion, "PullRequestCiJobState.job_conclusion"),
    isBlockingMerge: readNullableBoolean(value.is_blocking_merge, "PullRequestCiJobState.is_blocking_merge"),
    updatedAt: readString(value.updated_at, "PullRequestCiJobState.updated_at"),
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

  throw new Error(`${fieldName} must be a safe integer`);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return readString(value, fieldName);
}

function readNullableBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value === 0 || value === 1) {
    return value === 1;
  }

  if (typeof value === "bigint" && (value === 0n || value === 1n)) {
    return value === 1n;
  }

  throw new Error(`${fieldName} must be 0, 1, or null`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
