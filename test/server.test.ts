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
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(readServerOrigin(server));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Octopulse");
    expect(html).toContain("Raw Events");
  });

  it("accepts manual pull request tracking requests", async () => {
    const manualTrackPullRequestByUrl = vi.fn(async (pullRequestUrl: string) => ({
      outcome: "tracked" as const,
      pullRequest: createPullRequestResponseRecord(pullRequestUrl),
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

  it("returns already tracked responses without treating them as errors", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      manualTrackPullRequestByUrl: async (pullRequestUrl: string) => ({
        outcome: "already_tracked",
        pullRequest: createPullRequestResponseRecord(pullRequestUrl),
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
        pullRequest: createPullRequestResponseRecord(pullRequestUrl),
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

function createPullRequestResponseRecord(pullRequestUrl: string) {
  return {
    id: 1,
    githubPullRequestId: 101,
    repositoryOwner: "acme",
    repositoryName: "octopulse",
    number: 7,
    url: pullRequestUrl,
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
  };
}
