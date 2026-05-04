import { DatabaseSync } from "node:sqlite";

import { Octokit } from "octokit";

const GITHUB_API_HEADERS = {
  "X-GitHub-Api-Version": "2022-11-28",
};
const REQUIRED_CHECKS_CACHE_TTL_MS = 60 * 60 * 1000;
const KEY_PREFIX = "required_status_checks";

export interface RequiredChecksResult {
  requiredCheckNames: Set<string>;
}

export class RequiredChecksCache {
  constructor(
    private readonly database: DatabaseSync,
    private readonly client: Octokit,
  ) {}

  async getRequiredChecks(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<RequiredChecksResult | null> {
    const key = `${KEY_PREFIX}:${owner}/${repo}:${branch}`;
    const cached = this.readCached(key);

    if (cached !== undefined) {
      return cached;
    }

    const result = await this.fetchFromGitHub(owner, repo, branch);
    this.writeCache(key, result);
    return result;
  }

  private readCached(key: string): RequiredChecksResult | null | undefined {
    const row = this.database
      .prepare("SELECT value, updated_at FROM AppState WHERE key = ?")
      .get(key);

    if (row === undefined) {
      return undefined;
    }

    const value = row as Record<string, unknown>;
    const updatedAt = typeof value.updated_at === "string" ? value.updated_at : null;

    if (updatedAt !== null) {
      const age = Date.now() - new Date(updatedAt).getTime();

      if (age > REQUIRED_CHECKS_CACHE_TTL_MS) {
        return undefined;
      }
    }

    const raw = typeof value.value === "string" ? value.value : null;

    if (raw === null) {
      return undefined;
    }

    if (raw === "null") {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (!Array.isArray(parsed)) {
        return undefined;
      }

      return { requiredCheckNames: new Set(parsed.filter((v): v is string => typeof v === "string")) };
    } catch {
      return undefined;
    }
  }

  private writeCache(key: string, result: RequiredChecksResult | null): void {
    const serialized = result === null ? "null" : JSON.stringify([...result.requiredCheckNames]);

    this.database
      .prepare(
        `
          INSERT INTO AppState (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(key, serialized);
  }

  private async fetchFromGitHub(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<RequiredChecksResult | null> {
    try {
      const response = await this.client.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
        { owner, repo, branch, headers: GITHUB_API_HEADERS },
      );
      const data = response.data as unknown;

      if (typeof data !== "object" || data === null) {
        return null;
      }

      const checks = (data as Record<string, unknown>).checks;

      if (!Array.isArray(checks)) {
        return null;
      }

      const names = new Set<string>();

      for (const check of checks) {
        if (typeof check === "object" && check !== null) {
          const c = check as Record<string, unknown>;
          const name = c.name ?? c.context;

          if (typeof name === "string") {
            names.add(name);
          }
        }
      }

      return { requiredCheckNames: names };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const status = (error as Record<string, unknown>).status;
  return status === 404;
}
