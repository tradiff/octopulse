import { describe, expect, it } from "vitest";

import { renderNotification } from "../src/notification-rendering.js";

describe("renderNotification", () => {
  it("renders repo, PR number, actor name, and click url for immediate notifications", () => {
    expect(
      renderNotification(
        {
          repositoryOwner: "acme",
          repositoryName: "octopulse",
          number: 7,
          title: "Ship notifications",
          url: "https://github.com/acme/octopulse/pull/7",
        },
        [
          {
            id: 101,
            eventType: "review_approved",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse PR #7",
      body: "alice approved review\nShip notifications",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "alice approved review",
    });
  });

  it("renders short bundled summaries", () => {
    expect(
      renderNotification(
        {
          repositoryOwner: "acme",
          repositoryName: "octopulse",
          number: 7,
          title: "Ship notifications",
          url: "https://github.com/acme/octopulse/pull/7",
        },
        [
          {
            id: 201,
            eventType: "issue_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
          },
          {
            id: 202,
            eventType: "review_inline_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:30.000Z",
          },
          {
            id: 203,
            eventType: "ci_failed",
            actorLogin: "github-actions[bot]",
            occurredAt: "2026-04-10T12:00:45.000Z",
          },
        ],
      ),
    ).toMatchObject({
      title: "acme/octopulse PR #7",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "2 comments, CI failed",
    });
  });
});
