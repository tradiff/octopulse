import { DatabaseSync } from "node:sqlite";

import {
  LinuxNotificationAdapter,
  type LinuxNotification,
} from "./linux-notification-adapter.js";
import { getLogger } from "./logger.js";
import { NormalizedEventRepository, type NormalizedEventRecord } from "./normalized-event-repository.js";
import { preparePullRequestNotifications } from "./notification-preparation.js";
import { NotificationRecordRepository, type NotificationRecord } from "./notification-record-repository.js";
import { renderNotificationMarkup } from "./notification-rendering.js";
import { resolvePullRequestStateAssetFilePath } from "./pull-request-state-assets.js";
import { PullRequestRepository, type PullRequestRecord } from "./pull-request-repository.js";

export interface NotificationDispatcher {
  dispatchNotification(notification: LinuxNotification): Promise<unknown>;
}

export interface DispatchPullRequestNotificationsOptions {
  dispatchedAt?: string;
  notificationDispatcher?: NotificationDispatcher;
  notificationRecordRepository?: Pick<
    NotificationRecordRepository,
    "listPendingNotificationRecordsForPullRequest" | "updateNotificationRecordDelivery"
  >;
  onError?: (error: NotificationDispatchError) => void;
}

export interface DispatchPullRequestNotificationsResult {
  immediateCount: number;
  bundledCount: number;
  createdCount: number;
  dispatchedCount: number;
  failedCount: number;
}

export class NotificationDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationDispatchError";
  }
}

export async function dispatchPullRequestNotifications(
  database: DatabaseSync,
  pullRequest: PullRequestRecord,
  options: DispatchPullRequestNotificationsOptions = {},
): Promise<DispatchPullRequestNotificationsResult> {
  const dispatchedAt = options.dispatchedAt ?? new Date().toISOString();
  const notificationDispatcher = options.notificationDispatcher ?? new LinuxNotificationAdapter();
  const notificationRecordRepository =
    options.notificationRecordRepository ?? new NotificationRecordRepository(database);
  const normalizedEventRepository = new NormalizedEventRepository(database);
  const onError = options.onError ?? logNotificationDispatchError;
  const preparation = preparePullRequestNotifications(database, pullRequest);

  let dispatchedCount = 0;
  let failedCount = 0;

  for (const record of notificationRecordRepository.listPendingNotificationRecordsForPullRequest(
    pullRequest.id,
  )) {
    try {
      await notificationDispatcher.dispatchNotification(
        buildDispatchNotification(pullRequest, record, normalizedEventRepository),
      );
      notificationRecordRepository.updateNotificationRecordDelivery(record.id, {
        deliveryStatus: "sent",
        deliveredAt: dispatchedAt,
      });
      dispatchedCount += 1;
    } catch (error) {
      notificationRecordRepository.updateNotificationRecordDelivery(record.id, {
        deliveryStatus: "failed",
        deliveredAt: null,
      });
      failedCount += 1;
      onError(
        new NotificationDispatchError(
          `Failed to dispatch notification record ${record.id} for pull request ${formatPullRequestLabel(pullRequest)}: ${getErrorMessage(error)}`,
        ),
      );
    }
  }

  const result = {
    ...preparation,
    dispatchedCount,
    failedCount,
  };

  if (result.createdCount > 0 || result.dispatchedCount > 0 || result.failedCount > 0) {
    getLogger().info("Processed pull request notifications", {
      pullRequest: formatPullRequestLabel(pullRequest),
      ...result,
    });
  } else {
    getLogger().debug("No pull request notifications were ready to dispatch", {
      pullRequest: formatPullRequestLabel(pullRequest),
    });
  }

  return result;
}

export interface ResendNotificationRecordOptions {
  notificationRecordId: number;
  dispatchedAt?: string;
  notificationDispatcher?: NotificationDispatcher;
  notificationRecordRepository?: Pick<
    NotificationRecordRepository,
    | "resetNotificationRecordDelivery"
    | "getNotificationRecordById"
    | "updateNotificationRecordDelivery"
  >;
  onError?: (error: NotificationDispatchError) => void;
}

export async function resendNotificationRecord(
  database: DatabaseSync,
  options: ResendNotificationRecordOptions,
): Promise<void> {
  const dispatchedAt = options.dispatchedAt ?? new Date().toISOString();
  const notificationDispatcher = options.notificationDispatcher ?? new LinuxNotificationAdapter();
  const notificationRecordRepository =
    options.notificationRecordRepository ?? new NotificationRecordRepository(database);
  const normalizedEventRepository = new NormalizedEventRepository(database);
  const pullRequestRepository = new PullRequestRepository(database);
  const onError = options.onError ?? logNotificationDispatchError;

  const record = notificationRecordRepository.getNotificationRecordById(options.notificationRecordId);

  if (!record) {
    throw new NotificationDispatchError(
      `Notification record ${options.notificationRecordId} not found`,
    );
  }

  notificationRecordRepository.resetNotificationRecordDelivery(record.id);

  try {
    const pullRequest = pullRequestRepository.getPullRequestById(record.pullRequestId);

    if (!pullRequest) {
      throw new NotificationDispatchError(
        `Pull request ${record.pullRequestId} not found for notification record ${record.id}`,
      );
    }

    await notificationDispatcher.dispatchNotification(
      buildDispatchNotification(pullRequest, record, normalizedEventRepository),
    );
    notificationRecordRepository.updateNotificationRecordDelivery(record.id, {
      deliveryStatus: "sent",
      deliveredAt: dispatchedAt,
    });
    getLogger().info("Resent notification record", { notificationRecordId: record.id });
  } catch (error) {
    notificationRecordRepository.updateNotificationRecordDelivery(record.id, {
      deliveryStatus: "failed",
      deliveredAt: null,
    });
    onError(
      new NotificationDispatchError(
        `Failed to resend notification record ${record.id}: ${getErrorMessage(error)}`,
      ),
    );
    throw error;
  }
}

function buildDispatchNotification(
  pullRequest: PullRequestRecord,
  record: NotificationRecord,
  normalizedEventRepository: Pick<
    NormalizedEventRepository,
    "getNormalizedEventById" | "listNormalizedEventsForBundle"
  >,
): LinuxNotification {
  const events = resolveNotificationEvents(record, normalizedEventRepository);

  return {
    title: record.title,
    body: record.body,
    clickUrl: record.clickUrl,
    icon: resolvePullRequestStateAssetFilePath(pullRequest),
    ...(events === null || events.length === 0 ? {} : { markup: renderNotificationMarkup(pullRequest, events) }),
  };
}

function resolveNotificationEvents(
  record: NotificationRecord,
  normalizedEventRepository: Pick<
    NormalizedEventRepository,
    "getNormalizedEventById" | "listNormalizedEventsForBundle"
  >,
): NormalizedEventRecord[] | null {
  if (record.normalizedEventId !== null) {
    const event = normalizedEventRepository.getNormalizedEventById(record.normalizedEventId);
    return event === null ? null : [event];
  }

  if (record.eventBundleId !== null) {
    return normalizedEventRepository.listNormalizedEventsForBundle(record.eventBundleId);
  }

  return null;
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.number}`;
}

function logNotificationDispatchError(error: NotificationDispatchError): void {
  getLogger().error("Octopulse notification dispatch failed", {
    error,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
