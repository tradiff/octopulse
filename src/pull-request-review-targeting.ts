import type { PullRequestRecord } from "./pull-request-repository.js";

export function isPullRequestAuthoredByCurrentUser(
  pullRequest: Pick<PullRequestRecord, "authorLogin">,
  currentUserLogin: string,
): boolean {
  return normalizeLogin(pullRequest.authorLogin) === normalizeLogin(currentUserLogin);
}

export function isPullRequestInReviewRequestedQueue(
  pullRequest: Pick<PullRequestRecord, "authorLogin">,
  currentUserLogin: string,
): boolean {
  return !isPullRequestAuthoredByCurrentUser(pullRequest, currentUserLogin);
}

export function doesPullRequestNeedMyReview(
  pullRequest: Pick<
    PullRequestRecord,
    | "authorLogin"
    | "state"
    | "mergedAt"
    | "requestedReviewerLogins"
    | "requestedReviewTeamKeys"
  >,
  currentUserLogin: string,
  currentUserTeamKeys: readonly string[],
): boolean {
  if (!isPullRequestInReviewRequestedQueue(pullRequest, currentUserLogin)) {
    return false;
  }

  if (pullRequest.state !== "open" || pullRequest.mergedAt !== null) {
    return false;
  }

  const normalizedCurrentUserLogin = normalizeLogin(currentUserLogin);
  const normalizedCurrentUserTeamKeys = new Set(currentUserTeamKeys.map(normalizeLogin));

  return (
    pullRequest.requestedReviewerLogins.some((login) => normalizeLogin(login) === normalizedCurrentUserLogin) ||
    pullRequest.requestedReviewTeamKeys.some((teamKey) => normalizedCurrentUserTeamKeys.has(normalizeLogin(teamKey)))
  );
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}
