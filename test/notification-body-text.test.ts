import { describe, expect, it } from "vitest";

import { normalizeNotificationBodyText } from "../src/notification-body-text.js";

describe("normalizeNotificationBodyText", () => {
  it("converts markdown badges and links into readable plain text", () => {
    expect(
      normalizeNotificationBodyText([
        "## [![Quality Gate Failed](https://example.test/badge.png 'Quality Gate Failed')](https://example.test) **Quality Gate failed**  ",
        "Failed conditions  ",
        "![](https://example.test/failed-16px.png '') [1 New issue](https://example.test/issues)  ",
        "<!-- sqra-placement-anchor -->",
        "[See analysis details on SonarQube Cloud](https://example.test/dashboard)",
      ].join("\n")),
    ).toBe(
      "Quality Gate Failed Quality Gate failed Failed conditions 1 New issue See analysis details on SonarQube Cloud",
    );
  });

  it("strips html wrappers and fenced code blocks", () => {
    expect(
      normalizeNotificationBodyText([
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
      ].join("\n")),
    ).toBe(
      "Code Review 👍 Approved with suggestions Implements byte-symmetric BP4/BP5 Purl handling. 💡 Edge Case: withoutVersionAndEpoch crashes if '#' precedes '?' in input 📄 AbstractPurl.java:432-438",
    );
  });
});
