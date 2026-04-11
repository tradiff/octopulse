import type { Server } from "node:http";

import {
  runFirstRunAuthoredPullRequestDiscovery,
  startRecurringAuthoredPullRequestDiscovery,
  type RecurringAuthoredPullRequestDiscoveryHandle,
} from "./authored-pull-request-discovery.js";
import { loadConfig } from "./config.js";
import { initializeDatabase } from "./database.js";
import { initializeGitHubAuth } from "./github.js";
import { readServerOrigin, startServer } from "./server.js";

async function main(): Promise<void> {
  let database: ReturnType<typeof initializeDatabase> | undefined;
  let server: Server | undefined;
  let recurringDiscovery: RecurringAuthoredPullRequestDiscoveryHandle | undefined;

  try {
    const config = loadConfig();
    const githubAuth = await initializeGitHubAuth(config);
    database = initializeDatabase(config.paths);
    await runFirstRunAuthoredPullRequestDiscovery(database, githubAuth);
    server = await startServer();
    recurringDiscovery = startRecurringAuthoredPullRequestDiscovery(database, githubAuth, {
      intervalMs: config.timings.discoveryPollMs,
    });

    server.once("close", () => {
      recurringDiscovery?.stop();
      closeDatabaseQuietly(database);
    });

    console.log(
      `Octopulse listening at ${readServerOrigin(server)} for GitHub user ${githubAuth.currentUserLogin}`,
    );
  } catch (error) {
    recurringDiscovery?.stop();
    await closeServerQuietly(server);
    closeDatabaseQuietly(database);
    const message = error instanceof Error ? error.message : "Unknown startup error";
    console.error(`Octopulse failed to start: ${message}`);
    process.exitCode = 1;
  }
}

void main();

function closeDatabaseQuietly(database: ReturnType<typeof initializeDatabase> | undefined): void {
  if (!database?.isOpen) {
    return;
  }

  try {
    database.close();
  } catch {
    // Preserve the original startup failure.
  }
}

async function closeServerQuietly(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }

  try {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  } catch {
    // Preserve the original startup failure.
  }
}
