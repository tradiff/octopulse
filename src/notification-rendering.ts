import type { NormalizedEventRecord } from "./normalized-event-repository.js";
import type { PullRequestRecord } from "./pull-request-repository.js";

export interface RenderedNotification {
  title: string;
  body: string;
  clickUrl: string;
  summary: string;
}

type NotificationPullRequest = Pick<
  PullRequestRecord,
  "repositoryOwner" | "repositoryName" | "number" | "title" | "url"
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
  return events.map((event) => renderEventLine(event)).join("\n\n");
}

function renderEventLine(event: NotificationEvent): string {
  const actorPrefix = event.actorLogin === null ? "" : `${event.actorLogin}: `;

  switch (event.eventType) {
    case "issue_comment":
    case "review_inline_comment":
    case "review_submitted":
      return `${actorPrefix}${renderEmojiText("💬", readEventText(event) ?? renderEventFallbackText(event))}`.trim();
    case "review_approved":
      return `${actorPrefix}${renderEmojiText("✅", readEventText(event) ?? "approved")}`.trim();
    case "review_changes_requested":
      return `${actorPrefix}${renderEmojiText("❗", readEventText(event) ?? "changes requested")}`.trim();
    case "pr_merged":
    case "pr_closed":
    case "pr_reopened":
    case "ready_for_review":
    case "converted_to_draft":
    case "commit_pushed":
      return `${actorPrefix}${renderEventFallbackText(event)}`.trim();
    case "ci_failed":
    case "ci_succeeded":
      return renderEventFallbackText(event);
    default:
      return `${actorPrefix}${renderEventFallbackText(event)}`.trim();
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
