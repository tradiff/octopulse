import { describe, expect, it } from "vitest";

import {
  createPullRequestUpsertInput,
  mapPullRequestSnapshot,
} from "../src/pull-request-snapshot.js";
import { createPullRequestDetailFixture } from "./fixtures/github-pull-request-detail.js";

describe("pull-request snapshot helpers", () => {
  it("maps a GitHub pull request response into one shared snapshot", () => {
    expect(
      mapPullRequestSnapshot(
        createPullRequestDetailFixture({
          id: 101,
          number: 7,
          title: "Refresh pull request polling",
          state: "open",
          draft: false,
          closedAt: null,
          mergedAt: null,
          headSha: "def456",
          baseBranch: "main",
          mergeable: true,
          mergeableState: "clean",
          requestedReviewTeamSlugs: ["quality-processing-squad"],
        }),
        {
          repositoryOwner: "acme",
          repositoryName: "octopulse",
          number: 7,
        },
        (message) => new Error(message),
      ),
    ).toEqual({
      githubPullRequestId: 101,
      repositoryOwner: "acme",
      repositoryName: "octopulse",
      number: 7,
      url: "https://github.com/acme/octopulse/pull/7",
      authorLogin: "octocat",
      authorAvatarUrl: "https://avatars.example.test/octocat.png",
      title: "Refresh pull request polling",
      state: "open",
      isDraft: false,
      closedAt: null,
      mergedAt: null,
      lastSeenHeadSha: "def456",
      baseBranch: "main",
      mergeable: true,
      mergeableState: "clean",
      requestedReviewTeamSlugs: ["quality-processing-squad"],
    });
  });

  it("builds repository input from the shared snapshot", () => {
    expect(
      createPullRequestUpsertInput(
        {
          githubPullRequestId: 101,
          repositoryOwner: "acme",
          repositoryName: "octopulse",
          number: 7,
          url: "https://github.com/acme/octopulse/pull/7",
          authorLogin: "octocat",
          authorAvatarUrl: "https://avatars.example.test/octocat.png",
          title: "Refresh pull request polling",
          state: "open",
          isDraft: false,
          closedAt: null,
          mergedAt: null,
          lastSeenHeadSha: "def456",
          baseBranch: "main",
          mergeable: true,
          mergeableState: "clean",
          requestedReviewTeamSlugs: ["quality-processing-squad"],
        },
        {
          lastSeenAt: "2026-04-10T12:00:00.000Z",
          graceUntil: null,
          tracking: {
            isTracked: true,
            trackingReason: "manual",
            isStickyUntracked: false,
          },
        },
      ),
    ).toEqual({
      githubPullRequestId: 101,
      repositoryOwner: "acme",
      repositoryName: "octopulse",
      number: 7,
      url: "https://github.com/acme/octopulse/pull/7",
      authorLogin: "octocat",
      authorAvatarUrl: "https://avatars.example.test/octocat.png",
      title: "Refresh pull request polling",
      state: "open",
      isDraft: false,
      closedAt: null,
      mergedAt: null,
      lastSeenHeadSha: "def456",
      baseBranch: "main",
      mergeable: true,
      mergeableState: "clean",
      requestedReviewTeamSlugs: ["quality-processing-squad"],
      lastSeenAt: "2026-04-10T12:00:00.000Z",
      graceUntil: null,
      tracking: {
        isTracked: true,
        trackingReason: "manual",
        isStickyUntracked: false,
      },
    });
  });
});
