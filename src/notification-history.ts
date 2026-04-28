import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_ACTIVITY_FEED_FILTERS,
  DEFAULT_ACTIVITY_PAGE_SIZE,
  resolvePaginationWindow,
  type ListActivityFeedOptions,
  type PaginatedEntries,
} from "./activity-feed.js";
import {
  NormalizedEventRepository,
  type ActorClass,
  type DecisionState,
  type NormalizedEventRecord,
} from "./normalized-event-repository.js";
import {
  NotificationRecordRepository,
  type NotificationDeliveryStatus,
} from "./notification-record-repository.js";
import {
  buildNotificationParagraph,
  type NotificationMarkupParagraph,
} from "./notification-rendering.js";
import { PullRequestRepository, type PullRequestRecord } from "./pull-request-repository.js";

export interface NotificationHistoryActor {
  login: string;
  avatarUrl: string | null;
}

export interface NotificationHistoryEntry {
  id: number;
  title: string;
  body: string;
  clickUrl: string | null;
  deliveryStatus: NotificationDeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
  decisionStates: DecisionState[];
  eventTypes: string[];
  actorClasses: ActorClass[];
  sourceKind: "immediate" | "bundle";
  repositoryKey: string | null;
  isTracked: boolean | null;
  author: NotificationHistoryActor | null;
  actors: NotificationHistoryActor[];
  summaryParagraphs: NotificationMarkupParagraph[];
}

export interface ListNotificationHistoryOptions {
  filters?: ListActivityFeedOptions["filters"];
  page?: number;
  pageSize?: number;
  notificationRecordRepository?: Pick<
    NotificationRecordRepository,
    "countNotificationRecords" | "listNotificationRecords"
  >;
  normalizedEventRepository?: Pick<
    NormalizedEventRepository,
    "getNormalizedEventById" | "listNormalizedEventsForBundle"
  >;
  pullRequestRepository?: Pick<PullRequestRepository, "getPullRequestById">;
}

export function listNotificationHistory(
  database: DatabaseSync,
  options: ListNotificationHistoryOptions = {},
): PaginatedEntries<NotificationHistoryEntry> {
  const notificationRecordRepository =
    options.notificationRecordRepository ?? new NotificationRecordRepository(database);
  const normalizedEventRepository =
    options.normalizedEventRepository ?? new NormalizedEventRepository(database);
  const pullRequestRepository = options.pullRequestRepository ?? new PullRequestRepository(database);
  const filters = options.filters ?? DEFAULT_ACTIVITY_FEED_FILTERS;
  const pagination = resolvePaginationWindow(
    notificationRecordRepository.countNotificationRecords(filters),
    options.page ?? 1,
    options.pageSize ?? DEFAULT_ACTIVITY_PAGE_SIZE,
  );

  return {
    entries: notificationRecordRepository
      .listNotificationRecords({
        filters,
        limit: pagination.limit,
        offset: pagination.offset,
      })
      .map((record) => {
        const events = resolveHistoryEvents(record, normalizedEventRepository);
        const pullRequest = resolveHistoryPullRequest(events, pullRequestRepository);

        return {
          id: record.id,
          title: record.title,
          body: record.body,
          clickUrl: record.clickUrl,
          deliveryStatus: record.deliveryStatus,
          createdAt: record.createdAt,
          deliveredAt: record.deliveredAt,
          decisionStates: collectDecisionStates(events),
          eventTypes: collectEventTypes(events),
          actorClasses: collectActorClasses(events),
          sourceKind: record.normalizedEventId === null ? "bundle" : "immediate",
          repositoryKey: pullRequest ? formatRepositoryKey(pullRequest) : readRepositoryKeyFromUrl(record.clickUrl),
          isTracked: pullRequest?.isTracked ?? null,
          author: pullRequest
            ? {
                login: pullRequest.authorLogin,
                avatarUrl: pullRequest.authorAvatarUrl,
              }
            : null,
          actors: collectActors(events),
          summaryParagraphs: events.map((event) => buildNotificationParagraph(event)),
        };
      }),
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalCount: pagination.totalCount,
    totalPages: pagination.totalPages,
  };
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

function resolveHistoryPullRequest(
  events: NormalizedEventRecord[],
  pullRequestRepository: Pick<PullRequestRepository, "getPullRequestById">,
): PullRequestRecord | undefined {
  const pullRequestId = events[0]?.pullRequestId;

  return pullRequestId === undefined ? undefined : pullRequestRepository.getPullRequestById(pullRequestId);
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

function collectEventTypes(events: NormalizedEventRecord[]): string[] {
  return collectUniqueStrings(events.map((event) => event.eventType));
}

function collectActorClasses(events: NormalizedEventRecord[]): ActorClass[] {
  return collectUniqueStrings(
    events.flatMap((event) => (event.actorClass === null ? [] : [event.actorClass])),
  ) as ActorClass[];
}

function collectActors(events: NormalizedEventRecord[]): NotificationHistoryActor[] {
  const actors = new Map<string, NotificationHistoryActor>();

  for (const event of events) {
    if (event.actorLogin === null) {
      continue;
    }

    const existing = actors.get(event.actorLogin);
    const actorAvatarUrl = readEventActorAvatarUrl(event);

    if (existing === undefined) {
      actors.set(event.actorLogin, {
        login: event.actorLogin,
        avatarUrl: actorAvatarUrl,
      });
      continue;
    }

    if (existing.avatarUrl === null && actorAvatarUrl !== null) {
      actors.set(event.actorLogin, {
        login: existing.login,
        avatarUrl: actorAvatarUrl,
      });
    }
  }

  return [...actors.values()];
}

function collectUniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function readEventActorAvatarUrl(event: Pick<NormalizedEventRecord, "payloadJson">): string | null {
  try {
    const payload = JSON.parse(event.payloadJson) as unknown;

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }

    const actorAvatarUrl = (payload as Record<string, unknown>).actorAvatarUrl;

    return typeof actorAvatarUrl === "string" && actorAvatarUrl.length > 0 ? actorAvatarUrl : null;
  } catch {
    return null;
  }
}

function formatRepositoryKey(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`;
}

function readRepositoryKeyFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    const [repositoryOwner, repositoryName] = parsedUrl.pathname.split("/").filter(Boolean);

    return repositoryOwner && repositoryName ? `${repositoryOwner}/${repositoryName}` : null;
  } catch {
    return null;
  }
}
