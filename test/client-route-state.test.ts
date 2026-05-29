import { describe, expect, it } from "vitest";

import {
  buildActivityPageHref,
  buildPageHref,
  countActivePageFilters,
  readRouteState,
} from "../src/client-route-state.js";
import { DEFAULT_UI_FILTERS, type UiFilterValues } from "../src/ui-filters.js";

describe("client route state helpers", () => {
  it("reads route state from the browser URL", () => {
    expect(
      readRouteState(
        new URL(
          "http://127.0.0.1/notification-history?pr-state=tracked&repo=acme%2Foctopulse&actor-type=human_other&page=3",
        ),
      ),
    ).toEqual({
      currentPage: "notification-history",
      uiFilters: {
        pullRequestStates: ["tracked"],
        repository: "acme/octopulse",
        actorClass: "human_other",
      },
      logLevelFilter: "all",
      activityPage: 3,
      prSubTab: "my-prs",
    });
  });

  it("builds navigation hrefs from one route module", () => {
    const uiFilters: UiFilterValues = {
      ...DEFAULT_UI_FILTERS,
      pullRequestStates: ["tracked"],
      repository: "acme/octopulse",
    };

    expect(buildPageHref("pull-requests", uiFilters, "all", "review-requested")).toBe(
      "/?pr-state=tracked&repo=acme%2Foctopulse&tab=review-requested",
    );
    expect(
      buildActivityPageHref(
        "notification-history",
        {
          ...uiFilters,
          actorClass: "human_other",
        },
        2,
      ),
    ).toBe("/notification-history?pr-state=tracked&repo=acme%2Foctopulse&actor-type=human_other&page=2");
    expect(countActivePageFilters(uiFilters, "pull-requests", "all")).toBe(2);
  });
});
