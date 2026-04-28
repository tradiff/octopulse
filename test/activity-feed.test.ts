import { describe, expect, it } from "vitest";

import {
  buildPullRequestStateSqlFilter,
  matchesPullRequestStateFilter,
} from "../src/activity-feed.js";

const SQL_COLUMNS = {
  tracked: "pull_request.is_tracked",
  state: "pull_request.state",
  mergedAt: "pull_request.merged_at",
} as const;

describe("matchesPullRequestStateFilter", () => {
  it("matches tracking filters", () => {
    expect(
      matchesPullRequestStateFilter("tracked", {
        isTracked: true,
        pullRequestStatus: "open",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilter("inactive", {
        isTracked: false,
        pullRequestStatus: "open",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilter("tracked", {
        isTracked: null,
        pullRequestStatus: null,
      }),
    ).toBe(false);
  });

  it("matches open, merged, and closed filters", () => {
    expect(
      matchesPullRequestStateFilter("open", {
        isTracked: true,
        pullRequestStatus: "open",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilter("merged", {
        isTracked: true,
        pullRequestStatus: "merged",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilter("closed", {
        isTracked: false,
        pullRequestStatus: "closed",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilter("open", {
        isTracked: true,
        pullRequestStatus: "merged",
      }),
    ).toBe(false);
  });
});

describe("buildPullRequestStateSqlFilter", () => {
  it("builds lifecycle filter clauses", () => {
    expect(buildPullRequestStateSqlFilter("open", SQL_COLUMNS)).toEqual({
      clauses: ["pull_request.merged_at IS NULL", "LOWER(pull_request.state) <> 'closed'"],
      parameters: [],
    });
    expect(buildPullRequestStateSqlFilter("merged", SQL_COLUMNS)).toEqual({
      clauses: ["pull_request.merged_at IS NOT NULL"],
      parameters: [],
    });
    expect(buildPullRequestStateSqlFilter("closed", SQL_COLUMNS)).toEqual({
      clauses: ["pull_request.merged_at IS NULL", "LOWER(pull_request.state) = 'closed'"],
      parameters: [],
    });
  });
});
