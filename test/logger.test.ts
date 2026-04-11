import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configureAppLogger,
  DEFAULT_LOG_RETENTION_MS,
  getLogger,
  pruneLogFiles,
  readRecentLogEntries,
  resetAppLoggerForTesting,
} from "../src/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  resetAppLoggerForTesting();

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("logger", () => {
  it("writes JSONL entries and respects the configured minimum level", () => {
    const logsDirPath = createTempDir("octopulse-logs-");

    configureAppLogger({
      logsDirPath,
      minimumLevel: "info",
      retentionMs: DEFAULT_LOG_RETENTION_MS,
      mirrorToConsole: false,
    });

    const logger = getLogger();
    logger.debug("skip debug line");
    logger.info("Octopulse started", { origin: "http://127.0.0.1:3000" });
    logger.error("Octopulse failed", { error: new Error("boom") });

    const logFiles = readdirSync(logsDirPath);
    const entries = readRecentLogEntries({ logsDirPath, limit: 10 });
    const errorEntry = entries[0]!;
    const infoEntry = entries[1]!;

    expect(logFiles).toHaveLength(1);
    expect(entries).toHaveLength(2);
    expect(errorEntry).toMatchObject({
      level: "error",
      message: "Octopulse failed",
    });
    expect(errorEntry.context?.error).toMatchObject({
      message: "boom",
      name: "Error",
    });
    expect(infoEntry).toMatchObject({
      level: "info",
      message: "Octopulse started",
      context: {
        origin: "http://127.0.0.1:3000",
      },
    });
  });

  it("reads recent log entries with an exact level filter across files", () => {
    const logsDirPath = createTempDir("octopulse-log-reader-");

    writeLogFile(logsDirPath, "2026-04-10", [
      {
        timestamp: "2026-04-10T10:00:00.000Z",
        level: "info",
        message: "Older info",
      },
      {
        timestamp: "2026-04-10T11:00:00.000Z",
        level: "warn",
        message: "Older warn",
      },
    ]);
    writeLogFile(logsDirPath, "2026-04-11", [
      {
        timestamp: "2026-04-11T09:00:00.000Z",
        level: "error",
        message: "Newest error",
      },
      {
        timestamp: "2026-04-11T10:00:00.000Z",
        level: "warn",
        message: "Newest warn",
      },
    ]);

    const warnEntries = readRecentLogEntries({
      logsDirPath,
      level: "warn",
      limit: 10,
    });

    expect(warnEntries.map((entry) => entry.message)).toEqual(["Newest warn", "Older warn"]);
  });

  it("prunes log files older than the configured retention window", () => {
    const logsDirPath = createTempDir("octopulse-log-prune-");

    writeLogFile(logsDirPath, "2026-04-01", [
      {
        timestamp: "2026-04-01T12:00:00.000Z",
        level: "info",
        message: "Old entry",
      },
    ]);
    writeLogFile(logsDirPath, "2026-04-10", [
      {
        timestamp: "2026-04-10T12:00:00.000Z",
        level: "info",
        message: "Kept entry",
      },
    ]);

    const prunedCount = pruneLogFiles(
      logsDirPath,
      14 * 24 * 60 * 60_000,
      "2026-04-20T12:00:00.000Z",
    );

    expect(prunedCount).toBe(1);
    expect(readdirSync(logsDirPath)).toEqual(["octopulse-2026-04-10.jsonl"]);
  });
});

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeLogFile(
  logsDirPath: string,
  datePart: string,
  entries: Array<{
    timestamp: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    context?: Record<string, unknown>;
  }>,
): void {
  writeFileSync(
    path.join(logsDirPath, `octopulse-${datePart}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}
