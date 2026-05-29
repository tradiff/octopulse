interface PullRequestDetailFixtureOverrides {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  closedAt?: string | null;
  mergedAt?: string | null;
  headSha?: string | null;
  baseBranch?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  requestedReviewTeamSlugs?: string[];
  authorLogin?: string;
  authorAvatarUrl?: string | null;
  url?: string;
}

export function createPullRequestDetailFixture(
  overrides: PullRequestDetailFixtureOverrides = {},
): Record<string, unknown> {
  const number = overrides.number ?? 7;

  return {
    id: overrides.id ?? 101,
    number,
    html_url: overrides.url ?? `https://github.com/acme/octopulse/pull/${number}`,
    user: {
      login: overrides.authorLogin ?? "octocat",
      avatar_url: overrides.authorAvatarUrl ?? "https://avatars.example.test/octocat.png",
    },
    title: overrides.title ?? "Refresh pull request polling",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    closed_at: overrides.closedAt ?? null,
    merged_at: overrides.mergedAt ?? null,
    head: {
      sha: overrides.headSha ?? "def456",
    },
    base: {
      ref: overrides.baseBranch ?? "main",
    },
    mergeable: overrides.mergeable ?? true,
    mergeable_state: overrides.mergeableState ?? "clean",
    requested_teams: (overrides.requestedReviewTeamSlugs ?? []).map((slug) => ({ slug })),
  };
}
