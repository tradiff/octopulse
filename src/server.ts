import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { renderAppDocument, type AppFlashMessage } from "./app.js";
import {
  ManualPullRequestTrackingError,
  type TrackPullRequestByUrlResult,
  type UntrackPullRequestResult,
} from "./manual-pull-request-tracking.js";
import type { PullRequestRecord } from "./pull-request-repository.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 3000;

type SyncOrPromise<T> = T | Promise<T>;

export interface StartServerOptions {
  host?: string;
  port?: number;
  listTrackedPullRequests?: () => SyncOrPromise<PullRequestRecord[]>;
  listInactivePullRequests?: () => SyncOrPromise<PullRequestRecord[]>;
  manualTrackPullRequestByUrl?: (pullRequestUrl: string) => Promise<TrackPullRequestByUrlResult>;
  manualUntrackPullRequest?: (
    githubPullRequestId: number,
  ) => Promise<UntrackPullRequestResult>;
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
  const trackedPullRequestMatch = pathname.match(/^\/api\/tracked-pull-requests\/(\d+)$/);
  const documentUntrackMatch = pathname.match(/^\/tracked-pull-requests\/(\d+)\/untrack$/);

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

  if (request.method === "POST" && pathname === "/tracked-pull-requests/manual-track") {
    await handleDocumentManualTrackPullRequestRequest(
      request,
      response,
      options.manualTrackPullRequestByUrl,
    );
    return;
  }

  if (request.method === "POST" && documentUntrackMatch) {
    await handleDocumentManualUntrackPullRequestRequest(
      request,
      response,
      options.manualUntrackPullRequest,
      documentUntrackMatch[1]!,
    );
    return;
  }

  if (request.method === "POST" && pathname === "/inactive-pull-requests/retrack") {
    await handleDocumentManualTrackPullRequestRequest(
      request,
      response,
      options.manualTrackPullRequestByUrl,
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

  if (supportsDocumentResponse(request) && pathname === "/") {
    const trackedPullRequests = options.listTrackedPullRequests
      ? await options.listTrackedPullRequests()
      : [];
    const inactivePullRequests = options.listInactivePullRequests
      ? await options.listInactivePullRequests()
      : [];
    const flashMessage = readFlashMessage(searchParams);

    respond(
      response,
      request.method,
      200,
      "text/html; charset=utf-8",
      renderAppDocument({
        trackedPullRequests,
        inactivePullRequests,
        ...(flashMessage ? { flashMessage } : {}),
      }),
    );
    return;
  }

  respond(response, request.method, 404, "text/plain; charset=utf-8", "Not Found");
}

async function handleDocumentManualTrackPullRequestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manualTrackPullRequestByUrl: StartServerOptions["manualTrackPullRequestByUrl"],
): Promise<void> {
  if (!manualTrackPullRequestByUrl) {
    redirectToDocumentMessage(request, response, {
      kind: "error",
      text: "Manual pull request tracking is not configured",
    });
    return;
  }

  try {
    const requestBody = readManualTrackRequestBody(await readFormRequestBody(request));
    const result = await manualTrackPullRequestByUrl(requestBody.url);

    redirectToDocumentMessage(request, response, createTrackFlashMessage(result));
  } catch (error) {
    redirectToDocumentMessage(request, response, {
      kind: "error",
      text: getErrorMessage(error),
    });
  }
}

async function handleDocumentManualUntrackPullRequestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manualUntrackPullRequest: StartServerOptions["manualUntrackPullRequest"],
  githubPullRequestIdSegment: string,
): Promise<void> {
  if (!manualUntrackPullRequest) {
    redirectToDocumentMessage(request, response, {
      kind: "error",
      text: "Manual pull request untracking is not configured",
    });
    return;
  }

  try {
    const githubPullRequestId = readPositiveInteger(
      githubPullRequestIdSegment,
      "Pull request id",
    );
    const result = await manualUntrackPullRequest(githubPullRequestId);

    redirectToDocumentMessage(request, response, createUntrackFlashMessage(result));
  } catch (error) {
    redirectToDocumentMessage(request, response, {
      kind: "error",
      text: getErrorMessage(error),
    });
  }
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

    respond(
      response,
      request.method,
      result.outcome === "tracked" ? 201 : 200,
      "application/json; charset=utf-8",
      JSON.stringify(result),
    );
  } catch (error) {
    if (error instanceof ServerError || error instanceof ManualPullRequestTrackingError) {
      respond(
        response,
        request.method,
        400,
        "application/json; charset=utf-8",
        JSON.stringify({ error: error.message }),
      );
      return;
    }

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

    respond(
      response,
      request.method,
      200,
      "application/json; charset=utf-8",
      JSON.stringify(result),
    );
  } catch (error) {
    if (error instanceof ServerError || error instanceof ManualPullRequestTrackingError) {
      respond(
        response,
        request.method,
        400,
        "application/json; charset=utf-8",
        JSON.stringify({ error: error.message }),
      );
      return;
    }

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

async function readFormRequestBody(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request);
  return Object.fromEntries(new URLSearchParams(body).entries()) as unknown;
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

function readFlashMessage(searchParams: URLSearchParams): AppFlashMessage | undefined {
  const kind = searchParams.get("flash-kind");
  const text = searchParams.get("flash-text");

  if ((kind !== "success" && kind !== "error") || !text) {
    return undefined;
  }

  return { kind, text };
}

function redirectToDocumentMessage(
  request: IncomingMessage,
  response: ServerResponse,
  flashMessage: AppFlashMessage,
): void {
  const location = new URL("/", "http://127.0.0.1");
  location.searchParams.set("flash-kind", flashMessage.kind);
  location.searchParams.set("flash-text", flashMessage.text);

  response.statusCode = 303;
  response.setHeader("Location", `${location.pathname}${location.search}`);
  response.end(request.method === "HEAD" ? undefined : "");
}

function createTrackFlashMessage(result: TrackPullRequestByUrlResult): AppFlashMessage {
  const pullRequestLabel = formatPullRequestLabel(result.pullRequest);

  return {
    kind: "success",
    text:
      result.outcome === "tracked"
        ? `Now tracking ${pullRequestLabel}.`
        : `${pullRequestLabel} is already tracked.`,
  };
}

function createUntrackFlashMessage(result: UntrackPullRequestResult): AppFlashMessage {
  const pullRequestLabel = formatPullRequestLabel(result.pullRequest);

  return {
    kind: "success",
    text:
      result.outcome === "untracked"
        ? `Stopped tracking ${pullRequestLabel}.`
        : `${pullRequestLabel} is already inactive.`,
  };
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
