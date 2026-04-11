import { describe, expect, it } from "vitest";

import { describeApp } from "../src/app.js";

describe("describeApp", () => {
  it("returns the scaffold status message", () => {
    expect(describeApp()).toBe("Octopulse foundation is ready.");
  });
});
