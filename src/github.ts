import { Octokit } from "octokit";

import type { AppConfig } from "./config.js";

export interface GitHubAuthContext<TClient = Octokit> {
  client: TClient;
  currentUserLogin: string;
}

export interface InitializeGitHubAuthOptions<TClient = Octokit> {
  clientFactory?: (token: string) => TClient;
  currentUserResolver?: (client: TClient) => Promise<{ login: unknown }>;
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

export async function initializeGitHubAuth<TClient = Octokit>(
  config: Pick<AppConfig, "githubToken">,
  options: InitializeGitHubAuthOptions<TClient> = {},
): Promise<GitHubAuthContext<TClient>> {
  const clientFactory =
    options.clientFactory ?? ((token: string) => createGitHubClient(token) as TClient);
  const currentUserResolver =
    options.currentUserResolver ?? ((client: TClient) => resolveCurrentUser(client as Octokit));
  const client = clientFactory(config.githubToken);

  try {
    const currentUser = await currentUserResolver(client);

    return {
      client,
      currentUserLogin: readCurrentUserLogin(currentUser),
    };
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      throw error;
    }

    throw createGitHubAuthError(error, config.githubToken);
  }
}

async function resolveCurrentUser(client: Octokit): Promise<{ login: unknown }> {
  const response = await client.request("GET /user", {
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  return {
    login: response.data.login,
  };
}

function readCurrentUserLogin(currentUser: { login: unknown }): string {
  if (typeof currentUser.login !== "string" || currentUser.login.trim().length === 0) {
    throw new GitHubAuthError(
      "GitHub authentication failed: GitHub did not return a valid user login",
    );
  }

  return currentUser.login;
}

function createGitHubAuthError(error: unknown, token: string): GitHubAuthError {
  const statusCode = readStatusCode(error);

  if (statusCode === 401) {
    return new GitHubAuthError(
      "GitHub authentication failed: invalid token or insufficient github.com access",
    );
  }

  if (statusCode === 403) {
    return new GitHubAuthError(
      "GitHub authentication failed: GitHub denied access for the configured token",
    );
  }

  return new GitHubAuthError(
    `GitHub authentication failed: ${sanitizeErrorMessage(error, token)}`,
  );
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function sanitizeErrorMessage(error: unknown, token: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) {
    return "unknown authentication error";
  }

  return error.message.replaceAll(token, "[REDACTED]");
}
