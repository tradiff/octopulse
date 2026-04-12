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
            payloadJson: JSON.stringify({ bodyText: "Looks good to me" }),
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse #7 Ship notifications",
      body: "alice: ✅ Looks good to me",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "alice approved review",
    });
  });

  it("renders bundled summaries with primary events before comments and quoted snippets", () => {
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
            eventType: "review_submitted",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: JSON.stringify({ bodyText: "Looks good" }),
          },
          {
            id: 202,
            eventType: "issue_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:15.000Z",
            payloadJson: JSON.stringify({ bodyText: "maybe we can change this part" }),
          },
          {
            id: 203,
            eventType: "review_inline_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:30.000Z",
            payloadJson: JSON.stringify({ bodyText: "nit: rename this" }),
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse #7 Ship notifications",
      body:
        "alice: 💬 Looks good\n\nalice: 💬 maybe we can change this part\n\nalice: 💬 nit: rename this",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "alice: 1 review, 2 comments",
    });
  });

  it("truncates long snippets", () => {
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
            id: 301,
            eventType: "issue_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: JSON.stringify({
              bodyText:
                "This comment is intentionally very long so notification renderer must truncate it before sending it to desktop notification daemon.",
            }),
          },
        ],
      ),
    ).toMatchObject({
      body: expect.stringContaining("alice: 💬 This comment is intentionally very long so notification renderer must truncate it before sending"),
    });
  });
});
