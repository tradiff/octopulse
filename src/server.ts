import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { renderAppDocument } from "./app.js";
import {
  ManualPullRequestTrackingError,
  type TrackPullRequestByUrlResult,
} from "./manual-pull-request-tracking.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 3000;

export interface StartServerOptions {
  host?: string;
  port?: number;
  manualTrackPullRequestByUrl?: (pullRequestUrl: string) => Promise<TrackPullRequestByUrlResult>;
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
    void handleRequest(request, response, options.manualTrackPullRequestByUrl).catch((error) => {
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
  manualTrackPullRequestByUrl: StartServerOptions["manualTrackPullRequestByUrl"],
): Promise<void> {
  const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "POST" && pathname === "/api/tracked-pull-requests") {
    await handleManualTrackPullRequestRequest(request, response, manualTrackPullRequestByUrl);
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
    respond(response, request.method, 200, "text/html; charset=utf-8", renderAppDocument());
    return;
  }

  respond(response, request.method, 404, "text/plain; charset=utf-8", "Not Found");
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

function formatAddress(address: AddressInfo): string {
  return address.family === "IPv6" ? `[${address.address}]` : address.address;
}
