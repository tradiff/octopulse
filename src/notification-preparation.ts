import { DatabaseSync } from "node:sqlite";

import { EventBundleRepository } from "./event-bundling.js";
import { NormalizedEventRepository } from "./normalized-event-repository.js";
import { NotificationRecordRepository } from "./notification-record-repository.js";
import { renderNotification, type RenderedNotification } from "./notification-rendering.js";
import type { PullRequestRecord } from "./pull-request-repository.js";

export interface PreparePullRequestNotificationsOptions {
  eventBundleRepository?: Pick<EventBundleRepository, "listPendingUnnotifiedBundlesForPullRequest">;
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "listImmediateEligibleUnnotifiedEventsForPullRequest" | "listNormalizedEventsForBundle"
  >;
  notificationRecordRepository?: Pick<NotificationRecordRepository, "createNotificationRecord">;
  render?: (
    pullRequest: Pick<
      PullRequestRecord,
      "repositoryOwner" | "repositoryName" | "number" | "title" | "url"
    >,
    events: Parameters<typeof renderNotification>[1],
  ) => RenderedNotification;
}

export interface PreparePullRequestNotificationsResult {
  immediateCount: number;
  bundledCount: number;
  createdCount: number;
}

export function preparePullRequestNotifications(
  database: DatabaseSync,
  pullRequest: Pick<
    PullRequestRecord,
    "id" | "repositoryOwner" | "repositoryName" | "number" | "title" | "url"
  >,
  options: PreparePullRequestNotificationsOptions = {},
): PreparePullRequestNotificationsResult {
  const eventBundleRepository = options.eventBundleRepository ?? new EventBundleRepository(database);
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);
  const notificationRecordRepository =
    options.notificationRecordRepository ?? new NotificationRecordRepository(database);
  const render = options.render ?? renderNotification;

  let immediateCount = 0;
  let bundledCount = 0;

  for (const event of normalizedEventRepository.listImmediateEligibleUnnotifiedEventsForPullRequest(
    pullRequest.id,
  )) {
    const notification = render(pullRequest, [event]);

    notificationRecordRepository.createNotificationRecord({
      normalizedEventId: event.id,
      pullRequestId: pullRequest.id,
      title: notification.title,
      body: notification.body,
      clickUrl: notification.clickUrl,
      deliveryStatus: "pending",
    });
    immediateCount += 1;
  }

  for (const bundle of eventBundleRepository.listPendingUnnotifiedBundlesForPullRequest(pullRequest.id)) {
    const events = normalizedEventRepository.listNormalizedEventsForBundle(bundle.id);

    if (events.length === 0) {
      continue;
    }

    const notification = render(pullRequest, events);

    notificationRecordRepository.createNotificationRecord({
      eventBundleId: bundle.id,
      pullRequestId: pullRequest.id,
      title: notification.title,
      body: notification.body,
      clickUrl: notification.clickUrl,
      deliveryStatus: "pending",
    });
    bundledCount += 1;
  }

  return {
    immediateCount,
    bundledCount,
    createdCount: immediateCount + bundledCount,
  };
}
