import type { NormalizedEventRecord } from "./normalized-event-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";

export interface RenderedNotification {
  title: string;
  body: string;
  clickUrl: string;
  summary: string;
}

export interface NotificationMarkup {
  headerText: string;
  headerAvatarKey: string;
  headerAvatarUrl: string | null;
  paragraphs: readonly NotificationMarkupParagraph[];
}

export interface NotificationMarkupParagraph {
  actorLogin: string | null;
  actorAvatarKey: string | null;
  actorAvatarUrl: string | null;
  text: string;
}

type NotificationPullRequest = Pick<
  PullRequestRecord,
  "repositoryOwner" | "repositoryName" | "number" | "title" | "url"
>;

type NotificationMarkupPullRequest = Pick<
  PullRequestRecord,
  "repositoryName" | "title" | "authorLogin" | "authorAvatarUrl" | "state" | "isDraft" | "mergedAt"
>;

type NotificationEvent = Pick<
  NormalizedEventRecord,
  "actorLogin" | "eventType" | "id" | "occurredAt" | "payloadJson"
>;

const TEXT_EVENT_TYPES = new Set([
  "issue_comment",
  "review_inline_comment",
  "review_submitted",
  "review_approved",
  "review_changes_requested",
]);
const MAX_EVENT_TEXT_LENGTH = 100;

export function renderNotification(
  pullRequest: NotificationPullRequest,
  events: readonly NotificationEvent[],
): RenderedNotification {
  if (events.length === 0) {
    throw new Error("Cannot render notification without events");
  }

  const title = `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number} ${pullRequest.title}`;
  const summary = events.length === 1 ? renderSingleEventSummary(events[0]) : renderBundleSummary(events);

  return {
    title,
    body: renderNotificationBody(events),
    clickUrl: pullRequest.url,
    summary,
  };
}

export function renderNotificationMarkup(
  pullRequest: NotificationMarkupPullRequest,
  events: readonly NotificationEvent[],
): NotificationMarkup {
  if (events.length === 0) {
    throw new Error("Cannot render notification markup without events");
  }

  return {
    headerText: `[${pullRequest.repositoryName}] ${pullRequest.title} (${renderMarkupPullRequestState(pullRequest)})`,
    headerAvatarKey: pullRequest.authorLogin,
    headerAvatarUrl: pullRequest.authorAvatarUrl,
    paragraphs: events.map((event) => ({
      actorLogin: event.actorLogin,
      actorAvatarKey: event.actorLogin,
      actorAvatarUrl: readEventActorAvatarUrl(event),
      text: renderEventText(event),
    })),
  };
}

export function buildNotificationParagraph(
  event: Pick<NormalizedEventRecord, "actorLogin" | "eventType" | "payloadJson" | "id" | "occurredAt">,
): NotificationMarkupParagraph {
  return {
    actorLogin: event.actorLogin,
    actorAvatarKey: event.actorLogin,
    actorAvatarUrl: readEventActorAvatarUrl(event),
    text: renderEventText(event),
  };
}

function renderSingleEventSummary(event: NotificationEvent | undefined): string {
  if (event === undefined) {
    throw new Error("Missing notification event");
  }

  const actorPrefix = event.actorLogin === null ? "" : `${event.actorLogin} `;

  return `${actorPrefix}${renderEventFallbackText(event)}`.trim();
}

function renderEventFallbackText(event: NotificationEvent): string {
  switch (event.eventType) {
    case "issue_comment":
      return "commented";
    case "review_inline_comment":
      return "left inline comment";
    case "review_submitted":
      return "submitted review";
    case "review_approved":
      return "approved review";
    case "review_changes_requested":
      return "requested changes";
    case "review_requested":
      return "review requested";
    case "ci_failed":
      return "CI failed";
    case "ci_succeeded":
      return "CI passed";
    case "pr_merged":
      return "merged PR";
    case "pr_closed":
      return "closed PR";
    case "pr_reopened":
      return "reopened PR";
    case "ready_for_review":
      return "marked PR ready for review";
    case "converted_to_draft":
      return "converted PR to draft";
    case "commit_pushed":
      return "pushed commits";
    default:
      return "updated PR";
  }
}

function renderBundleSummary(events: readonly NotificationEvent[]): string {
  const actorLogins = [...new Set(events.flatMap((event) => (event.actorLogin === null ? [] : [event.actorLogin])))];
  const primaryParts: string[] = [];
  const commentParts: string[] = [];

  appendCount(primaryParts, countEvents(events, "review_submitted"), "review");
  appendCount(primaryParts, countEvents(events, "review_approved"), "approval");
  appendCount(primaryParts, countEvents(events, "review_changes_requested"), "change request");

  if (countEvents(events, "ci_failed") > 0) {
    primaryParts.push("CI failed");
  }

  if (countEvents(events, "ci_succeeded") > 0) {
    primaryParts.push("CI passed");
  }

  appendCount(primaryParts, countEvents(events, "commit_pushed"), "commit push");
  appendCount(primaryParts, countEvents(events, "pr_reopened"), "reopen");
  appendCount(primaryParts, countEvents(events, "ready_for_review"), "ready-for-review update");
  appendCount(primaryParts, countEvents(events, "converted_to_draft"), "draft update");

  if (countEvents(events, "pr_merged") > 0) {
    primaryParts.push("PR merged");
  }

  if (countEvents(events, "pr_closed") > 0) {
    primaryParts.push("PR closed");
  }

  appendCount(commentParts, countEvents(events, "issue_comment") + countEvents(events, "review_inline_comment"), "comment");

  const parts = [...primaryParts, ...commentParts];
  const summary = parts.length > 0 ? parts.join(", ") : `${events.length} updates`;

  if (actorLogins.length === 1) {
    return `${actorLogins[0]}: ${summary}`;
  }

  return summary;
}

function countEvents(events: readonly NotificationEvent[], eventType: string): number {
  return events.filter((event) => event.eventType === eventType).length;
}

function appendCount(parts: string[], count: number, label: string): void {
  if (count === 0) {
    return;
  }

  parts.push(count === 1 ? `1 ${label}` : `${count} ${label}s`);
}

function renderNotificationBody(events: readonly NotificationEvent[]): string {
  return events.map((event) => renderPlainEventLine(event)).join("\n\n");
}

function renderPlainEventLine(event: NotificationEvent): string {
  const paragraph = buildNotificationParagraph(event);
  const actorPrefix = paragraph.actorLogin === null ? "" : `${paragraph.actorLogin}: `;

  return `${actorPrefix}${paragraph.text}`.trim();
}

function renderEventText(event: NotificationEvent): string {
  switch (event.eventType) {
    case "issue_comment":
    case "review_inline_comment":
    case "review_submitted":
      return renderEmojiText("💬", readEventText(event) ?? renderEventFallbackText(event));
    case "review_approved":
      return renderEmojiText("✅", readEventText(event) ?? "approved");
    case "review_changes_requested":
      return renderEmojiText("❗", readEventText(event) ?? "changes requested");
    case "review_requested":
      return renderEmojiText("👀", "review requested");
    case "pr_merged":
    case "pr_closed":
    case "pr_reopened":
    case "ready_for_review":
    case "converted_to_draft":
    case "commit_pushed":
      return renderEventFallbackText(event);
    case "ci_failed":
    case "ci_succeeded":
      return renderEventFallbackText(event);
    default:
      return renderEventFallbackText(event);
  }
}

function renderEmojiText(emoji: string, text: string): string {
  return `${emoji} ${text}`;
}

function readEventText(event: NotificationEvent): string | null {
  if (!TEXT_EVENT_TYPES.has(event.eventType)) {
    return null;
  }

  const payload = parsePayload(event.payloadJson);
  const bodyText = payload?.bodyText;

  if (typeof bodyText !== "string") {
    return null;
  }

  const normalizedText = bodyText.replace(/\s+/g, " ").trim();

  if (normalizedText.length === 0) {
    return null;
  }

  if (normalizedText.length <= MAX_EVENT_TEXT_LENGTH) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, MAX_EVENT_TEXT_LENGTH - 3).trimEnd()}...`;
}

function readEventActorAvatarUrl(event: NotificationEvent): string | null {
  const payload = parsePayload(event.payloadJson);
  const actorAvatarUrl = payload?.actorAvatarUrl;

  return typeof actorAvatarUrl === "string" && actorAvatarUrl.length > 0 ? actorAvatarUrl : null;
}

function renderMarkupPullRequestState(
  pullRequest: Pick<PullRequestRecord, "state" | "isDraft" | "mergedAt">,
): string {
  if (pullRequest.mergedAt !== null) {
    return "merged";
  }

  if (pullRequest.isDraft) {
    return "draft";
  }

  return pullRequest.state;
}

function parsePayload(payloadJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
