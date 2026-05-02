import { describe, expect, it } from "vitest";

import {
  buildPullRequestStateSqlFilter,
  isAllPullRequestStateFilterSelection,
  matchesPullRequestStateFilter,
  matchesPullRequestStateFilters,
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

describe("matchesPullRequestStateFilters", () => {
  it("matches with OR inside a category and AND across categories", () => {
    expect(
      matchesPullRequestStateFilters([], {
        isTracked: false,
        pullRequestStatus: "closed",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilters(["tracked", "open"], {
        isTracked: true,
        pullRequestStatus: "open",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilters(["tracked", "merged"], {
        isTracked: false,
        pullRequestStatus: "merged",
      }),
    ).toBe(false);
    expect(
      matchesPullRequestStateFilters(["tracked", "open"], {
        isTracked: true,
        pullRequestStatus: "closed",
      }),
    ).toBe(false);
    expect(
      matchesPullRequestStateFilters(["open", "merged"], {
        isTracked: false,
        pullRequestStatus: "merged",
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilters(["tracked", "inactive"], {
        isTracked: null,
        pullRequestStatus: null,
      }),
    ).toBe(true);
    expect(
      matchesPullRequestStateFilters(["tracked", "inactive", "open", "merged", "closed"], {
        isTracked: false,
        pullRequestStatus: "closed",
      }),
    ).toBe(true);
  });
});

describe("isAllPullRequestStateFilterSelection", () => {
  it("treats no-op category selections as the all state", () => {
    expect(isAllPullRequestStateFilterSelection([])).toBe(true);
    expect(isAllPullRequestStateFilterSelection(["tracked", "inactive"])).toBe(true);
    expect(isAllPullRequestStateFilterSelection(["open", "merged", "closed"])).toBe(true);
    expect(isAllPullRequestStateFilterSelection(["tracked", "merged"])).toBe(false);
    expect(
      isAllPullRequestStateFilterSelection(["tracked", "inactive", "open", "merged", "closed"]),
    ).toBe(true);
  });
});

describe("buildPullRequestStateSqlFilter", () => {
  it("returns no clauses when a selection is effectively all", () => {
    expect(buildPullRequestStateSqlFilter([], SQL_COLUMNS)).toEqual({
      clauses: [],
      parameters: [],
    });
    expect(buildPullRequestStateSqlFilter(["tracked", "inactive"], SQL_COLUMNS)).toEqual({
      clauses: [],
      parameters: [],
    });
    expect(buildPullRequestStateSqlFilter(["open", "merged", "closed"], SQL_COLUMNS)).toEqual({
      clauses: [],
      parameters: [],
    });
    expect(
      buildPullRequestStateSqlFilter(["tracked", "inactive", "open", "merged", "closed"], SQL_COLUMNS),
    ).toEqual({
      clauses: [],
      parameters: [],
    });
  });

  it("builds lifecycle filter clauses", () => {
    expect(buildPullRequestStateSqlFilter(["open"], SQL_COLUMNS)).toEqual({
      clauses: ["((pull_request.merged_at IS NULL AND LOWER(pull_request.state) <> 'closed'))"],
      parameters: [],
    });
    expect(buildPullRequestStateSqlFilter(["merged"], SQL_COLUMNS)).toEqual({
      clauses: ["((pull_request.merged_at IS NOT NULL))"],
      parameters: [],
    });
    expect(buildPullRequestStateSqlFilter(["closed"], SQL_COLUMNS)).toEqual({
      clauses: ["((pull_request.merged_at IS NULL AND LOWER(pull_request.state) = 'closed'))"],
      parameters: [],
    });
  });

  it("builds OR clauses within a category", () => {
    expect(buildPullRequestStateSqlFilter(["open", "merged"], SQL_COLUMNS)).toEqual({
      clauses: [
        "((pull_request.merged_at IS NULL AND LOWER(pull_request.state) <> 'closed') OR (pull_request.merged_at IS NOT NULL))",
      ],
      parameters: [],
    });
  });

  it("builds separate clauses for tracking and lifecycle filters", () => {
    expect(buildPullRequestStateSqlFilter(["tracked", "merged"], SQL_COLUMNS)).toEqual({
      clauses: ["((pull_request.is_tracked = ?))", "((pull_request.merged_at IS NOT NULL))"],
      parameters: [1],
    });
  });
});
