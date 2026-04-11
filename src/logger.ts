import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogLevelFilter = "all" | LogLevel;

export interface LogContext {
  [key: string]: unknown;
}

export interface StoredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
}

export interface RecentLogEntry extends StoredLogEntry {
  id: string;
}

export interface AppLogger {
  log(level: LogLevel, message: string, context?: unknown): void;
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export interface ConfigureAppLoggerOptions {
  logsDirPath: string;
  minimumLevel: LogLevel;
  retentionMs: number;
  mirrorToConsole?: boolean;
}

export interface ReadRecentLogEntriesOptions {
  logsDirPath: string;
  limit?: number;
  level?: LogLevel;
}

export const DEFAULT_LOG_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_LOG_VIEWER_ENTRY_LIMIT = 200;

const DEFAULT_GLOBAL_LOG_LEVEL: LogLevel = "info";
const LOG_FILE_PREFIX = "octopulse";
const LOG_FILE_EXTENSION = ".jsonl";
const LOG_FILE_PATTERN = /^octopulse-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let appLogger: AppLogger = createLogger({
  minimumLevel: DEFAULT_GLOBAL_LOG_LEVEL,
  mirrorToConsole: true,
});

export function configureAppLogger(options: ConfigureAppLoggerOptions): AppLogger {
  appLogger = createLogger({
    logsDirPath: options.logsDirPath,
    minimumLevel: options.minimumLevel,
    retentionMs: options.retentionMs,
    mirrorToConsole: options.mirrorToConsole ?? true,
  });

  return appLogger;
}

export function getLogger(): AppLogger {
  return appLogger;
}

export function resetAppLoggerForTesting(): void {
  appLogger = createLogger({
    minimumLevel: DEFAULT_GLOBAL_LOG_LEVEL,
    mirrorToConsole: false,
  });
}

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function pruneLogFiles(
  logsDirPath: string,
  retentionMs: number,
  now = new Date().toISOString(),
): number {
  if (!existsSync(logsDirPath)) {
    return 0;
  }

  const cutoffTimestamp = Date.parse(now) - retentionMs;
  let prunedCount = 0;

  for (const fileName of listLogFileNames(logsDirPath)) {
    const datePart = readDatePartFromLogFileName(fileName);

    if (!datePart) {
      continue;
    }

    if (Date.parse(`${datePart}T00:00:00.000Z`) < cutoffTimestamp) {
      rmSync(path.join(logsDirPath, fileName), { force: true });
      prunedCount += 1;
    }
  }

  return prunedCount;
}

export function readRecentLogEntries(options: ReadRecentLogEntriesOptions): RecentLogEntry[] {
  const limit = options.limit ?? DEFAULT_LOG_VIEWER_ENTRY_LIMIT;

  if (limit <= 0 || !existsSync(options.logsDirPath)) {
    return [];
  }

  const recentEntries: RecentLogEntry[] = [];

  for (const fileName of listLogFileNames(options.logsDirPath).sort((left, right) =>
    right.localeCompare(left),
  )) {
    const filePath = path.join(options.logsDirPath, fileName);
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();

      if (!line) {
        continue;
      }

      const parsedEntry = parseStoredLogEntry(line);

      if (!parsedEntry) {
        continue;
      }

      if (options.level && parsedEntry.level !== options.level) {
        continue;
      }

      recentEntries.push({
        id: `${fileName}:${index + 1}`,
        ...parsedEntry,
      });

      if (recentEntries.length >= limit) {
        return recentEntries;
      }
    }
  }

  return recentEntries;
}

function createLogger(options: {
  logsDirPath?: string;
  minimumLevel: LogLevel;
  retentionMs?: number;
  mirrorToConsole: boolean;
}): AppLogger {
  const minimumLevel = options.minimumLevel;
  const mirrorToConsole = options.mirrorToConsole;
  const logsDirPath = options.logsDirPath;
  const retentionMs = options.retentionMs ?? DEFAULT_LOG_RETENTION_MS;
  let lastPrunedDatePart: string | undefined;

  if (logsDirPath) {
    ensureLogDirectory(logsDirPath);
    pruneLogFiles(logsDirPath, retentionMs);
    lastPrunedDatePart = new Date().toISOString().slice(0, 10);
  }

  const log = (level: LogLevel, message: string, context?: unknown): void => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minimumLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const entry = createStoredLogEntry(timestamp, level, message, context);

    if (logsDirPath) {
      const datePart = timestamp.slice(0, 10);

      try {
        ensureLogDirectory(logsDirPath);

        if (lastPrunedDatePart !== datePart) {
          pruneLogFiles(logsDirPath, retentionMs, timestamp);
          lastPrunedDatePart = datePart;
        }

        appendFileSync(
          path.join(logsDirPath, renderLogFileName(datePart)),
          `${serializeStoredLogEntry(entry)}\n`,
          "utf8",
        );
      } catch (error) {
        writeConsoleLine(
          "error",
          `${timestamp} ERROR Failed to write Octopulse log entry`,
          createLogContext({
            attemptedMessage: message,
            logFilePath: path.join(logsDirPath, renderLogFileName(datePart)),
            error,
          }),
        );
      }
    }

    if (mirrorToConsole) {
      writeConsoleLine(level, formatConsoleMessage(entry), entry.context);
    }
  };

  return {
    log,
    debug(message: string, context?: unknown): void {
      log("debug", message, context);
    },
    info(message: string, context?: unknown): void {
      log("info", message, context);
    },
    warn(message: string, context?: unknown): void {
      log("warn", message, context);
    },
    error(message: string, context?: unknown): void {
      log("error", message, context);
    },
  };
}

function ensureLogDirectory(logsDirPath: string): void {
  mkdirSync(logsDirPath, { recursive: true });
}

function listLogFileNames(logsDirPath: string): string[] {
  return readdirSync(logsDirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

function readDatePartFromLogFileName(fileName: string): string | undefined {
  const match = fileName.match(LOG_FILE_PATTERN);
  return match?.[1];
}

function renderLogFileName(datePart: string): string {
  return `${LOG_FILE_PREFIX}-${datePart}${LOG_FILE_EXTENSION}`;
}

function createStoredLogEntry(
  timestamp: string,
  level: LogLevel,
  message: string,
  context?: unknown,
): StoredLogEntry {
  const normalizedContext = createLogContext(context);

  return normalizedContext
    ? {
        timestamp,
        level,
        message,
        context: normalizedContext,
      }
    : {
        timestamp,
        level,
        message,
      };
}

function createLogContext(context: unknown): LogContext | undefined {
  if (!isRecord(context) || Object.keys(context).length === 0) {
    return undefined;
  }

  return JSON.parse(serializeValue(context)) as LogContext;
}

function serializeStoredLogEntry(entry: StoredLogEntry): string {
  return serializeValue(entry);
}

function parseStoredLogEntry(line: string): StoredLogEntry | undefined {
  let value: unknown;

  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const timestamp = value.timestamp;
  const level = value.level;
  const message = value.message;
  const context = value.context;
  const normalizedLevel = typeof level === "string" && isLogLevel(level) ? level : undefined;

  if (typeof timestamp !== "string" || typeof message !== "string" || !normalizedLevel) {
    return undefined;
  }

  return isRecord(context)
    ? {
        timestamp,
        level: normalizedLevel,
        message,
        context,
      }
    : {
        timestamp,
        level: normalizedLevel,
        message,
      };
}

function serializeValue(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, candidate: unknown) => {
    if (candidate instanceof Error) {
      return {
        name: candidate.name,
        message: candidate.message,
        stack: candidate.stack,
      };
    }

    if (typeof candidate === "bigint") {
      return candidate.toString();
    }

    if (typeof candidate === "object" && candidate !== null) {
      if (seen.has(candidate)) {
        return "[Circular]";
      }

      seen.add(candidate);
    }

    return candidate;
  });
}

function formatConsoleMessage(entry: StoredLogEntry): string {
  return `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}`;
}

function writeConsoleLine(level: LogLevel, message: string, context?: LogContext): void {
  const renderedLine = context ? `${message} ${serializeValue(context)}` : message;

  switch (level) {
    case "debug":
      console.debug(renderedLine);
      return;
    case "info":
      console.log(renderedLine);
      return;
    case "warn":
      console.warn(renderedLine);
      return;
    case "error":
      console.error(renderedLine);
      return;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
