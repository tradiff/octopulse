// Synthetic, sanitized GitHub payloads shared across activity tests.

const DEFAULT_REPOSITORY_OWNER = "acme";
const DEFAULT_REPOSITORY_NAME = "octopulse";
const DEFAULT_PULL_REQUEST_NUMBER = 7;

interface IssueCommentFixtureOverrides {
  id?: number;
  actorLogin?: string;
  actorType?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
}

interface ReviewFixtureOverrides {
  id?: number;
  actorLogin?: string;
  actorType?: string;
  state?: string;
  body?: string;
  submittedAt?: string | null;
  url?: string;
}

interface ReviewCommentFixtureOverrides {
  id?: number;
  actorLogin?: string;
  actorType?: string;
  reviewId?: number;
  inReplyToCommentId?: number;
  body?: string;
  path?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
}

interface TimelineEventFixtureOverrides {
  id?: number;
  actorLogin?: string;
  actorType?: string;
  event?: string;
  createdAt?: string;
}

interface CommittedTimelineEventFixtureOverrides {
  actorLogin?: string;
  actorType?: string;
  sha?: string;
  message?: string;
  committedAt?: string;
  url?: string;
}

interface WorkflowRunFixtureOverrides {
  id?: number;
  actorLogin?: string;
  actorType?: string;
  headSha?: string;
  status?: string;
  conclusion?: string | null;
  updatedAt?: string;
  createdAt?: string;
  name?: string;
  url?: string;
}

export function createIssueCommentFixture(
  overrides: IssueCommentFixtureOverrides = {},
): Record<string, unknown> {
  const id = overrides.id ?? 1001;
  const createdAt = overrides.createdAt ?? "2026-04-10T12:01:00.000Z";
  const updatedAt = overrides.updatedAt ?? createdAt;

  return {
    id,
    user: createIdentityFixture({
      login: overrides.actorLogin ?? "alice",
      type: overrides.actorType ?? "User",
    }),
    created_at: createdAt,
    updated_at: updatedAt,
    body: overrides.body ?? "Ship it",
    html_url: overrides.url ?? buildPullRequestUrl(`#issuecomment-${id}`),
  };
}

export function createReviewFixture(
  overrides: ReviewFixtureOverrides = {},
): Record<string, unknown> {
  const id = overrides.id ?? 2001;
  const submittedAt = overrides.submittedAt === undefined
    ? "2026-04-10T12:02:00.000Z"
    : overrides.submittedAt;

  return {
    id,
    user: createIdentityFixture({
      login: overrides.actorLogin ?? "bob",
      type: overrides.actorType ?? "User",
    }),
    state: overrides.state ?? "APPROVED",
    submitted_at: submittedAt,
    body: overrides.body ?? "Looks good to me",
    html_url: overrides.url ?? buildPullRequestUrl(`#pullrequestreview-${id}`),
  };
}

export function createReviewCommentFixture(
  overrides: ReviewCommentFixtureOverrides = {},
): Record<string, unknown> {
  const id = overrides.id ?? 3001;
  const createdAt = overrides.createdAt ?? "2026-04-10T12:04:00.000Z";
  const updatedAt = overrides.updatedAt ?? createdAt;

  return {
    id,
    user: createIdentityFixture({
      login: overrides.actorLogin ?? "carol",
      type: overrides.actorType ?? "User",
    }),
    ...(overrides.reviewId === undefined
      ? {}
      : { pull_request_review_id: overrides.reviewId }),
    ...(overrides.inReplyToCommentId === undefined
      ? {}
      : { in_reply_to_id: overrides.inReplyToCommentId }),
    created_at: createdAt,
    updated_at: updatedAt,
    body: overrides.body ?? "Inline note",
    path: overrides.path ?? "src/main.ts",
    html_url: overrides.url ?? buildPullRequestUrl(`#discussion_r${id}`),
  };
}

export function createTimelineEventFixture(
  overrides: TimelineEventFixtureOverrides = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 4001,
    actor: createIdentityFixture({
      login: overrides.actorLogin ?? "octocat",
      type: overrides.actorType ?? "User",
    }),
    event: overrides.event ?? "merged",
    created_at: overrides.createdAt ?? "2026-04-10T12:05:00.000Z",
  };
}

export function createCommittedTimelineEventFixture(
  overrides: CommittedTimelineEventFixtureOverrides = {},
): Record<string, unknown> {
  const sha = overrides.sha ?? "feedface";
  const committedAt = overrides.committedAt ?? "2026-04-10T12:07:00.000Z";

  return {
    event: "committed",
    sha,
    node_id: `C_${sha}`,
    html_url: overrides.url ?? buildCommitUrl(sha),
    author: createIdentityFixture({
      login: overrides.actorLogin ?? "octocat",
      type: overrides.actorType ?? "User",
    }),
    committer: createIdentityFixture({
      login: overrides.actorLogin ?? "octocat",
      type: overrides.actorType ?? "User",
    }),
    commit: {
      message: overrides.message ?? "Refactor notification bundle",
      author: {
        date: committedAt,
      },
      committer: {
        date: committedAt,
      },
    },
  };
}

export function createWorkflowRunFixture(
  overrides: WorkflowRunFixtureOverrides = {},
): Record<string, unknown> {
  const id = overrides.id ?? 5001;
  const updatedAt = overrides.updatedAt ?? "2026-04-10T12:08:00.000Z";
  const createdAt = overrides.createdAt ?? updatedAt;
  const conclusion = overrides.conclusion === undefined ? "success" : overrides.conclusion;

  return {
    id,
    name: overrides.name ?? "CI",
    actor: createIdentityFixture({
      login: overrides.actorLogin ?? "github-actions[bot]",
      type: overrides.actorType ?? "Bot",
    }),
    head_sha: overrides.headSha ?? "abc123",
    status: overrides.status ?? "completed",
    conclusion,
    updated_at: updatedAt,
    created_at: createdAt,
    html_url: overrides.url ?? buildActionsRunUrl(id),
  };
}

function createIdentityFixture(input: { login: string; type?: string }): Record<string, string> {
  return input.type === undefined
    ? { login: input.login }
    : { login: input.login, type: input.type };
}

function buildPullRequestUrl(fragment: string): string {
  return `https://github.com/${DEFAULT_REPOSITORY_OWNER}/${DEFAULT_REPOSITORY_NAME}/pull/${DEFAULT_PULL_REQUEST_NUMBER}${fragment}`;
}

function buildCommitUrl(sha: string): string {
  return `https://github.com/${DEFAULT_REPOSITORY_OWNER}/${DEFAULT_REPOSITORY_NAME}/commit/${sha}`;
}

function buildActionsRunUrl(id: number): string {
  return `https://github.com/${DEFAULT_REPOSITORY_OWNER}/${DEFAULT_REPOSITORY_NAME}/actions/runs/${id}`;
}
