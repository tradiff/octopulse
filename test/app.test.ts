import { describe, expect, it } from "vitest";

import { renderAppDocument } from "../src/app.js";

describe("renderAppDocument", () => {
  it("renders tracked and inactive pull request lists", () => {
    const html = renderAppDocument({
      trackedPullRequests: [
        createPullRequestRecord({
          githubPullRequestId: 101,
          title: "Track recurring discovery output",
          repositoryName: "octopulse",
          number: 7,
          state: "open",
        }),
      ],
      inactivePullRequests: [
        createPullRequestRecord({
          id: 2,
          githubPullRequestId: 202,
          title: "Keep merged pull requests visible during grace period",
          repositoryName: "worker",
          number: 18,
          state: "closed",
          isTracked: false,
          isStickyUntracked: true,
        }),
      ],
    });

    expect(html).toContain("Tracked Pull Requests");
    expect(html).toContain("Inactive Pull Requests");
    expect(html).toContain("acme/octopulse #7");
    expect(html).toContain("acme/worker #18");
    expect(html).toContain("Track recurring discovery output");
    expect(html).toContain("Keep merged pull requests visible during grace period");
    expect(html).toContain("Open");
    expect(html).toContain("Closed");
  });

  it("renders empty-state messages when no pull requests are available", () => {
    const html = renderAppDocument();

    expect(html).toContain("No tracked pull requests yet.");
    expect(html).toContain("No inactive pull requests yet.");
  });
});

function createPullRequestRecord(
  overrides: Partial<{
    id: number;
    githubPullRequestId: number;
    repositoryOwner: string;
    repositoryName: string;
    number: number;
    url: string;
    authorLogin: string;
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
  }> = {},
) {
  return {
    id: 1,
    githubPullRequestId: 101,
    repositoryOwner: "acme",
    repositoryName: "octopulse",
    number: 7,
    url: "https://github.com/acme/octopulse/pull/7",
    authorLogin: "octocat",
    title: "Add pull request polling",
    state: "open",
    isDraft: false,
    isTracked: true,
    trackingReason: "manual",
    isStickyUntracked: false,
    lastSeenAt: "2026-04-10T12:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    graceUntil: null,
    lastSeenHeadSha: "abc123",
    createdAt: "2026-04-10 12:00:00",
    updatedAt: "2026-04-10 12:00:00",
    ...overrides,
  };
}
