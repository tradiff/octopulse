import { fileURLToPath } from "node:url";

import {
  PULL_REQUEST_STATE_ASSET_FILENAMES,
  resolvePullRequestStateAssetFilename,
  type PullRequestStateLike,
} from "./pull-request-state.js";

export type PullRequestStateAssetFilename =
  (typeof PULL_REQUEST_STATE_ASSET_FILENAMES)[keyof typeof PULL_REQUEST_STATE_ASSET_FILENAMES];

const PULL_REQUEST_STATE_ASSET_FILENAME_SET = new Set<PullRequestStateAssetFilename>(
  Object.values(PULL_REQUEST_STATE_ASSET_FILENAMES),
);

export function resolvePullRequestStateAssetFilePath(pullRequest: PullRequestStateLike): string {
  return resolvePullRequestStateAssetFilePathByFilename(resolvePullRequestStateAssetFilename(pullRequest));
}

export function resolvePullRequestStateAssetUrlPath(pullRequest: PullRequestStateLike): string {
  return `/assets/${resolvePullRequestStateAssetFilename(pullRequest)}`;
}

export function resolvePullRequestStateAssetFilePathByFilename(
  filename: PullRequestStateAssetFilename,
): string {
  return fileURLToPath(new URL(`../assets/${filename}`, import.meta.url));
}

export function isPullRequestStateAssetFilename(
  filename: string,
): filename is PullRequestStateAssetFilename {
  return PULL_REQUEST_STATE_ASSET_FILENAME_SET.has(filename as PullRequestStateAssetFilename);
}
