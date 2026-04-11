import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { readServerOrigin, startServer } from "../src/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("startServer", () => {
  it("binds to localhost and serves the health endpoint", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const address = server.address();

    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");

    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listening address");
    }

    expect(address.address).toBe("127.0.0.1");

    const response = await fetch(`${readServerOrigin(server)}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the React shell from the root path", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(readServerOrigin(server));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Octopulse");
    expect(html).toContain("Raw Events");
  });
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
