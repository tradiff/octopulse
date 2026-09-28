import { describe, expect, it } from "vitest";

import { buildPullRequestInteractionGroups } from "../src/pull-request-interaction-groups.js";
import type { PullRequestReviewStateRecord } from "../src/pull-request-review-state-repository.js";

const reviews: PullRequestReviewStateRecord[] = [
  {
    id: 1,
    pullRequestId: 7,
    reviewerLogin: "tradiff",
    reviewerAvatarUrl: "https://avatars.example.test/tradiff.png",
    reviewState: "CHANGES_REQUESTED",
    updatedAt: "2026-04-10 12:05:00",
  },
  {
    id: 2,
    pullRequestId: 7,
    reviewerLogin: "alice",
    reviewerAvatarUrl: null,
    reviewState: "APPROVED",
    updatedAt: "2026-04-10 12:06:00",
  },
];

describe("buildPullRequestInteractionGroups", () => {
  it("shows re-requested reviewers as pending instead of decliners while preserving other decisions", () => {
    expect(buildPullRequestInteractionGroups([], reviews, {
      state: "open",
      mergedAt: null,
      requestedReviewerLogins: ["TraDiff"],
    })).toEqual([
      { kind: "approvers", label: "Approvers", actors: [{ login: "alice", avatarUrl: null }] },
      {
        kind: "requested",
        label: "Requested Reviewers",
        actors: [{ login: "TraDiff", avatarUrl: "https://avatars.example.test/tradiff.png" }],
      },
    ]);
  });

  it("restores the last submitted decision when no review is pending", () => {
    expect(buildPullRequestInteractionGroups([], reviews, {
      state: "open",
      mergedAt: null,
      requestedReviewerLogins: [],
    })).toEqual([
      { kind: "approvers", label: "Approvers", actors: [{ login: "alice", avatarUrl: null }] },
      {
        kind: "decliners",
        label: "Decliners",
        actors: [{ login: "tradiff", avatarUrl: "https://avatars.example.test/tradiff.png" }],
      },
    ]);
  });

  it("does not show pending review badges for a closed pull request", () => {
    expect(buildPullRequestInteractionGroups([], reviews, {
      state: "closed",
      mergedAt: null,
      requestedReviewerLogins: ["tradiff"],
    }).map((group) => group.kind)).toEqual(["approvers", "decliners"]);
  });
});
