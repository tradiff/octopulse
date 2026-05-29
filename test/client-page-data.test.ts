import { describe, expect, it, vi } from "vitest";

import {
  loadLogsData,
  loadNotificationHistoryPageData,
  loadPullRequestsPageData,
} from "../src/client-page-data.js";
import { DEFAULT_UI_FILTERS } from "../src/ui-filters.js";

describe("client page data loaders", () => {
  it("loads pull request page data through one module", async () => {
    const fetcher = vi.fn(async (url: string) => {
      switch (url) {
        case "/api/tracked-pull-requests":
          return { pullRequests: [{ githubPullRequestId: 101 }] };
        case "/api/inactive-pull-requests":
          return { pullRequests: [{ githubPullRequestId: 202 }] };
        case "/api/pull-request-timeline":
          return {
            timelineByPullRequest: { "101": [] },
            reviewStatesByPullRequest: { "101": [] },
            ciJobStatesByPullRequest: { "101": [] },
          };
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    await expect(loadPullRequestsPageData(fetcher as unknown as typeof import("../src/client-page-data.js").apiFetch)).resolves.toEqual({
      trackedPullRequests: [{ githubPullRequestId: 101 }],
      inactivePullRequests: [{ githubPullRequestId: 202 }],
      timelineByPullRequest: { "101": [] },
      reviewStatesByPullRequest: { "101": [] },
      ciJobStatesByPullRequest: { "101": [] },
    });
  });

  it("loads notification history and logs through one module", async () => {
    const fetcher = vi.fn(async (url: string) => {
      switch (url) {
        case "/api/tracked-pull-requests":
          return { pullRequests: [{ githubPullRequestId: 101 }] };
        case "/api/inactive-pull-requests":
          return { pullRequests: [] };
        case "/api/notification-history?pr-state=tracked&page=2":
          return {
            notificationHistory: [{ id: 1 }],
            pagination: { page: 2, pageSize: 20, totalCount: 25, totalPages: 2 },
          };
        case "/api/logs?level=warn":
          return { logs: [{ message: "warn", level: "warn" }] };
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    await expect(
      loadNotificationHistoryPageData(
        {
          uiFilters: {
            ...DEFAULT_UI_FILTERS,
            pullRequestStates: ["tracked"],
          },
          activityPage: 2,
        },
        fetcher as unknown as typeof import("../src/client-page-data.js").apiFetch,
      ),
    ).resolves.toEqual({
      trackedPullRequests: [{ githubPullRequestId: 101 }],
      inactivePullRequests: [],
      notificationHistory: [{ id: 1 }],
      pagination: { page: 2, pageSize: 20, totalCount: 25, totalPages: 2 },
    });

    await expect(loadLogsData("warn", fetcher as unknown as typeof import("../src/client-page-data.js").apiFetch)).resolves.toEqual([
      { message: "warn", level: "warn" },
    ]);
  });
});
