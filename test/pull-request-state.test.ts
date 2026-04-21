import { describe, expect, it } from "vitest";

import {
  formatPullRequestStateLabel,
  resolvePullRequestStateAssetFilename,
  resolvePullRequestVisualState,
} from "../src/pull-request-state.js";

describe("pull request state helpers", () => {
  it("prefers draft over open state", () => {
    const pullRequest = { state: "open", isDraft: true, mergedAt: null };

    expect(resolvePullRequestVisualState(pullRequest)).toBe("draft");
    expect(formatPullRequestStateLabel(pullRequest)).toBe("Draft");
    expect(resolvePullRequestStateAssetFilename(pullRequest)).toBe("pull-request-draft.svg");
  });

  it("prefers merged over closed state", () => {
    const pullRequest = { state: "closed", isDraft: false, mergedAt: "2026-04-20T12:00:00.000Z" };

    expect(resolvePullRequestVisualState(pullRequest)).toBe("merged");
    expect(formatPullRequestStateLabel(pullRequest)).toBe("Merged");
    expect(resolvePullRequestStateAssetFilename(pullRequest)).toBe("pull-request-merged.svg");
  });

  it("returns closed or open when there is no higher-priority state", () => {
    expect(resolvePullRequestVisualState({ state: "closed", isDraft: false, mergedAt: null })).toBe("closed");
    expect(resolvePullRequestStateAssetFilename({ state: "open", isDraft: false, mergedAt: null })).toBe(
      "pull-request-open.svg",
    );
  });
});
