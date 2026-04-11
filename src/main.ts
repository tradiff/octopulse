import type { Server } from "node:http";

import {
  runFirstRunAuthoredPullRequestDiscovery,
  startRecurringAuthoredPullRequestDiscovery,
  type RecurringAuthoredPullRequestDiscoveryHandle,
} from "./authored-pull-request-discovery.js";
import { createOpenAiBotActivityClassifier } from "./bot-activity-classification.js";
import { loadConfig } from "./config.js";
import { initializeDatabase } from "./database.js";
import { initializeGitHubAuth } from "./github.js";
import { LinuxNotificationAdapter } from "./linux-notification-adapter.js";
import { trackPullRequestByUrl, untrackPullRequest } from "./manual-pull-request-tracking.js";
import { listNotificationHistory } from "./notification-history.js";
import { PullRequestRepository } from "./pull-request-repository.js";
import { listRawEvents } from "./raw-events.js";
import { readServerOrigin, startServer } from "./server.js";
import {
  startRecurringTrackedPullRequestPolling,
  type RecurringTrackedPullRequestPollingHandle,
} from "./tracked-pull-request-polling.js";

async function main(): Promise<void> {
  let database: ReturnType<typeof initializeDatabase> | undefined;
  let server: Server | undefined;
  let recurringDiscovery: RecurringAuthoredPullRequestDiscoveryHandle | undefined;
  let recurringTrackedPullRequestPolling: RecurringTrackedPullRequestPollingHandle | undefined;

  try {
    const config = loadConfig();
    const githubAuth = await initializeGitHubAuth(config);
    const botActivityClassifier = config.openAiApiKey
      ? createOpenAiBotActivityClassifier({ apiKey: config.openAiApiKey })
      : undefined;
    const notificationDispatcher = new LinuxNotificationAdapter();
    const currentDatabase = initializeDatabase(config.paths);
    const pullRequestRepository = new PullRequestRepository(currentDatabase);
    database = currentDatabase;
    await runFirstRunAuthoredPullRequestDiscovery(currentDatabase, githubAuth);
    server = await startServer({
      listTrackedPullRequests: async () => pullRequestRepository.listTrackedPullRequests(),
      listInactivePullRequests: async () => pullRequestRepository.listInactivePullRequests(),
      listNotificationHistory: async () => listNotificationHistory(currentDatabase),
      listRawEvents: async () => listRawEvents(currentDatabase),
      manualTrackPullRequestByUrl: (pullRequestUrl: string) =>
        trackPullRequestByUrl(currentDatabase, githubAuth, pullRequestUrl, {
          pullRequestRepository,
        }),
      manualUntrackPullRequest: (githubPullRequestId: number) =>
        untrackPullRequest(currentDatabase, githubPullRequestId, {
          pullRequestRepository,
        }),
    });
    recurringDiscovery = startRecurringAuthoredPullRequestDiscovery(currentDatabase, githubAuth, {
      intervalMs: config.timings.discoveryPollMs,
    });
    recurringTrackedPullRequestPolling = startRecurringTrackedPullRequestPolling(
      currentDatabase,
      githubAuth,
      {
        intervalMs: config.timings.trackedPullRequestPollMs,
        pullRequestRepository,
        notificationDispatcher,
        ...(botActivityClassifier ? { botActivityClassifier } : {}),
      },
    );

    server.once("close", () => {
      recurringDiscovery?.stop();
      recurringTrackedPullRequestPolling?.stop();
      closeDatabaseQuietly(database);
    });

    console.log(
      `Octopulse listening at ${readServerOrigin(server)} for GitHub user ${githubAuth.currentUserLogin}`,
    );
  } catch (error) {
    recurringDiscovery?.stop();
    recurringTrackedPullRequestPolling?.stop();
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
