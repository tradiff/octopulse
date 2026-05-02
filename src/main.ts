import type { Server } from "node:http";

import {
  runFirstRunAuthoredPullRequestDiscovery,
  startRecurringAuthoredPullRequestDiscovery,
  type RecurringAuthoredPullRequestDiscoveryHandle,
} from "./authored-pull-request-discovery.js";
import { createOpenAiBotActivityClassifier } from "./bot-activity-classification.js";
import { loadConfig, resolveAppPaths } from "./config.js";
import { initializeDatabase } from "./database.js";
import { initializeGitHubAuth } from "./github.js";
import { LinuxNotificationAdapter } from "./linux-notification-adapter.js";
import {
  configureAppLogger,
  DEFAULT_LOG_RETENTION_MS,
  getLogger,
  readRecentLogEntries,
} from "./logger.js";
import { trackPullRequestByUrl, untrackPullRequest } from "./manual-pull-request-tracking.js";
import { listNotificationHistory } from "./notification-history.js";
import { resendNotificationRecord } from "./notification-dispatch.js";
import { PullRequestRepository } from "./pull-request-repository.js";
import { listPullRequestTimeline, listRawEvents } from "./raw-events.js";
import { readServerOrigin, startServer } from "./server.js";
import {
  startRecurringTrackedPullRequestPolling,
  type RecurringTrackedPullRequestPollingHandle,
} from "./tracked-pull-request-polling.js";
import { startTrayIcon, type TrayIconHandle } from "./tray-icon.js";

async function main(): Promise<void> {
  let database: ReturnType<typeof initializeDatabase> | undefined;
  let server: Server | undefined;
  let recurringDiscovery: RecurringAuthoredPullRequestDiscoveryHandle | undefined;
  let recurringTrackedPullRequestPolling: RecurringTrackedPullRequestPollingHandle | undefined;
  let trayIcon: TrayIconHandle | undefined;
  let isShuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    getLogger().info("Octopulse shutdown initiated", { reason });
    recurringDiscovery?.stop();
    recurringDiscovery = undefined;
    recurringTrackedPullRequestPolling?.stop();
    recurringTrackedPullRequestPolling = undefined;
    await closeTrayIconQuietly(trayIcon);
    trayIcon = undefined;
    await closeServerQuietly(server);
    server = undefined;
    closeDatabaseQuietly(database);
    database = undefined;
  };

  bindProcessSignal("SIGINT", shutdown);
  bindProcessSignal("SIGTERM", shutdown);

  const defaultPaths = resolveAppPaths();
  configureAppLogger({
    logsDirPath: defaultPaths.logsDirPath,
    minimumLevel: "info",
    retentionMs: DEFAULT_LOG_RETENTION_MS,
  });
  getLogger().info("Octopulse startup initiated", {
    logsDirPath: defaultPaths.logsDirPath,
  });

  try {
    const config = loadConfig();
    configureAppLogger({
      logsDirPath: config.paths.logsDirPath,
      minimumLevel: config.logging.level,
      retentionMs: config.logging.retentionMs,
    });
    const logger = getLogger();
    logger.info("Octopulse configuration loaded", {
      configPath: config.paths.configPath,
      stateDirPath: config.paths.stateDirPath,
      databasePath: config.paths.databasePath,
      logsDirPath: config.paths.logsDirPath,
      logLevel: config.logging.level,
      logRetentionMs: config.logging.retentionMs,
    });
    const githubAuth = await initializeGitHubAuth(config);
    const botActivityClassifier = config.openAiApiKey
      ? createOpenAiBotActivityClassifier({ apiKey: config.openAiApiKey })
      : undefined;
    const notificationDispatcher = new LinuxNotificationAdapter();
    const currentDatabase = initializeDatabase(config.paths);
    const pullRequestRepository = new PullRequestRepository(currentDatabase);
    database = currentDatabase;
    const firstRunDiscoveryResult = await runFirstRunAuthoredPullRequestDiscovery(
      currentDatabase,
      githubAuth,
      {
        notificationDispatcher,
      },
    );
    logger.info("Pull request discovery completed", firstRunDiscoveryResult);
    server = await startServer({
      listTrackedPullRequests: async () => pullRequestRepository.listTrackedPullRequests(),
      listInactivePullRequests: async () => pullRequestRepository.listInactivePullRequests(),
      listPullRequestTimeline: async () => listPullRequestTimeline(currentDatabase),
      listNotificationHistory: async ({ filters, page, pageSize }) =>
        listNotificationHistory(currentDatabase, {
          ...(filters ? { filters } : {}),
          ...(page ? { page } : {}),
          ...(pageSize ? { pageSize } : {}),
        }),
      listRecentLogs: async ({ level, limit }) =>
        readRecentLogEntries({
          logsDirPath: config.paths.logsDirPath,
          ...(level ? { level } : {}),
          ...(limit ? { limit } : {}),
        }),
      listRawEvents: async ({ filters, page, pageSize }) =>
        listRawEvents(currentDatabase, {
          ...(filters ? { filters } : {}),
          ...(page ? { page } : {}),
          ...(pageSize ? { pageSize } : {}),
        }),
      manualTrackPullRequestByUrl: (pullRequestUrl: string) =>
        trackPullRequestByUrl(currentDatabase, githubAuth, pullRequestUrl, {
          pullRequestRepository,
        }),
      manualUntrackPullRequest: (githubPullRequestId: number) =>
        untrackPullRequest(currentDatabase, githubPullRequestId, {
          pullRequestRepository,
        }),
      resendNotificationRecord: (notificationRecordId: number) =>
        resendNotificationRecord(currentDatabase, {
          notificationRecordId,
          currentUserLogin: githubAuth.currentUserLogin,
          notificationDispatcher,
        }),
    });
    const serverOrigin = readServerOrigin(server);
    trayIcon = await startTrayIcon({
      serverOrigin,
      onQuitRequested: async () => {
        await shutdown("tray_quit");
        process.exit(0);
      },
    });
    recurringDiscovery = startRecurringAuthoredPullRequestDiscovery(currentDatabase, githubAuth, {
      intervalMs: config.timings.discoveryPollMs,
      notificationDispatcher,
    });
    logger.info("Started recurring pull request discovery", {
      intervalMs: config.timings.discoveryPollMs,
      notificationsEnabled: true,
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
    logger.info("Started recurring tracked pull request polling", {
      intervalMs: config.timings.trackedPullRequestPollMs,
      notificationsEnabled: true,
      botActivityClassificationEnabled: Boolean(botActivityClassifier),
    });

    server.once("close", () => {
      recurringDiscovery?.stop();
      recurringDiscovery = undefined;
      recurringTrackedPullRequestPolling?.stop();
      recurringTrackedPullRequestPolling = undefined;
      closeDatabaseQuietly(database);
      database = undefined;
    });

    logger.info("Octopulse listening", {
      origin: serverOrigin,
      githubUser: githubAuth.currentUserLogin,
      trayIconVisible: trayIcon.isVisible,
    });
  } catch (error) {
    recurringDiscovery?.stop();
    recurringTrackedPullRequestPolling?.stop();
    await closeTrayIconQuietly(trayIcon);
    await closeServerQuietly(server);
    closeDatabaseQuietly(database);
    const message = error instanceof Error ? error.message : "Unknown startup error";
    getLogger().error("Octopulse failed to start", {
      message,
      error,
    });
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

async function closeTrayIconQuietly(trayIcon: TrayIconHandle | undefined): Promise<void> {
  if (!trayIcon) {
    return;
  }

  try {
    await trayIcon.stop();
  } catch {
    // Preserve the original startup or shutdown failure.
  }
}

function bindProcessSignal(
  signal: NodeJS.Signals,
  shutdown: (reason: string) => Promise<void>,
): void {
  process.once(signal, () => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  });
}
