import { DatabaseSync } from "node:sqlite";

import {
  NormalizedEventRepository,
} from "./normalized-event-repository.js";
import {
  buildNotificationParagraph,
  type NotificationMarkupParagraph,
} from "./notification-rendering.js";
import { PullRequestRepository } from "./pull-request-repository.js";
import {
  PullRequestReviewStateRepository,
  type PullRequestReviewStateRecord,
} from "./pull-request-review-state-repository.js";

export interface PullRequestTimelineEntry {
  id: number;
  eventType: string;
  occurredAt: string;
  paragraph: NotificationMarkupParagraph;
}

export type PullRequestTimeline = Record<string, PullRequestTimelineEntry[]>;
export type PullRequestReviewStatesByPullRequest = Record<string, PullRequestReviewStateRecord[]>;

export interface ListPullRequestTimelineOptions {
  normalizedEventRepository?: Pick<NormalizedEventRepository, "listNormalizedEventsForPullRequest">;
  pullRequestRepository?: Pick<PullRequestRepository, "listTrackedPullRequests" | "listInactivePullRequests">;
  pullRequestReviewStateRepository?: Pick<PullRequestReviewStateRepository, "listReviewStatesForPullRequest">;
}

export interface PullRequestTimelineResult {
  timelineByPullRequest: PullRequestTimeline;
  reviewStatesByPullRequest: PullRequestReviewStatesByPullRequest;
}

export function listPullRequestTimeline(
  database: DatabaseSync,
  options: ListPullRequestTimelineOptions = {},
): PullRequestTimelineResult {
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const pullRequestReviewStateRepository =
    options.pullRequestReviewStateRepository ?? new PullRequestReviewStateRepository(database);
  const pullRequests = [
    ...pullRequestRepository.listTrackedPullRequests(),
    ...pullRequestRepository.listInactivePullRequests(),
  ];

  const timelineByPullRequest: PullRequestTimeline = {};
  const reviewStatesByPullRequest: PullRequestReviewStatesByPullRequest = {};

  for (const pullRequest of pullRequests) {
    const key = String(pullRequest.githubPullRequestId);

    timelineByPullRequest[key] = normalizedEventRepository
      .listNormalizedEventsForPullRequest(pullRequest.id)
      .slice()
      .reverse()
      .map((event) => ({
        id: event.id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        paragraph: buildNotificationParagraph(event),
      }));

    reviewStatesByPullRequest[key] =
      pullRequestReviewStateRepository.listReviewStatesForPullRequest(pullRequest.id);
  }

  return { timelineByPullRequest, reviewStatesByPullRequest };
}
