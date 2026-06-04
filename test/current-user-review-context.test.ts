import { describe, expect, it } from "vitest";

import { loadCurrentUserReviewContext } from "../src/current-user-review-context.js";

describe("loadCurrentUserReviewContext", () => {
  it("loads current-user teams", async () => {
    const requests: string[] = [];
    const client = {
      request: async (route: string, params: Record<string, unknown>) => {
        requests.push(`${route}:${JSON.stringify(params)}`);

        if (route === "GET /user/teams") {
          return {
            data:
              params.page === 1
                ? [
                    {
                      slug: "owners",
                      organization: { login: "Acme" },
                    },
                  ]
                : [],
          };
        }

        throw new Error(`Unexpected route ${route}`);
      },
    };

    await expect(loadCurrentUserReviewContext(client as never)).resolves.toEqual({
      teamKeys: ["acme/owners"],
    });
    expect(requests).toHaveLength(1);
  });
});
