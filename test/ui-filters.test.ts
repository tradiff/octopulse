import { describe, expect, it } from "vitest";

import { DEFAULT_LANDING_UI_FILTERS, DEFAULT_UI_FILTERS, readUiFilterValues } from "../src/ui-filters.js";

describe("readUiFilterValues", () => {
  it("defaults to tracked and open when no UI filters are present", () => {
    expect(readUiFilterValues(new URLSearchParams(), DEFAULT_LANDING_UI_FILTERS)).toEqual(
      DEFAULT_LANDING_UI_FILTERS,
    );
    expect(readUiFilterValues(new URLSearchParams("tab=review-requested"), DEFAULT_LANDING_UI_FILTERS)).toEqual(
      DEFAULT_LANDING_UI_FILTERS,
    );
  });

  it("does not apply landing defaults when explicit UI filters are present", () => {
    expect(readUiFilterValues(new URLSearchParams("repo=acme%2Foctopulse"), DEFAULT_LANDING_UI_FILTERS)).toEqual({
      ...DEFAULT_UI_FILTERS,
      repository: "acme/octopulse",
    });
  });

  it("treats pr-state=all as an explicit cleared filter state", () => {
    expect(readUiFilterValues(new URLSearchParams("pr-state=all"), DEFAULT_LANDING_UI_FILTERS)).toEqual(
      DEFAULT_UI_FILTERS,
    );
  });
});
