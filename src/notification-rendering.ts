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

type NotificationEvent = Pick<NormalizedEventRecord, "actorLogin" | "eventType" | "id" | "occurredAt">;

export function renderNotification(
  pullRequest: NotificationPullRequest,
  events: readonly NotificationEvent[],
): RenderedNotification {
  if (events.length === 0) {
    throw new Error("Cannot render notification without events");
  }

  const title = `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} PR #${pullRequest.number}`;
  const summary = events.length === 1 ? renderSingleEventSummary(events[0]) : renderBundleSummary(events);

  return {
    title,
    body: `${summary}\n${pullRequest.title}`,
    clickUrl: pullRequest.url,
    summary,
  };
}

function renderSingleEventSummary(event: NotificationEvent | undefined): string {
  if (event === undefined) {
    throw new Error("Missing notification event");
  }

  const actorPrefix = event.actorLogin === null ? "" : `${event.actorLogin} `;

  switch (event.eventType) {
    case "issue_comment":
      return `${actorPrefix}commented`.trim();
    case "review_inline_comment":
      return `${actorPrefix}left inline comment`.trim();
    case "review_submitted":
      return `${actorPrefix}submitted review`.trim();
    case "review_approved":
      return `${actorPrefix}approved review`.trim();
    case "review_changes_requested":
      return `${actorPrefix}requested changes`.trim();
    case "ci_failed":
      return "CI failed";
    case "ci_succeeded":
      return "CI passed";
    case "pr_merged":
      return `${actorPrefix}merged PR`.trim();
    case "pr_closed":
      return `${actorPrefix}closed PR`.trim();
    case "pr_reopened":
      return `${actorPrefix}reopened PR`.trim();
    case "ready_for_review":
      return `${actorPrefix}marked PR ready for review`.trim();
    case "converted_to_draft":
      return `${actorPrefix}converted PR to draft`.trim();
    case "commit_pushed":
      return `${actorPrefix}pushed commits`.trim();
    default:
      return `${actorPrefix}updated PR`.trim();
  }
}

function renderBundleSummary(events: readonly NotificationEvent[]): string {
  const actorLogins = [...new Set(events.flatMap((event) => (event.actorLogin === null ? [] : [event.actorLogin])))];
  const parts: string[] = [];

  appendCount(parts, countEvents(events, "issue_comment") + countEvents(events, "review_inline_comment"), "comment");
  appendCount(parts, countEvents(events, "review_submitted"), "review");
  appendCount(parts, countEvents(events, "review_approved"), "approval");
  appendCount(parts, countEvents(events, "review_changes_requested"), "change request");

  if (countEvents(events, "ci_failed") > 0) {
    parts.push("CI failed");
  }

  if (countEvents(events, "ci_succeeded") > 0) {
    parts.push("CI passed");
  }

  appendCount(parts, countEvents(events, "commit_pushed"), "commit push");
  appendCount(parts, countEvents(events, "pr_reopened"), "reopen");
  appendCount(parts, countEvents(events, "ready_for_review"), "ready-for-review update");
  appendCount(parts, countEvents(events, "converted_to_draft"), "draft update");

  if (countEvents(events, "pr_merged") > 0) {
    parts.push("PR merged");
  }

  if (countEvents(events, "pr_closed") > 0) {
    parts.push("PR closed");
  }

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
