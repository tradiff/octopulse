import { describe, expect, it } from "vitest";

import { renderAppDocument } from "../src/app.js";

describe("renderAppDocument", () => {
  it("renders the initial React shell", () => {
    const html = renderAppDocument();

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Octopulse</title>");
    expect(html).toContain("Pull Requests");
    expect(html).toContain("Notification History");
  });
});
