import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import { DEFAULT_LOG_RETENTION_MS, isLogLevel, type LogLevel } from "./logger.js";

const DEFAULT_TRACKED_PULL_REQUEST_POLL_MS = 60_000;
const DEFAULT_DISCOVERY_POLL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_WINDOW_MS = 60_000;
const DEFAULT_GRACE_PERIOD_MS = 7 * 24 * 60 * 60_000;

type ConfigTable = Record<string, unknown>;

export interface ResolveAppPathsOptions {
  homeDir?: string;
  configPath?: string;
  stateDirPath?: string;
}

export interface LoadConfigOptions extends ResolveAppPathsOptions {}

export interface AppPaths {
  configPath: string;
  stateDirPath: string;
  databasePath: string;
  logsDirPath: string;
}

export interface AppConfig {
  paths: AppPaths;
  githubToken: string;
  openAiApiKey?: string;
  logging: {
    level: LogLevel;
    retentionMs: number;
  };
  timings: {
    trackedPullRequestPollMs: number;
    discoveryPollMs: number;
    debounceWindowMs: number;
    gracePeriodMs: number;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = path.resolve(
    options.configPath ?? path.join(homeDir, ".config", "octopulse", "config.toml"),
  );
  const stateDirPath = path.resolve(
    options.stateDirPath ?? path.join(homeDir, ".local", "state", "octopulse"),
  );

  return {
    configPath,
    stateDirPath,
    databasePath: path.join(stateDirPath, "octopulse.db"),
    logsDirPath: path.join(stateDirPath, "logs"),
  };
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const paths = resolveAppPaths(options);

  if (!existsSync(paths.configPath)) {
    throw new ConfigError(`Config file not found at ${paths.configPath}`);
  }

  let configText: string;

  try {
    configText = readFileSync(paths.configPath, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Failed to read config file at ${paths.configPath}: ${getErrorMessage(error)}`,
    );
  }

  let parsedConfig: unknown;

  try {
    parsedConfig = parse(configText);
  } catch (error) {
    throw new ConfigError(`Invalid TOML in ${paths.configPath}: ${getErrorMessage(error)}`);
  }

  return validateConfig(parsedConfig, paths);
}

function validateConfig(parsedConfig: unknown, paths: AppPaths): AppConfig {
  const root = requireTable(parsedConfig, "config");
  assertAllowedKeys(root, ["github", "openai", "timings", "logging"]);

  const github = requireNestedTable(root, "github");
  assertAllowedKeys(github, ["token"], "github");

  const openai = optionalNestedTable(root, "openai");
  if (openai) {
    assertAllowedKeys(openai, ["api_key"], "openai");
  }

  const timings = optionalNestedTable(root, "timings");
  if (timings) {
    assertAllowedKeys(
      timings,
      [
        "tracked_poll_interval",
        "discovery_poll_interval",
        "debounce_window",
        "grace_period",
      ],
      "timings",
    );
  }

  const logging = optionalNestedTable(root, "logging");
  if (logging) {
    assertAllowedKeys(logging, ["level", "retention"], "logging");
  }

  const openAiApiKey = openai
    ? optionalNonEmptyString(openai, "api_key", "openai.api_key")
    : undefined;

  return {
    paths,
    githubToken: requireNonEmptyString(github, "token", "github.token"),
    ...(openAiApiKey ? { openAiApiKey } : {}),
    logging: {
      level: optionalLogLevel(logging, "level", "logging.level", "info"),
      retentionMs: optionalDuration(
        logging,
        "retention",
        "logging.retention",
        DEFAULT_LOG_RETENTION_MS,
      ),
    },
    timings: {
      trackedPullRequestPollMs: optionalDuration(
        timings,
        "tracked_poll_interval",
        "timings.tracked_poll_interval",
        DEFAULT_TRACKED_PULL_REQUEST_POLL_MS,
      ),
      discoveryPollMs: optionalDuration(
        timings,
        "discovery_poll_interval",
        "timings.discovery_poll_interval",
        DEFAULT_DISCOVERY_POLL_MS,
      ),
      debounceWindowMs: optionalDuration(
        timings,
        "debounce_window",
        "timings.debounce_window",
        DEFAULT_DEBOUNCE_WINDOW_MS,
      ),
      gracePeriodMs: optionalDuration(
        timings,
        "grace_period",
        "timings.grace_period",
        DEFAULT_GRACE_PERIOD_MS,
      ),
    },
  };
}

function requireTable(value: unknown, fieldPath: string): ConfigTable {
  if (!isConfigTable(value)) {
    throw new ConfigError(`${fieldPath} must be a TOML table`);
  }

  return value;
}

function requireNestedTable(table: ConfigTable, key: string): ConfigTable {
  const value = table[key];

  if (value === undefined) {
    throw new ConfigError(`Missing required config section "${key}"`);
  }

  return requireTable(value, key);
}

function optionalNestedTable(table: ConfigTable, key: string): ConfigTable | undefined {
  const value = table[key];

  if (value === undefined) {
    return undefined;
  }

  return requireTable(value, key);
}

function assertAllowedKeys(table: ConfigTable, allowedKeys: string[], tablePath = ""): void {
  for (const key of Object.keys(table)) {
    if (!allowedKeys.includes(key)) {
      const fieldPath = tablePath ? `${tablePath}.${key}` : key;
      throw new ConfigError(`Unsupported config key "${fieldPath}"`);
    }
  }
}

function requireNonEmptyString(table: ConfigTable, key: string, fieldPath: string): string {
  const value = table[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${fieldPath} must be a non-empty string`);
  }

  return value;
}

function optionalNonEmptyString(
  table: ConfigTable,
  key: string,
  fieldPath: string,
): string | undefined {
  const value = table[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${fieldPath} must be a non-empty string when provided`);
  }

  return value;
}

function optionalDuration(
  table: ConfigTable | undefined,
  key: string,
  fieldPath: string,
  defaultValue: number,
): number {
  const value = table?.[key];

  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw new ConfigError(`${fieldPath} must be a duration string`);
  }

  return parseDuration(value, fieldPath);
}

function optionalLogLevel(
  table: ConfigTable | undefined,
  key: string,
  fieldPath: string,
  defaultValue: LogLevel,
): LogLevel {
  const value = table?.[key];

  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "string" || !isLogLevel(value)) {
    throw new ConfigError(`${fieldPath} must be one of debug, info, warn, or error`);
  }

  return value;
}

function parseDuration(value: string, fieldPath: string): number {
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/);

  if (!match) {
    throw new ConfigError(`${fieldPath} must use a supported duration like "1m" or "7 days"`);
  }

  const amountValue = match[1];
  const unitValue = match[2];

  if (amountValue === undefined || unitValue === undefined) {
    throw new ConfigError(`${fieldPath} must use a supported duration like "1m" or "7 days"`);
  }

  const amount = Number(amountValue);
  const unit = unitValue.toLowerCase();
  const multiplier = durationMultiplier(unit);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConfigError(`${fieldPath} must be greater than zero`);
  }

  return Math.round(amount * multiplier);
}

function durationMultiplier(unit: string): number {
  switch (unit) {
    case "ms":
    case "millisecond":
    case "milliseconds":
      return 1;
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return 1_000;
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return 60_000;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return 60 * 60_000;
    case "d":
    case "day":
    case "days":
      return 24 * 60 * 60_000;
    default:
      throw new ConfigError(`Unsupported duration unit "${unit}"`);
  }
}

function isConfigTable(value: unknown): value is ConfigTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
