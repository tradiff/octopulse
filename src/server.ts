import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";

import {
  DEFAULT_LOG_VIEWER_ENTRY_LIMIT,
  getLogger,
  isLogLevel,
  type LogLevel,
  type LogLevelFilter,
  type RecentLogEntry,
} from "./logger.js";
import {
  ManualPullRequestTrackingError,
  type TrackPullRequestByUrlResult,
  type UntrackPullRequestResult,
} from "./manual-pull-request-tracking.js";
import type { NotificationHistoryEntry } from "./notification-history.js";
import type { PullRequestRecord } from "./pull-request-repository.js";
import type { RawEventsEntry } from "./raw-events.js";

const CLIENT_BUNDLE_PATH = new URL("../dist/public/app.js", import.meta.url);
const SPA_DOCUMENT = [
  "<!DOCTYPE html>",
  "<html lang=\"en\">",
  "<head>",
  "  <meta charset=\"utf-8\" />",
  "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "  <title>Octopulse</title>",
  "</head>",
  "<body>",
  "  <div id=\"root\"></div>",
  "  <script type=\"module\" src=\"/app.js\"></script>",
  "</body>",
  "</html>",
].join("\n");

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 3000;

type SyncOrPromise<T> = T | Promise<T>;
type AppPage = "pull-requests" | "logs" | "notification-history" | "raw-events";

export interface StartServerOptions {
  host?: string;
  port?: number;
  listTrackedPullRequests?: () => SyncOrPromise<PullRequestRecord[]>;
  listInactivePullRequests?: () => SyncOrPromise<PullRequestRecord[]>;
  listNotificationHistory?: () => SyncOrPromise<NotificationHistoryEntry[]>;
  listRecentLogs?: (options: {
    level?: LogLevel;
    limit?: number;
  }) => SyncOrPromise<RecentLogEntry[]>;
  listRawEvents?: () => SyncOrPromise<RawEventsEntry[]>;
  manualTrackPullRequestByUrl?: (pullRequestUrl: string) => Promise<TrackPullRequestByUrlResult>;
  manualUntrackPullRequest?: (
    githubPullRequestId: number,
  ) => Promise<UntrackPullRequestResult>;
  resendNotificationRecord?: (notificationRecordId: number) => Promise<void>;
}

export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

export function startServer(options: StartServerOptions = {}): Promise<Server> {
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error) => {
      getLogger().error("HTTP request failed", {
        method: request.method,
        path: request.url,
        error,
      });
      respond(
        response,
        request.method,
        500,
        "application/json; charset=utf-8",
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown server error",
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(new ServerError(`Failed to start server on ${host}:${port}: ${error.message}`));
    };

    const onListening = (): void => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

export function readServerOrigin(server: Server): string {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new ServerError("Server is not listening on a TCP address");
  }

  return `http://${formatAddress(address)}:${address.port}`;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartServerOptions,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const { pathname, searchParams } = requestUrl;
  const logLevelFilter = readLogLevelFilter(searchParams);
  const trackedPullRequestMatch = pathname.match(/^\/api\/tracked-pull-requests\/(\d+)$/);
  const notificationRecordResendMatch = pathname.match(/^\/api\/notification-records\/(\d+)\/resend$/);

  if (supportsDocumentResponse(request) && pathname === "/app.js") {
    handleClientBundleRequest(request, response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/tracked-pull-requests") {
    await handlePullRequestListRequest(
      request,
      response,
      options.listTrackedPullRequests,
      "Tracked pull request listing is not configured",
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/inactive-pull-requests") {
    await handlePullRequestListRequest(
      request,
      response,
      options.listInactivePullRequests,
      "Inactive pull request listing is not configured",
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/notification-history") {
    await handleNotificationHistoryRequest(request, response, options.listNotificationHistory);
    return;
  }

  if (request.method === "GET" && pathname === "/api/raw-events") {
    await handleRawEventsRequest(request, response, options.listRawEvents);
    return;
  }

  if (request.method === "GET" && pathname === "/api/logs") {
    await handleLogsRequest(request, response, options.listRecentLogs, logLevelFilter);
    return;
  }

  if (request.method === "POST" && pathname === "/api/tracked-pull-requests") {
    await handleManualTrackPullRequestRequest(
      request,
      response,
      options.manualTrackPullRequestByUrl,
    );
    return;
  }

  if (request.method === "DELETE" && trackedPullRequestMatch) {
    await handleManualUntrackPullRequestRequest(
      request,
      response,
      options.manualUntrackPullRequest,
      trackedPullRequestMatch[1]!,
    );
    return;
  }

  if (request.method === "POST" && notificationRecordResendMatch) {
    await handleNotificationRecordResendRequest(
      request,
      response,
      options.resendNotificationRecord,
      notificationRecordResendMatch[1]!,
    );
    return;
  }

  if (supportsDocumentResponse(request) && pathname === "/health") {
    respond(
      response,
      request.method,
      200,
      "application/json; charset=utf-8",
      JSON.stringify({ status: "ok" }),
    );
    return;
  }

  if (supportsDocumentResponse(request) && readDocumentPage(pathname)) {
    respond(response, request.method, 200, "text/html; charset=utf-8", SPA_DOCUMENT);
    return;
  }

  respond(response, request.method, 404, "text/plain; charset=utf-8", "Not Found");
}

function handleClientBundleRequest(request: IncomingMessage, response: ServerResponse): void {
  if (!existsSync(CLIENT_BUNDLE_PATH)) {
    respond(
      response,
      request.method,
      503,
      "text/plain; charset=utf-8",
      "Client bundle not found. Run npm run build:client.",
    );
    return;
  }

  const source = readFileSync(CLIENT_BUNDLE_PATH, "utf8");
  respond(response, request.method, 200, "application/javascript; charset=utf-8", source);
}

async function handleManualTrackPullRequestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manualTrackPullRequestByUrl: StartServerOptions["manualTrackPullRequestByUrl"],
): Promise<void> {
  if (!manualTrackPullRequestByUrl) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Manual pull request tracking is not configured" }),
    );
    return;
  }

  try {
    const requestBody = readManualTrackRequestBody(await readJsonRequestBody(request));
    const result = await manualTrackPullRequestByUrl(requestBody.url);

    getLogger().info("Handled manual pull request tracking API request", {
      pullRequest: formatPullRequestLabel(result.pullRequest),
      outcome: result.outcome,
    });

    respond(
      response,
      request.method,
      result.outcome === "tracked" ? 201 : 200,
      "application/json; charset=utf-8",
      JSON.stringify(result),
    );
  } catch (error) {
    if (error instanceof ServerError || error instanceof ManualPullRequestTrackingError) {
      getLogger().warn("Manual pull request tracking API request failed", {
        path: request.url,
        error,
      });
      respond(
        response,
        request.method,
        400,
        "application/json; charset=utf-8",
        JSON.stringify({ error: error.message }),
      );
      return;
    }

    getLogger().error("Manual pull request tracking API request failed unexpectedly", {
      path: request.url,
      error,
    });

    respond(
      response,
      request.method,
      500,
      "application/json; charset=utf-8",
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown server error",
      }),
    );
  }
}

async function handleManualUntrackPullRequestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manualUntrackPullRequest: StartServerOptions["manualUntrackPullRequest"],
  githubPullRequestIdSegment: string,
): Promise<void> {
  if (!manualUntrackPullRequest) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Manual pull request untracking is not configured" }),
    );
    return;
  }

  try {
    const githubPullRequestId = readPositiveInteger(
      githubPullRequestIdSegment,
      "Pull request id",
    );
    const result = await manualUntrackPullRequest(githubPullRequestId);

    getLogger().info("Handled manual pull request untracking API request", {
      pullRequest: formatPullRequestLabel(result.pullRequest),
      outcome: result.outcome,
    });

    respond(
      response,
      request.method,
      200,
      "application/json; charset=utf-8",
      JSON.stringify(result),
    );
  } catch (error) {
    if (error instanceof ServerError || error instanceof ManualPullRequestTrackingError) {
      getLogger().warn("Manual pull request untracking API request failed", {
        path: request.url,
        error,
      });
      respond(
        response,
        request.method,
        400,
        "application/json; charset=utf-8",
        JSON.stringify({ error: error.message }),
      );
      return;
    }

    getLogger().error("Manual pull request untracking API request failed unexpectedly", {
      path: request.url,
      error,
    });

    respond(
      response,
      request.method,
      500,
      "application/json; charset=utf-8",
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown server error",
      }),
    );
  }
}

async function handlePullRequestListRequest(
  request: IncomingMessage,
  response: ServerResponse,
  listPullRequests:
    | StartServerOptions["listTrackedPullRequests"]
    | StartServerOptions["listInactivePullRequests"],
  unavailableMessage: string,
): Promise<void> {
  if (!listPullRequests) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: unavailableMessage }),
    );
    return;
  }

  const pullRequests = await listPullRequests();

  respond(
    response,
    request.method,
    200,
    "application/json; charset=utf-8",
    JSON.stringify({ pullRequests }),
  );
}

async function handleNotificationHistoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  listNotificationHistory: StartServerOptions["listNotificationHistory"],
): Promise<void> {
  if (!listNotificationHistory) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Notification history listing is not configured" }),
    );
    return;
  }

  const notificationHistory = await listNotificationHistory();
  respond(
    response,
    request.method,
    200,
    "application/json; charset=utf-8",
    JSON.stringify({ notificationHistory }),
  );
}

async function handleRawEventsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  listRawEvents: StartServerOptions["listRawEvents"],
): Promise<void> {
  if (!listRawEvents) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Raw event listing is not configured" }),
    );
    return;
  }

  const rawEvents = await listRawEvents();
  respond(
    response,
    request.method,
    200,
    "application/json; charset=utf-8",
    JSON.stringify({ rawEvents }),
  );
}

async function handleLogsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  listRecentLogs: StartServerOptions["listRecentLogs"],
  logLevelFilter: LogLevelFilter,
): Promise<void> {
  if (!listRecentLogs) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Log listing is not configured" }),
    );
    return;
  }

  const recentLogs = await listRecentLogs({
    ...(logLevelFilter !== "all" ? { level: logLevelFilter } : {}),
    limit: DEFAULT_LOG_VIEWER_ENTRY_LIMIT,
  });
  respond(
    response,
    request.method,
    200,
    "application/json; charset=utf-8",
    JSON.stringify({ logs: recentLogs }),
  );
}

function supportsDocumentResponse(request: IncomingMessage): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function respond(
  response: ServerResponse,
  method: string | undefined,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.end(method === "HEAD" ? undefined : body);
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request);

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ServerError("Request body must be valid JSON");
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function readManualTrackRequestBody(body: unknown): { url: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServerError("Request body must be an object");
  }

  const value = body as { url?: unknown };
  const url = value.url;

  if (typeof url !== "string" || url.trim().length === 0) {
    throw new ServerError("Request body.url must be a non-empty string");
  }

  return { url: url.trim() };
}

function readDocumentPage(pathname: string): AppPage | undefined {
  if (pathname === "/") {
    return "pull-requests";
  }

  if (pathname === "/logs") {
    return "logs";
  }

  if (pathname === "/notification-history") {
    return "notification-history";
  }

  if (pathname === "/raw-events") {
    return "raw-events";
  }

  return undefined;
}

function readLogLevelFilter(searchParams: URLSearchParams): LogLevelFilter {
  const value = searchParams.get("level");

  if (value === null || value === "all") {
    return "all";
  }

  return isLogLevel(value) ? value : "all";
}

async function handleNotificationRecordResendRequest(
  request: IncomingMessage,
  response: ServerResponse,
  resendNotificationRecord: StartServerOptions["resendNotificationRecord"],
  notificationRecordIdSegment: string,
): Promise<void> {
  if (!resendNotificationRecord) {
    respond(
      response,
      request.method,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Notification record resend is not configured" }),
    );
    return;
  }

  try {
    const notificationRecordId = readPositiveInteger(notificationRecordIdSegment, "Notification record id");
    await resendNotificationRecord(notificationRecordId);

    getLogger().info("Resent notification record via API", {
      notificationRecordId,
    });

    respond(
      response,
      request.method,
      200,
      "application/json; charset=utf-8",
      JSON.stringify({ success: true }),
    );
  } catch (error) {
    getLogger().warn("Failed to resend notification record via API", {
      notificationRecordId: notificationRecordIdSegment,
      error,
    });

    respond(
      response,
      request.method,
      500,
      "application/json; charset=utf-8",
      JSON.stringify({
        error: getErrorMessage(error),
      }),
    );
  }
}

function readPositiveInteger(value: string, fieldName: string): number {
  const numericValue = Number(value);

  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
    throw new ServerError(`${fieldName} must be a positive integer`);
  }

  return numericValue;
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestRecord, "repositoryOwner" | "repositoryName" | "number">,
): string {
  return `${pullRequest.repositoryOwner}/${pullRequest.repositoryName} #${pullRequest.number}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatAddress(address: AddressInfo): string {
  return address.family === "IPv6" ? `[${address.address}]` : address.address;
}
