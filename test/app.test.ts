import { describe, expect, it } from "vitest";

import { renderAppDocument } from "../src/app.js";

describe("renderAppDocument", () => {
  it("renders one combined pull request list", () => {
    const html = renderAppDocument({
      trackedPullRequests: [
        createPullRequestRecord({
          githubPullRequestId: 101,
          title: "Track recurring discovery output",
          repositoryName: "octopulse",
          number: 7,
          state: "open",
        }),
      ],
      inactivePullRequests: [
        createPullRequestRecord({
          id: 2,
          githubPullRequestId: 202,
          title: "Keep merged pull requests visible during grace period",
          repositoryName: "worker",
          number: 18,
          state: "closed",
          isTracked: false,
          isStickyUntracked: true,
        }),
      ],
    });

    expect(html).toContain("Pull Requests");
    expect(html).toContain("Track Pull Request");
    expect(html).toContain('action="/tracked-pull-requests/manual-track"');
    expect(html).toContain("acme/octopulse #7");
    expect(html).toContain("acme/worker #18");
    expect(html).toContain("Track recurring discovery output");
    expect(html).toContain("Keep merged pull requests visible during grace period");
    expect(html).toContain("Open");
    expect(html).toContain("Closed");
    expect(html).toContain("Untrack");
    expect(html).toContain("Track Again");
  });

  it("renders empty-state messages when no pull requests are available", () => {
    const html = renderAppDocument();

    expect(html).toContain("No pull requests yet.");
  });

  it("renders flash messages for UI actions", () => {
    const html = renderAppDocument({
      flashMessage: {
        kind: "success",
        text: "acme/octopulse #7 is already tracked.",
      },
    });

    expect(html).toContain("flash-success");
    expect(html).toContain("acme/octopulse #7 is already tracked.");
  });

  it("renders notification history with delivery and decision details", () => {
    const html = renderAppDocument({
      notificationHistory: [
        {
          id: 9,
          title: "acme/octopulse PR #7",
          body: "1 comment, CI failed\nAdd notifications",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "sent",
          createdAt: "2026-04-10 12:02:30",
          deliveredAt: "2026-04-10T12:02:45.000Z",
          decisionStates: ["notified", "notified_ai_fallback"],
          eventTypes: ["issue_comment", "ci_failed"],
          actorClasses: ["bot"],
          sourceKind: "bundle",
          repositoryKey: "acme/octopulse",
          isTracked: true,
        },
      ],
    });

    expect(html).toContain("Notification History");
    expect(html).toContain("acme/octopulse PR #7");
    expect(html).toContain("1 comment, CI failed");
    expect(html).toContain("Sent");
    expect(html).toContain("Bundled");
    expect(html).toContain("Notified");
    expect(html).toContain("AI fallback");
    expect(html).toContain("Delivered 2026-04-10 12:02:45 UTC");
  });

  it("renders normalized raw events with expandable raw JSON", () => {
    const html = renderAppDocument({
      rawEvents: [
        {
          id: 17,
          repositoryKey: "acme/octopulse",
          isTracked: true,
          pullRequestLabel: "acme/octopulse #7",
          pullRequestTitle: "Add pull request polling",
          pullRequestUrl: "https://github.com/acme/octopulse/pull/7",
          eventType: "review_changes_requested",
          actorLogin: "alice",
          actorClass: "human_other",
          decisionState: "notified",
          notificationTiming: "immediate",
          occurredAt: "2026-04-10T12:04:00.000Z",
          rawPayloadJson: '{"state":"CHANGES_REQUESTED","body":"Please add tests."}',
          notificationSourceKind: "immediate",
          notificationDeliveryStatus: "sent",
        },
      ],
    });

    expect(html).toContain("Raw Events");
    expect(html).toContain("acme/octopulse #7");
    expect(html).toContain("Review Changes Requested");
    expect(html).toContain("Actor alice");
    expect(html).toContain("Immediate timing");
    expect(html).toContain("Raw JSON");
    expect(html).toContain("&quot;CHANGES_REQUESTED&quot;");
    expect(html).toContain('<details class="raw-event-details">');
  });

  it("renders filter controls and available options", () => {
    const html = renderAppDocument({
      uiFilters: {
        pullRequestState: "inactive",
        repository: "acme/worker",
        eventType: "issue_comment",
        decisionState: "suppressed_rule",
        actorClass: "bot",
        startDate: "2026-04-10",
        endDate: "2026-04-11",
      },
      uiFilterOptions: {
        repositories: ["acme/octopulse", "acme/worker"],
        eventTypes: ["issue_comment", "review_changes_requested"],
        decisionStates: ["notified", "suppressed_rule"],
        actorClasses: ["human_other", "bot"],
      },
    });

    expect(html).toContain("Filters");
    expect(html).toContain('name="pr-state"');
    expect(html).toContain("Untracked only");
    expect(html).toContain("acme/worker");
    expect(html).toContain("Issue Comment");
    expect(html).toContain("Rule suppressed");
    expect(html).toContain("Bot");
    expect(html).toContain('name="start-date"');
    expect(html).toContain('value="2026-04-10"');
    expect(html).toContain('value="2026-04-11"');
    expect(html).toContain("Apply Filters");
  });
});

function createPullRequestRecord(
  overrides: Partial<{
    id: number;
    githubPullRequestId: number;
    repositoryOwner: string;
    repositoryName: string;
    number: number;
    url: string;
    authorLogin: string;
    title: string;
    state: string;
    isDraft: boolean;
    isTracked: boolean;
    trackingReason: string;
    isStickyUntracked: boolean;
    lastSeenAt: string | null;
    closedAt: string | null;
    mergedAt: string | null;
    graceUntil: string | null;
    lastSeenHeadSha: string | null;
    createdAt: string;
    updatedAt: string;
  }> = {},
) {
  return {
    id: 1,
    githubPullRequestId: 101,
    repositoryOwner: "acme",
    repositoryName: "octopulse",
    number: 7,
    url: "https://github.com/acme/octopulse/pull/7",
    authorLogin: "octocat",
    title: "Add pull request polling",
    state: "open",
    isDraft: false,
    isTracked: true,
    trackingReason: "manual",
    isStickyUntracked: false,
    lastSeenAt: "2026-04-10T12:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    graceUntil: null,
    lastSeenHeadSha: "abc123",
    createdAt: "2026-04-10 12:00:00",
    updatedAt: "2026-04-10 12:00:00",
    ...overrides,
  };
}
