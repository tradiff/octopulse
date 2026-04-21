import type { PullRequestRecord } from "./pull-request-repository.js";

export type PullRequestVisualState = "open" | "draft" | "merged" | "closed";

export type PullRequestStateLike = Pick<PullRequestRecord, "state" | "isDraft" | "mergedAt">;

export const PULL_REQUEST_STATE_ASSET_FILENAMES = {
  open: "pull-request-open.svg",
  draft: "pull-request-draft.svg",
  merged: "pull-request-merged.svg",
  closed: "pull-request-closed.svg",
} as const satisfies Record<PullRequestVisualState, string>;

export function resolvePullRequestVisualState(
  pullRequest: PullRequestStateLike,
): PullRequestVisualState {
  if (pullRequest.mergedAt !== null) {
    return "merged";
  }

  if (pullRequest.isDraft) {
    return "draft";
  }

  return pullRequest.state.toLowerCase() === "closed" ? "closed" : "open";
}

export function formatPullRequestStateLabel(pullRequest: PullRequestStateLike): string {
  const state = resolvePullRequestVisualState(pullRequest);
  return `${state[0]!.toUpperCase()}${state.slice(1)}`;
}

export function resolvePullRequestStateAssetFilename(
  pullRequest: PullRequestStateLike,
): (typeof PULL_REQUEST_STATE_ASSET_FILENAMES)[PullRequestVisualState] {
  return PULL_REQUEST_STATE_ASSET_FILENAMES[resolvePullRequestVisualState(pullRequest)];
}

export function resolvePullRequestStateAssetUrlPath(pullRequest: PullRequestStateLike): string {
  return `/assets/${resolvePullRequestStateAssetFilename(pullRequest)}`;
}
