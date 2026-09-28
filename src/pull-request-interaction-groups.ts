import type { PullRequestRecord } from "./pull-request-repository.js";
import type { PullRequestReviewStateRecord, ReviewState } from "./pull-request-review-state-repository.js";
import type { PullRequestTimelineEntry } from "./raw-events.js";

const PULL_REQUEST_COMMENTER_EVENT_TYPES = new Set([
  "issue_comment",
  "review_inline_comment",
  "review_submitted",
  "review_approved",
  "review_changes_requested",
]);

export type PullRequestInteractionGroupKind = "approvers" | "commenters" | "decliners" | "requested";

interface PullRequestInteractionActor {
  login: string;
  avatarUrl: string | null;
}

export interface PullRequestInteractionGroup {
  kind: PullRequestInteractionGroupKind;
  label: string;
  actors: PullRequestInteractionActor[];
}

export function buildPullRequestInteractionGroups(
  entries: PullRequestTimelineEntry[],
  reviewStates: PullRequestReviewStateRecord[],
  pullRequest: Pick<PullRequestRecord, "state" | "mergedAt" | "requestedReviewerLogins">,
): PullRequestInteractionGroup[] {
  const requestedReviewers = pullRequest.state === "open" && pullRequest.mergedAt === null
    ? pullRequest.requestedReviewerLogins
        .filter((login) => !isBotActorLogin(login))
        .map((login) => ({
          login,
          avatarUrl: reviewStates.find((review) => review.reviewerLogin.toLowerCase() === login.toLowerCase())
            ?.reviewerAvatarUrl ?? null,
        }))
    : [];
  const requestedLogins = new Set(requestedReviewers.map((actor) => actor.login.toLowerCase()));
  const approvers = collectActorsWithReviewState(reviewStates, "APPROVED")
    .filter((actor) => !requestedLogins.has(actor.login.toLowerCase()));
  const decliners = collectActorsWithReviewState(reviewStates, "CHANGES_REQUESTED")
    .filter((actor) => !requestedLogins.has(actor.login.toLowerCase()));

  const formalReviewerLogins = new Set([
    ...approvers.map((actor) => actor.login.toLowerCase()),
    ...decliners.map((actor) => actor.login.toLowerCase()),
    ...requestedLogins,
  ]);

  const commenters = collectCommenters(entries, formalReviewerLogins);

  const groups: PullRequestInteractionGroup[] = [];

  if (approvers.length > 0) {
    groups.push({ kind: "approvers", label: "Approvers", actors: approvers });
  }

  if (commenters.length > 0) {
    groups.push({ kind: "commenters", label: "Commenters / Reviewers", actors: commenters });
  }

  if (decliners.length > 0) {
    groups.push({ kind: "decliners", label: "Decliners", actors: decliners });
  }

  if (requestedReviewers.length > 0) {
    groups.push({ kind: "requested", label: "Requested Reviewers", actors: requestedReviewers });
  }

  return groups;
}

function collectActorsWithReviewState(
  reviewStates: PullRequestReviewStateRecord[],
  state: ReviewState,
): PullRequestInteractionActor[] {
  return reviewStates
    .filter((review) => review.reviewState === state && !isBotActorLogin(review.reviewerLogin))
    .map((review) => ({ login: review.reviewerLogin, avatarUrl: review.reviewerAvatarUrl }));
}

function collectCommenters(
  entries: PullRequestTimelineEntry[],
  excludeLogins: ReadonlySet<string>,
): PullRequestInteractionActor[] {
  const actors = new Map<string, PullRequestInteractionActor>();

  for (const entry of entries) {
    const actorLogin = entry.paragraph.actorLogin;

    if (actorLogin === null || !PULL_REQUEST_COMMENTER_EVENT_TYPES.has(entry.eventType) || isBotActorLogin(actorLogin) || excludeLogins.has(actorLogin.toLowerCase())) {
      continue;
    }

    const actorAvatarUrl = entry.paragraph.actorAvatarUrl;
    const existingActor = actors.get(actorLogin);

    if (existingActor === undefined) {
      actors.set(actorLogin, { login: actorLogin, avatarUrl: actorAvatarUrl });
      continue;
    }

    if (existingActor.avatarUrl === null && actorAvatarUrl !== null) {
      actors.set(actorLogin, { login: actorLogin, avatarUrl: actorAvatarUrl });
    }
  }

  return [...actors.values()];
}

function isBotActorLogin(login: string): boolean {
  return /\[bot\]$/i.test(login);
}
