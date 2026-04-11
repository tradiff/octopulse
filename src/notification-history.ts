import { DatabaseSync } from "node:sqlite";

import {
  NormalizedEventRepository,
  type DecisionState,
  type NormalizedEventRecord,
} from "./normalized-event-repository.js";
import {
  NotificationRecordRepository,
  type NotificationDeliveryStatus,
} from "./notification-record-repository.js";

export interface NotificationHistoryEntry {
  id: number;
  title: string;
  body: string;
  clickUrl: string | null;
  deliveryStatus: NotificationDeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
  decisionStates: DecisionState[];
  sourceKind: "immediate" | "bundle";
}

export interface ListNotificationHistoryOptions {
  notificationRecordRepository?: Pick<NotificationRecordRepository, "listNotificationRecords">;
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "getNormalizedEventById" | "listNormalizedEventsForBundle"
  >;
}

export function listNotificationHistory(
  database: DatabaseSync,
  options: ListNotificationHistoryOptions = {},
): NotificationHistoryEntry[] {
  const notificationRecordRepository =
    options.notificationRecordRepository ?? new NotificationRecordRepository(database);
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);

  return notificationRecordRepository.listNotificationRecords().map((record) => {
    const events = resolveHistoryEvents(record, normalizedEventRepository);

    return {
      id: record.id,
      title: record.title,
      body: record.body,
      clickUrl: record.clickUrl,
      deliveryStatus: record.deliveryStatus,
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      decisionStates: collectDecisionStates(events),
      sourceKind: record.normalizedEventId === null ? "bundle" : "immediate",
    };
  });
}

function resolveHistoryEvents(
  record: { eventBundleId: number | null; normalizedEventId: number | null },
  normalizedEventRepository: Pick<
    NormalizedEventRepository,
    "getNormalizedEventById" | "listNormalizedEventsForBundle"
  >,
): NormalizedEventRecord[] {
  if (record.normalizedEventId !== null) {
    const event = normalizedEventRepository.getNormalizedEventById(record.normalizedEventId);

    return event === null ? [] : [event];
  }

  if (record.eventBundleId !== null) {
    return normalizedEventRepository.listNormalizedEventsForBundle(record.eventBundleId);
  }

  return [];
}

function collectDecisionStates(events: NormalizedEventRecord[]): DecisionState[] {
  const seen = new Set<DecisionState>();
  const states: DecisionState[] = [];

  for (const event of events) {
    if (event.decisionState === null || seen.has(event.decisionState)) {
      continue;
    }

    seen.add(event.decisionState);
    states.push(event.decisionState);
  }

  return states;
}
