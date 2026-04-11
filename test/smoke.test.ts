import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { readServerOrigin, startServer } from "../src/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("SPA shell", () => {
  it("serves root shell with client mount and bundle", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const response = await fetch(readServerOrigin(server));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Octopulse</title>");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/app.js"');
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
