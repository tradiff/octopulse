import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { GitHubAuthError, initializeGitHubAuth } from "../src/github.js";

const TEST_CONFIG: Pick<AppConfig, "githubToken"> = {
  githubToken: "ghp_test_secret_123",
};

describe("initializeGitHubAuth", () => {
  it("creates an authenticated client and resolves the current user login", async () => {
    const client = { kind: "fake-client" };
    const clientFactory = vi.fn(() => client);
    const currentUserResolver = vi.fn(async () => ({ login: "octocat" }));

    await expect(
      initializeGitHubAuth(TEST_CONFIG, { clientFactory, currentUserResolver }),
    ).resolves.toEqual({
      client,
      currentUserLogin: "octocat",
    });

    expect(clientFactory).toHaveBeenCalledWith(TEST_CONFIG.githubToken);
    expect(currentUserResolver).toHaveBeenCalledWith(client);
  });

  it("reports auth failures without leaking the configured token", async () => {
    let thrownError: unknown;

    try {
      await initializeGitHubAuth(
        TEST_CONFIG,
        {
          clientFactory: () => ({ kind: "fake-client" }),
          currentUserResolver: async () => {
            throw Object.assign(new Error(`Bad credentials for ${TEST_CONFIG.githubToken}`), {
              status: 401,
            });
          },
        },
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubAuthError);
    expect((thrownError as Error).message).toBe(
      "GitHub authentication failed: invalid token or insufficient github.com access",
    );
    expect((thrownError as Error).message).not.toContain(TEST_CONFIG.githubToken);
  });
});
