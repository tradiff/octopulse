import type { UpsertPullRequestInput } from "./pull-request-repository.js";

export interface PullRequestCoordinates {
  repositoryOwner: string;
  repositoryName: string;
  number: number;
}

export interface PullRequestSnapshot extends PullRequestCoordinates {
  githubPullRequestId: number;
  url: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  title: string;
  state: string;
  isDraft: boolean;
  closedAt: string | null;
  mergedAt: string | null;
  lastSeenHeadSha: string | null;
  baseBranch: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  requestedReviewTeamSlugs: string[];
}

export function mapPullRequestSnapshot(
  data: unknown,
  coordinates: PullRequestCoordinates,
  createError: (message: string) => Error,
): PullRequestSnapshot {
  const value = requireRecord(data, "pull request response", createError);
  const user = requireRecord(value.user, "pull request response.user", createError);
  const head = requireRecord(value.head, "pull request response.head", createError);
  const base = requireRecord(value.base, "pull request response.base", createError);
  const number = readInteger(value.number, "pull request response.number", createError);

  if (number !== coordinates.number) {
    throw createError(
      `GitHub returned a mismatched pull request number for ${formatPullRequestLabel(coordinates)}`,
    );
  }

  return {
    githubPullRequestId: readInteger(value.id, "pull request response.id", createError),
    repositoryOwner: coordinates.repositoryOwner,
    repositoryName: coordinates.repositoryName,
    number,
    url: readString(value.html_url, "pull request response.html_url", createError),
    authorLogin: readString(user.login, "pull request response.user.login", createError),
    authorAvatarUrl: readNullableString(
      user.avatar_url,
      "pull request response.user.avatar_url",
      createError,
    ),
    title: readString(value.title, "pull request response.title", createError),
    state: readString(value.state, "pull request response.state", createError),
    isDraft: readBoolean(value.draft, "pull request response.draft", createError),
    closedAt: readNullableString(value.closed_at, "pull request response.closed_at", createError),
    mergedAt: readNullableString(value.merged_at, "pull request response.merged_at", createError),
    lastSeenHeadSha: readNullableString(head.sha, "pull request response.head.sha", createError),
    baseBranch: readNullableString(base.ref, "pull request response.base.ref", createError),
    mergeable: readNullableBoolean(value.mergeable, "pull request response.mergeable", createError),
    mergeableState: readNullableString(
      value.mergeable_state,
      "pull request response.mergeable_state",
      createError,
    ),
    requestedReviewTeamSlugs: readRequestedReviewTeamSlugs(
      value.requested_teams,
      "pull request response.requested_teams",
      createError,
    ),
  };
}

export function createPullRequestUpsertInput(
  snapshot: PullRequestSnapshot,
  overrides: Partial<Pick<UpsertPullRequestInput, "lastSeenAt" | "graceUntil" | "tracking">> = {},
): UpsertPullRequestInput {
  return {
    githubPullRequestId: snapshot.githubPullRequestId,
    repositoryOwner: snapshot.repositoryOwner,
    repositoryName: snapshot.repositoryName,
    number: snapshot.number,
    url: snapshot.url,
    authorLogin: snapshot.authorLogin,
    authorAvatarUrl: snapshot.authorAvatarUrl,
    title: snapshot.title,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    closedAt: snapshot.closedAt,
    mergedAt: snapshot.mergedAt,
    lastSeenHeadSha: snapshot.lastSeenHeadSha,
    baseBranch: snapshot.baseBranch,
    mergeable: snapshot.mergeable,
    mergeableState: snapshot.mergeableState,
    requestedReviewTeamSlugs: snapshot.requestedReviewTeamSlugs,
    ...(overrides.lastSeenAt === undefined ? {} : { lastSeenAt: overrides.lastSeenAt }),
    ...(overrides.graceUntil === undefined ? {} : { graceUntil: overrides.graceUntil }),
    ...(overrides.tracking === undefined ? {} : { tracking: overrides.tracking }),
  };
}

function formatPullRequestLabel(coordinates: PullRequestCoordinates): string {
  return `${coordinates.repositoryOwner}/${coordinates.repositoryName}#${coordinates.number}`;
}

function requireRecord(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createError(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readInteger(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const numericValue = Number(value);

    if (Number.isSafeInteger(numericValue)) {
      return numericValue;
    }
  }

  throw createError(`${fieldName} must be a safe integer`);
}

function readString(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): string {
  if (typeof value !== "string") {
    throw createError(`${fieldName} must be a string`);
  }

  return value;
}

function readNullableString(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, fieldName, createError);
}

function readBoolean(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): boolean {
  if (typeof value !== "boolean") {
    throw createError(`${fieldName} must be a boolean`);
  }

  return value;
}

function readNullableBoolean(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): boolean | null {
  if (value === null) {
    return null;
  }

  return readBoolean(value, fieldName, createError);
}

function readRequestedReviewTeamSlugs(
  value: unknown,
  fieldName: string,
  createError: (message: string) => Error,
): string[] {
  if (!Array.isArray(value)) {
    throw createError(`${fieldName} must be an array`);
  }

  return value.map((entry, index) => {
    const team = requireRecord(entry, `${fieldName}[${index}]`, createError);
    return readString(team.slug, `${fieldName}[${index}].slug`, createError);
  });
}
