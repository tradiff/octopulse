import type { PullRequestRecord } from "./pull-request-repository.js";

export type PullRequestLifecycleState = "open" | "merged" | "closed";
export type PullRequestVisualState = "open" | "draft" | "merged" | "closed";

export type PullRequestLifecycleStateLike = Pick<PullRequestRecord, "state" | "mergedAt">;
export type PullRequestStateLike = PullRequestLifecycleStateLike & Pick<PullRequestRecord, "isDraft">;

export const PULL_REQUEST_STATE_ASSET_FILENAMES = {
  open: "pull-request-open.svg",
  draft: "pull-request-draft.svg",
  merged: "pull-request-merged.svg",
  closed: "pull-request-closed.svg",
} as const satisfies Record<PullRequestVisualState, string>;

export function resolvePullRequestVisualState(
  pullRequest: PullRequestStateLike,
): PullRequestVisualState {
  const lifecycleState = resolvePullRequestLifecycleState(pullRequest);

  if (lifecycleState === "merged") {
    return "merged";
  }

  if (lifecycleState === "closed") {
    return "closed";
  }

  if (pullRequest.isDraft) {
    return "draft";
  }

  return "open";
}

export function resolvePullRequestLifecycleState(
  pullRequest: PullRequestLifecycleStateLike,
): PullRequestLifecycleState {
  if (pullRequest.mergedAt !== null) {
    return "merged";
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
