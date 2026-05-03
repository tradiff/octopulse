import { DatabaseSync } from "node:sqlite";

import {
  NormalizedEventRepository,
} from "./normalized-event-repository.js";
import {
  buildNotificationParagraph,
  type NotificationMarkupParagraph,
} from "./notification-rendering.js";
import { PullRequestRepository } from "./pull-request-repository.js";

export interface PullRequestTimelineEntry {
  id: number;
  eventType: string;
  occurredAt: string;
  paragraph: NotificationMarkupParagraph;
}

export type PullRequestTimeline = Record<string, PullRequestTimelineEntry[]>;

export interface ListPullRequestTimelineOptions {
  normalizedEventRepository?: Pick<NormalizedEventRepository, "listNormalizedEventsForPullRequest">;
  pullRequestRepository?: Pick<PullRequestRepository, "listTrackedPullRequests" | "listInactivePullRequests">;
}

export function listPullRequestTimeline(
  database: DatabaseSync,
  options: ListPullRequestTimelineOptions = {},
): PullRequestTimeline {
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const pullRequests = [
    ...pullRequestRepository.listTrackedPullRequests(),
    ...pullRequestRepository.listInactivePullRequests(),
  ];

  return Object.fromEntries(
    pullRequests.map((pullRequest) => [
      String(pullRequest.githubPullRequestId),
      normalizedEventRepository
        .listNormalizedEventsForPullRequest(pullRequest.id)
        .slice()
        .reverse()
        .map((event) => ({
          id: event.id,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          paragraph: buildNotificationParagraph(event),
        })),
    ]),
  );
}
