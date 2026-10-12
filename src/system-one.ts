export const DEFAULT_SYSTEM_ONE_MODEL = "jev-latest";

export interface SystemOneProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function normalizeSystemOneBaseUrl(baseUrl: string): string {
  let url: URL;

  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("System One base URL must be an absolute HTTP or HTTPS URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("System One base URL must use HTTP or HTTPS without credentials, query, or fragment");
  }

  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.href.replace(/\/+$/, "");
}
