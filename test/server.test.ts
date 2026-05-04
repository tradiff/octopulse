import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_ACTIVITY_PAGE_SIZE } from "../src/activity-feed.js";
import { readServerOrigin, startServer } from "../src/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("startServer", () => {
  it("binds to localhost and serves the health endpoint", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the SPA document on history routes", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/notification-history`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<div id=\"root\"></div>");
    expect(html).toContain('href="/favicon.png"');
    expect(html).toContain('src="/app.js"');
    expect(html).not.toContain("Track Pull Request");
  });

  it("serves the favicon asset", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/favicon.png`);
    const favicon = await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(favicon.byteLength).toBeGreaterThan(0);
  });

  it("serves pull request state assets", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/assets/pull-request-open.svg`);
    const asset = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(asset).toContain("<svg");
  });

  it("serves pull request APIs", async () => {
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
          isTracked: false,
          isStickyUntracked: true,
          state: "closed",
        }),
      ],
    });
    servers.push(server);

    const trackedResponse = await fetch(`${readServerOrigin(server)}/api/tracked-pull-requests`);
    const inactiveResponse = await fetch(`${readServerOrigin(server)}/api/inactive-pull-requests`);

    expect(trackedResponse.status).toBe(200);
    expect(inactiveResponse.status).toBe(200);
    expect((await trackedResponse.json()) as unknown).toEqual({
      pullRequests: [createPullRequestResponseRecord()],
    });
    expect((await inactiveResponse.json()) as unknown).toEqual({
      pullRequests: [
        createPullRequestResponseRecord({
          id: 2,
          githubPullRequestId: 202,
          repositoryName: "worker",
          number: 12,
          title: "Keep inactive list visible",
          isTracked: false,
          isStickyUntracked: true,
          state: "closed",
        }),
      ],
    });
  });

  it("serves pull request timeline API", async () => {
    const timelineByPullRequest = {
      101: [
        {
          id: 1,
          eventType: "review_approved",
          occurredAt: "2026-04-10T12:03:00.000Z",
          paragraph: {
            actorLogin: "alice",
            actorAvatarKey: "alice",
            actorAvatarUrl: "https://avatars.example.test/alice.png",
            text: "✅ approved",
          },
        },
      ],
      202: [],
    };
    const reviewStatesByPullRequest = {
      101: [
        {
          id: 1,
          pullRequestId: 10,
          reviewerLogin: "alice",
          reviewerAvatarUrl: "https://avatars.example.test/alice.png",
          reviewState: "APPROVED" as const,
          updatedAt: "2026-04-10T12:03:00.000Z",
        },
      ],
      202: [],
    };
    const ciJobStatesByPullRequest = {
      101: [],
      202: [],
    };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listPullRequestTimeline: async () => ({ timelineByPullRequest, reviewStatesByPullRequest, ciJobStatesByPullRequest }),
    });
    servers.push(server);

    const response = await fetch(`${readServerOrigin(server)}/api/pull-request-timeline`);

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      timelineByPullRequest,
      reviewStatesByPullRequest,
      ciJobStatesByPullRequest,
    });
  });

  it("serves notification history and logs APIs", async () => {
    let notificationHistoryOptions: unknown;

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      listNotificationHistory: async (options) => {
        notificationHistoryOptions = options;

        return {
          entries: [
            {
              id: 1,
              title: "acme/octopulse PR #7",
              markupHeaderText: "[octopulse] Add pull request polling (open)",
              body: "alice approved review",
              clickUrl: "https://github.com/acme/octopulse/pull/7",
              deliveryStatus: "sent" as const,
              createdAt: "2026-04-10 12:03:00",
              deliveredAt: "2026-04-10T12:03:02.000Z",
              decisionStates: ["notified" as const],
              eventTypes: ["review_approved"],
              actorClasses: ["human_other" as const],
                sourceKind: "immediate" as const,
                repositoryKey: "acme/octopulse",
                isTracked: true,
                pullRequestStatus: "open" as const,
                pullRequestStateAssetUrlPath: "/assets/pull-request-open.svg",
                author: {
                  login: "octocat",
                  avatarUrl: "https://avatars.example.test/octocat.png",
              },
              actors: [
                {
                  login: "alice",
                  avatarUrl: "https://avatars.example.test/alice.png",
                },
              ],
              summaryParagraphs: [
                {
                  actorLogin: "alice",
                  actorAvatarKey: "alice",
                  actorAvatarUrl: "https://avatars.example.test/alice.png",
                  text: "✅ approved",
                },
              ],
            },
          ],
          page: 2,
          pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
          totalCount: 3,
          totalPages: 3,
        };
      },
      listRecentLogs: async ({ level }) =>
        level === "warn"
          ? [
              {
                id: "octopulse-2026-04-11.jsonl:3",
                timestamp: "2026-04-11T12:04:00.000Z",
                level: "warn" as const,
                message: "Tracked polling slowed down",
              },
            ]
          : [
              {
                id: "octopulse-2026-04-11.jsonl:2",
                timestamp: "2026-04-11T12:03:00.000Z",
                level: "info" as const,
                message: "Tracked polling cycle complete",
              },
            ],
    });
    servers.push(server);

    const historyResponse = await fetch(
      `${readServerOrigin(server)}/api/notification-history?pr-state=tracked&pr-state=merged&repo=acme%2Foctopulse&actor-type=human_other&page=2`,
    );
    const logsResponse = await fetch(`${readServerOrigin(server)}/api/logs?level=warn`);

    expect(historyResponse.status).toBe(200);
    expect(logsResponse.status).toBe(200);

    expect(notificationHistoryOptions).toEqual({
      filters: {
        pullRequestStates: ["tracked", "merged"],
        repository: "acme/octopulse",
        actorClass: "human_other",
      },
      page: 2,
      pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
    });
    expect((await historyResponse.json()) as unknown).toEqual({
      notificationHistory: [
        {
          id: 1,
          title: "acme/octopulse PR #7",
          markupHeaderText: "[octopulse] Add pull request polling (open)",
          body: "alice approved review",
          clickUrl: "https://github.com/acme/octopulse/pull/7",
          deliveryStatus: "sent",
          createdAt: "2026-04-10 12:03:00",
          deliveredAt: "2026-04-10T12:03:02.000Z",
          decisionStates: ["notified"],
          eventTypes: ["review_approved"],
          actorClasses: ["human_other"],
           sourceKind: "immediate",
           repositoryKey: "acme/octopulse",
           isTracked: true,
           pullRequestStatus: "open",
           pullRequestStateAssetUrlPath: "/assets/pull-request-open.svg",
           author: {
             login: "octocat",
             avatarUrl: "https://avatars.example.test/octocat.png",
          },
          actors: [
            {
              login: "alice",
              avatarUrl: "https://avatars.example.test/alice.png",
            },
          ],
          summaryParagraphs: [
            {
              actorLogin: "alice",
              actorAvatarKey: "alice",
              actorAvatarUrl: "https://avatars.example.test/alice.png",
              text: "✅ approved",
            },
          ],
        },
      ],
      pagination: {
        page: 2,
        pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
        totalCount: 3,
        totalPages: 3,
      },
    });
    expect((await logsResponse.json()) as unknown).toEqual({
      logs: [
        {
          id: "octopulse-2026-04-11.jsonl:3",
          timestamp: "2026-04-11T12:04:00.000Z",
          level: "warn",
          message: "Tracked polling slowed down",
        },
      ],
    });
  });
});

function createPullRequestResponseRecord(
  overrides: Partial<{
    id: number;
    githubPullRequestId: number;
    repositoryOwner: string;
    repositoryName: string;
    number: number;
    url: string;
    authorLogin: string;
    authorAvatarUrl: string | null;
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
    baseBranch: string | null;
    mergeable: boolean | null;
    mergeableState: string | null;
    requestedReviewTeamSlugs: string[];
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
    authorAvatarUrl: "https://avatars.example.test/octocat.png",
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
    baseBranch: "main",
    mergeable: null,
    mergeableState: null,
    requestedReviewTeamSlugs: [],
    createdAt: "2026-04-10 12:00:00",
    updatedAt: "2026-04-10 12:00:00",
    ...overrides,
  };
}

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
