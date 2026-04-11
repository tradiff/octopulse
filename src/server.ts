import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { renderAppDocument } from "./app.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 3000;

export interface StartServerOptions {
  host?: string;
  port?: number;
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
  const server = createServer(handleRequest);

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

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");

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

function formatAddress(address: AddressInfo): string {
  return address.family === "IPv6" ? `[${address.address}]` : address.address;
}
