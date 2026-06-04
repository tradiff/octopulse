import { describe, expect, it } from "vitest";

import {
  doesPullRequestNeedMyReview,
  isPullRequestInReviewRequestedQueue,
} from "../src/pull-request-review-targeting.js";

describe("isPullRequestInReviewRequestedQueue", () => {
  it("returns true for pull requests not authored by the current user", () => {
    expect(
      isPullRequestInReviewRequestedQueue(
        {
          authorLogin: "alice",
        },
        "octocat",
      ),
    ).toBe(true);
  });

  it("returns false for pull requests authored by the current user", () => {
    expect(
      isPullRequestInReviewRequestedQueue(
        {
          authorLogin: "OctoCat",
        },
        "octocat",
      ),
    ).toBe(false);
  });
});

describe("doesPullRequestNeedMyReview", () => {
  it("returns true for open pull requests directly requested from the current user", () => {
    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "alice",
          state: "open",
          mergedAt: null,
          requestedReviewerLogins: ["OctoCat"],
          requestedReviewTeamKeys: [],
        },
        "octocat",
        [],
      ),
    ).toBe(true);
  });

  it("returns true for open pull requests requested from one of the current user's teams", () => {
    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "alice",
          state: "open",
          mergedAt: null,
          requestedReviewerLogins: [],
          requestedReviewTeamKeys: ["acme/owners"],
        },
        "octocat",
        ["acme/owners"],
      ),
    ).toBe(true);
  });

  it("returns false when there is no current direct or team request", () => {
    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "alice",
          state: "open",
          mergedAt: null,
          requestedReviewerLogins: [],
          requestedReviewTeamKeys: [],
        },
        "octocat",
        ["acme/owners"],
      ),
    ).toBe(false);
  });

  it("returns false for pull requests authored by the current user", () => {
    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "OctoCat",
          state: "open",
          mergedAt: null,
          requestedReviewerLogins: ["octocat"],
          requestedReviewTeamKeys: ["acme/owners"],
        },
        "octocat",
        ["acme/owners"],
      ),
    ).toBe(false);
  });

  it("returns false for closed or merged pull requests", () => {
    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "alice",
          state: "closed",
          mergedAt: null,
          requestedReviewerLogins: ["octocat"],
          requestedReviewTeamKeys: [],
        },
        "octocat",
        [],
      ),
    ).toBe(false);

    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "alice",
          state: "open",
          mergedAt: "2026-04-10T12:00:00.000Z",
          requestedReviewerLogins: ["octocat"],
          requestedReviewTeamKeys: [],
        },
        "octocat",
        [],
      ),
    ).toBe(false);
  });

  it("does not care whether the pull request is draft or dirty", () => {
    expect(
      doesPullRequestNeedMyReview(
        {
          authorLogin: "alice",
          state: "open",
          mergedAt: null,
          requestedReviewerLogins: [],
          requestedReviewTeamKeys: ["acme/owners"],
        },
        "octocat",
        ["acme/owners"],
      ),
    ).toBe(true);
  });
});
