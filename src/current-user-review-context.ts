import { Octokit } from "octokit";

const GITHUB_API_HEADERS = {
  "X-GitHub-Api-Version": "2022-11-28",
};
const PAGE_SIZE = 100;

export interface CurrentUserReviewContext {
  teamKeys: string[];
}

export async function loadCurrentUserReviewContext(
  client: Octokit,
): Promise<CurrentUserReviewContext> {
  const teamKeys: string[] = [];

  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /user/teams", {
      per_page: PAGE_SIZE,
      page,
      headers: GITHUB_API_HEADERS,
    });
    const items = readArray(response.data, "user teams response");

    for (const item of items) {
      const team = requireRecord(item, "user teams response item");
      const organization = requireRecord(team.organization, "user teams response item.organization");
      teamKeys.push(
        `${normalizeText(readString(organization.login, "user teams response item.organization.login"))}/${normalizeText(readString(team.slug, "user teams response item.slug"))}`,
      );
    }

    if (items.length < PAGE_SIZE) {
      return {
        teamKeys,
      };
    }
  }
}

function readArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  return value;
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}
