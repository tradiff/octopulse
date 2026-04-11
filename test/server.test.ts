import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readServerOrigin, startServer } from "../src/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("startServer", () => {
  it("binds to localhost and serves the health endpoint", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const address = server.address();

    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");

    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listening address");
    }

    expect(address.address).toBe("127.0.0.1");

    const response = await fetch(`${readServerOrigin(server)}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the React shell from the root path", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listTrackedPullRequests: async () => [createPullRequestResponseRecord()],
      listInactivePullRequests: async () => [
        createPullRequestResponseRecord({
          id: 2,
          githubPullRequestId: 202,
          repositoryName: "worker",
          number: 12,
          title: "Keep inactive list visible",
          state: "closed",
          isTracked: false,
          isStickyUntracked: true,
        }),
      ],
      listNotificationHistory: async () => [
        {
          id: 1,
          title: "acme/octopulse PR #7",
          body: "alice approved review\nAdd pull request polling",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "pending" as const,
          createdAt: "2026-04-10 12:03:00",
          deliveredAt: null,
          decisionStates: ["notified" as const],
          eventTypes: ["review_approved"],
          actorClasses: ["human_other" as const],
          sourceKind: "immediate" as const,
          repositoryKey: "acme/octopulse",
          isTracked: true,
        },
      ],
      listRawEvents: async () => [
        {
          id: 17,
          repositoryKey: "acme/octopulse",
          isTracked: true,
          pullRequestLabel: "acme/octopulse #7",
          pullRequestTitle: "Add pull request polling",
          pullRequestUrl: "https://github.com/acme/octopulse/pull/7",
          eventType: "review_changes_requested",
          actorLogin: "alice",
          actorClass: "human_other" as const,
          decisionState: "notified" as const,
          notificationTiming: "immediate" as const,
          occurredAt: "2026-04-10T12:04:00.000Z",
          rawPayloadJson: '{"state":"CHANGES_REQUESTED"}',
          notificationSourceKind: "immediate" as const,
          notificationDeliveryStatus: "sent" as const,
        },
      ],
    });
    servers.push(server);

    const response = await fetch(readServerOrigin(server));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Octopulse");
    expect(html).toContain("Add pull request polling");
    expect(html).toContain("Keep inactive list visible");
    expect(html).toContain('action="/tracked-pull-requests/manual-track"');
    expect(html).toContain("Untrack");
    expect(html).toContain("Track Again");
    expect(html).toContain("Notification History");
    expect(html).toContain("alice approved review");
    expect(html).toContain("Pending");
    expect(html).toContain("Raw Events");
    expect(html).toContain("Review Changes Requested");
    expect(html).toContain("Raw JSON");
  });

  it("applies UI filters across pull requests, history, and raw events", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listTrackedPullRequests: async () => [createPullRequestResponseRecord()],
      listInactivePullRequests: async () => [
        createPullRequestResponseRecord({
          id: 2,
          githubPullRequestId: 202,
          repositoryName: "worker",
          number: 12,
          title: "Keep inactive list visible",
          url: "https://github.com/acme/worker/pull/12",
          state: "closed",
          isTracked: false,
          isStickyUntracked: true,
        }),
      ],
      listNotificationHistory: async () => [
        {
          id: 1,
          title: "acme/octopulse PR #7",
          body: "alice approved review\nAdd pull request polling",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "pending" as const,
          createdAt: "2026-04-10 12:03:00",
          deliveredAt: null,
          decisionStates: ["notified" as const],
          eventTypes: ["review_approved"],
          actorClasses: ["human_other" as const],
          sourceKind: "immediate" as const,
          repositoryKey: "acme/octopulse",
          isTracked: true,
        },
        {
          id: 2,
          title: "acme/worker PR #12",
          body: "CI failed\nKeep inactive list visible",
          clickUrl: "https://github.com/acme/worker/pull/12",
          deliveryStatus: "sent" as const,
          createdAt: "2026-04-11 09:00:00",
          deliveredAt: "2026-04-11T09:00:05.000Z",
          decisionStates: ["suppressed_rule" as const],
          eventTypes: ["issue_comment"],
          actorClasses: ["bot" as const],
          sourceKind: "bundle" as const,
          repositoryKey: "acme/worker",
          isTracked: false,
        },
      ],
      listRawEvents: async () => [
        {
          id: 17,
          repositoryKey: "acme/octopulse",
          isTracked: true,
          pullRequestLabel: "acme/octopulse #7",
          pullRequestTitle: "Add pull request polling",
          pullRequestUrl: "https://github.com/acme/octopulse/pull/7",
          eventType: "review_changes_requested",
          actorLogin: "alice",
          actorClass: "human_other" as const,
          decisionState: "notified" as const,
          notificationTiming: "immediate" as const,
          occurredAt: "2026-04-10T12:04:00.000Z",
          rawPayloadJson: '{"state":"CHANGES_REQUESTED"}',
          notificationSourceKind: "immediate" as const,
          notificationDeliveryStatus: "sent" as const,
        },
        {
          id: 18,
          repositoryKey: "acme/worker",
          isTracked: false,
          pullRequestLabel: "acme/worker #12",
          pullRequestTitle: "Keep inactive list visible",
          pullRequestUrl: "https://github.com/acme/worker/pull/12",
          eventType: "issue_comment",
          actorLogin: "ci-bot[bot]",
          actorClass: "bot" as const,
          decisionState: "suppressed_rule" as const,
          notificationTiming: null,
          occurredAt: "2026-04-11T09:00:00.000Z",
          rawPayloadJson: '{"body":"CI says hello"}',
          notificationSourceKind: "bundle" as const,
          notificationDeliveryStatus: "pending" as const,
        },
      ],
    });
    servers.push(server);

    const query = new URLSearchParams({
      "pr-state": "inactive",
      repo: "acme/worker",
      "event-type": "issue_comment",
      "decision-state": "suppressed_rule",
      "actor-type": "bot",
      "start-date": "2026-04-11",
      "end-date": "2026-04-11",
    });
    const response = await fetch(`${readServerOrigin(server)}/?${query}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Keep inactive list visible");
    expect(html).not.toContain("Add pull request polling");
    expect(html).not.toContain("alice approved review");
    expect(html).toContain("CI failed");
    expect(html).toContain("ci-bot[bot]");
    expect(html).toContain('value="2026-04-11"');
  });

  it("handles manual track form submissions and shows a success message", async () => {
    const trackedPullRequests = [createPullRequestResponseRecord()];
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listTrackedPullRequests: async () => trackedPullRequests,
      listInactivePullRequests: async () => [],
      manualTrackPullRequestByUrl: async (pullRequestUrl: string) => {
        const trackedPullRequest = createPullRequestResponseRecord({
          githubPullRequestId: 303,
          repositoryName: "api",
          number: 19,
          url: pullRequestUrl,
          title: "Track a pull request from the UI",
        });
        trackedPullRequests.push(trackedPullRequest);
        return {
          outcome: "tracked" as const,
          pullRequest: trackedPullRequest,
        };
      },
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/tracked-pull-requests/manual-track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        url: "https://github.com/acme/api/pull/19",
      }),
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Now tracking acme/api #19.");
    expect(html).toContain("Track a pull request from the UI");
  });

  it("shows a clear no-op message when a tracked PR is submitted again from the UI", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listTrackedPullRequests: async () => [createPullRequestResponseRecord()],
      listInactivePullRequests: async () => [],
      manualTrackPullRequestByUrl: async (pullRequestUrl: string) => ({
        outcome: "already_tracked" as const,
        pullRequest: createPullRequestResponseRecord({ url: pullRequestUrl }),
      }),
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/tracked-pull-requests/manual-track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        url: "https://github.com/acme/octopulse/pull/7",
      }),
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("acme/octopulse #7 is already tracked.");
  });

  it("handles manual untrack and re-track form submissions", async () => {
    const retrackedPullRequest = createPullRequestResponseRecord({
      githubPullRequestId: 202,
      repositoryName: "worker",
      number: 12,
      title: "Keep inactive list visible",
      url: "https://github.com/acme/worker/pull/12",
      isTracked: false,
      isStickyUntracked: true,
    });
    let trackedPullRequests = [createPullRequestResponseRecord()];
    let inactivePullRequests = [retrackedPullRequest];
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listTrackedPullRequests: async () => trackedPullRequests,
      listInactivePullRequests: async () => inactivePullRequests,
      manualUntrackPullRequest: async (githubPullRequestId: number) => {
        const pullRequest = createPullRequestResponseRecord({
          githubPullRequestId,
          isTracked: false,
          isStickyUntracked: true,
        });
        trackedPullRequests = [];
        inactivePullRequests = [pullRequest, ...inactivePullRequests];
        return {
          outcome: "untracked" as const,
          pullRequest,
        };
      },
      manualTrackPullRequestByUrl: async (pullRequestUrl: string) => {
        trackedPullRequests = [
          createPullRequestResponseRecord({
            ...retrackedPullRequest,
            url: pullRequestUrl,
            isTracked: true,
            isStickyUntracked: false,
          }),
        ];
        inactivePullRequests = [];
        return {
          outcome: "tracked" as const,
          pullRequest: trackedPullRequests[0]!,
        };
      },
    });
    servers.push(server);

    const untrackResponse = await fetch(
      `${readServerOrigin(server)}/tracked-pull-requests/101/untrack`,
      {
        method: "POST",
      },
    );
    const untrackHtml = await untrackResponse.text();

    expect(untrackResponse.status).toBe(200);
    expect(untrackHtml).toContain("Stopped tracking acme/octopulse #7.");

    const retrackResponse = await fetch(`${readServerOrigin(server)}/inactive-pull-requests/retrack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        url: "https://github.com/acme/worker/pull/12",
      }),
    });
    const retrackHtml = await retrackResponse.text();

    expect(retrackResponse.status).toBe(200);
    expect(retrackHtml).toContain("Now tracking acme/worker #12.");
    expect(retrackHtml).toContain("Keep inactive list visible");
  });

  it("accepts manual pull request tracking requests", async () => {
    const manualTrackPullRequestByUrl = vi.fn(async (pullRequestUrl: string) => ({
      outcome: "tracked" as const,
      pullRequest: createPullRequestResponseRecord({ url: pullRequestUrl }),
    }));
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      manualTrackPullRequestByUrl,
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/tracked-pull-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: " https://github.com/acme/octopulse/pull/7 " }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      outcome: "tracked",
      pullRequest: {
        githubPullRequestId: 101,
        trackingReason: "manual",
        isTracked: true,
      },
    });
    expect(manualTrackPullRequestByUrl).toHaveBeenCalledWith(
      "https://github.com/acme/octopulse/pull/7",
    );
  });

  it("lists tracked pull requests for the UI layer", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listTrackedPullRequests: async () => [createPullRequestResponseRecord()],
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/tracked-pull-requests`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      pullRequests: [createPullRequestResponseRecord()],
    });
  });

  it("lists inactive pull requests for the UI layer", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listInactivePullRequests: async () => [
        createPullRequestResponseRecord({
          githubPullRequestId: 202,
          isTracked: false,
          trackingReason: "manual",
          isStickyUntracked: true,
        }),
      ],
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/inactive-pull-requests`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      pullRequests: [
        createPullRequestResponseRecord({
          githubPullRequestId: 202,
          isTracked: false,
          trackingReason: "manual",
          isStickyUntracked: true,
        }),
      ],
    });
  });

  it("accepts manual pull request untracking requests", async () => {
    const manualUntrackPullRequest = vi.fn(async (githubPullRequestId: number) => ({
      outcome: "untracked" as const,
      pullRequest: createPullRequestResponseRecord({
        githubPullRequestId,
        isTracked: false,
        trackingReason: "manual",
        isStickyUntracked: true,
      }),
    }));
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      manualUntrackPullRequest,
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/tracked-pull-requests/101`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      outcome: "untracked",
      pullRequest: {
        githubPullRequestId: 101,
        isTracked: false,
        isStickyUntracked: true,
      },
    });
    expect(manualUntrackPullRequest).toHaveBeenCalledWith(101);
  });

  it("returns already tracked responses without treating them as errors", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      manualTrackPullRequestByUrl: async (pullRequestUrl: string) => ({
        outcome: "already_tracked",
        pullRequest: createPullRequestResponseRecord({ url: pullRequestUrl }),
      }),
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/tracked-pull-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://github.com/acme/octopulse/pull/7" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "already_tracked",
      pullRequest: {
        githubPullRequestId: 101,
      },
    });
  });

  it("rejects invalid manual tracking request bodies", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      manualTrackPullRequestByUrl: async (pullRequestUrl: string) => ({
        outcome: "tracked",
        pullRequest: createPullRequestResponseRecord({ url: pullRequestUrl }),
      }),
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/tracked-pull-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request body.url must be a non-empty string",
    });
  });
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createPullRequestResponseRecord(
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
