import { describe, expect, it } from "vitest";

import {
  renderNotificationMarkup,
  renderNotification,
} from "../src/notification-rendering.js";

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

  it("renders review-requested notifications without actor metadata", () => {
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
            id: 111,
            eventType: "review_requested",
            actorLogin: null,
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: "{}",
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse #7 Ship notifications",
      body: "👀 review requested",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "review requested",
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

  it("does not attribute bundled CI outcomes to a person", () => {
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
            id: 211,
            eventType: "issue_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: JSON.stringify({ bodyText: "Need test coverage" }),
          },
          {
            id: 212,
            eventType: "ci_failed",
            actorLogin: "github-actions[bot]",
            occurredAt: "2026-04-10T12:00:30.000Z",
            payloadJson: "{}",
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse #7 Ship notifications",
      body: "alice: 💬 Need test coverage\n\nCI failed",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "CI failed, 1 comment",
    });
  });

  it("omits empty review-submitted wrappers when inline comments for the same review are present", () => {
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
            id: 221,
            eventType: "review_submitted",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: JSON.stringify({ reviewId: 42, bodyText: "   " }),
          },
          {
            id: 222,
            eventType: "review_inline_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:15.000Z",
            payloadJson: JSON.stringify({ reviewId: 42, bodyText: "nit: rename this" }),
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse #7 Ship notifications",
      body: "alice: 💬 nit: rename this",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "alice left inline comment",
    });
  });

  it("keeps review-submitted events with their own body text", () => {
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
            id: 231,
            eventType: "review_submitted",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: JSON.stringify({ reviewId: 42, bodyText: "Looks good overall" }),
          },
          {
            id: 232,
            eventType: "review_inline_comment",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:15.000Z",
            payloadJson: JSON.stringify({ reviewId: 42, bodyText: "nit: rename this" }),
          },
        ],
      ),
    ).toEqual({
      title: "acme/octopulse #7 Ship notifications",
      body: "alice: 💬 Looks good overall\n\nalice: 💬 nit: rename this",
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "alice: 1 review, 1 comment",
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

  it("converts bot markdown and html into plain text summaries", () => {
    const notification = renderNotification(
      {
        repositoryOwner: "acme",
        repositoryName: "octopulse",
        number: 7,
        title: "Ship notifications",
        url: "https://github.com/acme/octopulse/pull/7",
      },
      [
        {
          id: 302,
          eventType: "issue_comment",
          actorLogin: "gitar-bot[bot]",
          occurredAt: "2026-04-10T12:00:00.000Z",
          payloadJson: JSON.stringify({
            bodyText: [
              "<details>",
              "<summary><b>Code Review</b> <kbd>👍 Approved with suggestions</kbd></summary>",
              "",
              "Implements byte-symmetric BP4/BP5 Purl handling.",
              "",
              "<details>",
              "<summary>💡 <b>Edge Case:</b> withoutVersionAndEpoch crashes if '#' precedes '?' in input</summary>",
              "",
              "<kbd>📄 <a href=\"https://github.com/acme/octopulse/pull/7/files\">AbstractPurl.java:432-438</a></kbd>",
              "",
              "````",
              'var qualifierString = "";',
              "````",
              "",
              "</details>",
              "</details>",
            ].join("\n"),
          }),
        },
      ],
    );

    expect(notification).toMatchObject({
      title: "acme/octopulse #7 Ship notifications",
      body: expect.stringContaining(
        "gitar-bot[bot]: 💬 Code Review 👍 Approved with suggestions Implements byte-symmetric BP4/BP5 Purl handling",
      ),
      clickUrl: "https://github.com/acme/octopulse/pull/7",
      summary: "gitar-bot[bot] commented",
    });
    expect(notification.body).not.toContain("<details>");
    expect(notification.body).not.toContain("<kbd>");
    expect(notification.body).not.toContain("````");
  });

  it("renders notification markup model with header avatar and actor avatars", () => {
    expect(
      renderNotificationMarkup(
        {
          repositoryName: "octopulse",
          title: "Ship notifications",
          authorLogin: "octocat",
          authorAvatarUrl: "https://avatars.example.test/octocat.png",
          state: "open",
          isDraft: false,
          mergedAt: null,
        },
        [
          {
            id: 401,
            eventType: "review_approved",
            actorLogin: "alice",
            occurredAt: "2026-04-10T12:00:00.000Z",
            payloadJson: JSON.stringify({
              bodyText: "LGTM",
              actorAvatarUrl: "https://avatars.example.test/alice.png",
            }),
          },
          {
            id: 402,
            eventType: "ci_failed",
            actorLogin: "github-actions[bot]",
            occurredAt: "2026-04-10T12:00:30.000Z",
            payloadJson: JSON.stringify({
              actorAvatarUrl: "https://avatars.example.test/actions.png",
            }),
          },
        ],
      ),
    ).toEqual({
      headerText: "[octopulse] Ship notifications (open)",
      headerAvatarKey: "octocat",
      headerAvatarUrl: "https://avatars.example.test/octocat.png",
      paragraphs: [
        {
          actorLogin: "alice",
          actorAvatarKey: "alice",
          actorAvatarUrl: "https://avatars.example.test/alice.png",
          text: "✅ LGTM",
        },
        {
          actorLogin: null,
          actorAvatarKey: null,
          actorAvatarUrl: null,
          text: "CI failed",
        },
      ],
    });
  });
});
