import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, resolveAppPaths } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("resolveAppPaths", () => {
  it("uses the planned default config and state paths", () => {
    const homeDir = "/tmp/octopulse-home";
    const paths = resolveAppPaths({ homeDir });

    expect(paths).toEqual({
      configPath: path.join(homeDir, ".config", "octopulse", "config.toml"),
      stateDirPath: path.join(homeDir, ".local", "state", "octopulse"),
      databasePath: path.join(homeDir, ".local", "state", "octopulse", "octopulse.db"),
      logsDirPath: path.join(homeDir, ".local", "state", "octopulse", "logs"),
    });
  });
});

describe("loadConfig", () => {
  it("loads the required GitHub token and default timings", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      ["[github]", 'token = "ghp_test_123"', ""].join("\n"),
    );

    const config = loadConfig({ homeDir });

    expect(config.githubToken).toBe("ghp_test_123");
    expect(config.openAiApiKey).toBeUndefined();
    expect(config.logging).toEqual({
      level: "info",
      retentionMs: 14 * 24 * 60 * 60_000,
    });
    expect(config.timings).toEqual({
      trackedPullRequestPollMs: 60_000,
      discoveryPollMs: 5 * 60_000,
      gracePeriodMs: 7 * 24 * 60 * 60_000,
    });
    expect(config.paths).toEqual(resolveAppPaths({ homeDir }));
  });

  it("applies optional OpenAI and timing overrides", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      [
        "[github]",
        'token = "ghp_override_123"',
        "",
        "[openai]",
        'api_key = "sk-test-456"',
        "",
        "[logging]",
        'level = "debug"',
        'retention = "30 days"',
        "",
        "[timings]",
        'tracked_poll_interval = "2 minutes"',
        'discovery_poll_interval = "10m"',
        'grace_period = "3 days"',
        "",
      ].join("\n"),
    );

    const config = loadConfig({ homeDir });

    expect(config.githubToken).toBe("ghp_override_123");
    expect(config.openAiApiKey).toBe("sk-test-456");
    expect(config.logging).toEqual({
      level: "debug",
      retentionMs: 30 * 24 * 60 * 60_000,
    });
    expect(config.timings).toEqual({
      trackedPullRequestPollMs: 2 * 60_000,
      discoveryPollMs: 10 * 60_000,
      gracePeriodMs: 3 * 24 * 60 * 60_000,
    });
  });

  it("rejects invalid config without echoing secret values", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      [
        "[github]",
        'token = "   "',
        "",
        "[openai]",
        'api_key = "sk-live-secret"',
        "",
      ].join("\n"),
    );

    let thrownError: unknown;

    try {
      loadConfig({ homeDir });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(ConfigError);
    expect((thrownError as Error).message).toContain("github.token must be a non-empty string");
    expect((thrownError as Error).message).not.toContain("sk-live-secret");
  });

});

function createTempHome(): string {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "octopulse-config-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeConfig(homeDir: string, content: string): void {
  const { configPath } = resolveAppPaths({ homeDir });
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, content);
}
