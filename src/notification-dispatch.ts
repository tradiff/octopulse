import { DatabaseSync } from "node:sqlite";

import {
  LinuxNotificationAdapter,
  type LinuxNotification,
} from "./linux-notification-adapter.js";
import { getLogger } from "./logger.js";
import { preparePullRequestNotifications } from "./notification-preparation.js";
import { NotificationRecordRepository } from "./notification-record-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";

export interface NotificationDispatcher {
  dispatchNotification(notification: LinuxNotification): Promise<unknown>;
}

export interface DispatchPullRequestNotificationsOptions {
  preparedAt?: string;
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
  pullRequest: Pick<
    PullRequestRecord,
    "id" | "repositoryOwner" | "repositoryName" | "number" | "title" | "url"
  >,
  options: DispatchPullRequestNotificationsOptions = {},
): Promise<DispatchPullRequestNotificationsResult> {
  const preparedAt = options.preparedAt ?? new Date().toISOString();
  const dispatchedAt = options.dispatchedAt ?? new Date().toISOString();
  const notificationDispatcher = options.notificationDispatcher ?? new LinuxNotificationAdapter();
  const notificationRecordRepository =
    options.notificationRecordRepository ?? new NotificationRecordRepository(database);
  const onError = options.onError ?? logNotificationDispatchError;
  const preparation = preparePullRequestNotifications(database, pullRequest, {
    preparedAt,
  });

  let dispatchedCount = 0;
  let failedCount = 0;

  for (const record of notificationRecordRepository.listPendingNotificationRecordsForPullRequest(
    pullRequest.id,
  )) {
    try {
      await notificationDispatcher.dispatchNotification({
        title: record.title,
        body: record.body,
        clickUrl: record.clickUrl,
      });
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
