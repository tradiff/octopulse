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
    expect(config.systemOne).toBeUndefined();
    expect(config.logging).toEqual({
      level: "info",
      retentionMs: 14 * 24 * 60 * 60_000,
    });
    expect(config.history).toEqual({
      rawPayloadRetentionMs: 30 * 24 * 60 * 60_000,
    });
    expect(config.timings).toEqual({
      trackedPullRequestPollMs: 60_000,
      discoveryPollMs: 5 * 60_000,
      gracePeriodMs: 7 * 24 * 60 * 60_000,
    });
    expect(config.paths).toEqual(resolveAppPaths({ homeDir }));
  });

  it("applies optional System One and timing overrides", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      [
        "[github]",
        'token = "ghp_override_123"',
        "",
        "[system_one]",
        'base_url = "https://openrouter.ai/api/v1"',
        'api_key = "sk-test-456"',
        "",
        "[logging]",
        'level = "debug"',
        'retention = "30 days"',
        "",
        "[history]",
        'raw_payload_retention = "45 days"',
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
    expect(config.systemOne).toEqual({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test-456", model: "jev-latest",
    });
    expect(config.logging).toEqual({
      level: "debug",
      retentionMs: 30 * 24 * 60 * 60_000,
    });
    expect(config.history).toEqual({
      rawPayloadRetentionMs: 45 * 24 * 60 * 60_000,
    });
    expect(config.timings).toEqual({
      trackedPullRequestPollMs: 2 * 60_000,
      discoveryPollMs: 10 * 60_000,
      gracePeriodMs: 3 * 24 * 60 * 60_000,
    });
  });

  it("accepts an optional GitHub login override", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      ["[github]", 'token = "ghp_override_123"', 'login = "octocat"', ""].join("\n"),
    );

    const config = loadConfig({ homeDir });

    expect(config.githubToken).toBe("ghp_override_123");
    expect(config.githubLogin).toBe("octocat");
  });

  it("rejects invalid config without echoing secret values", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      [
        "[github]",
        'token = "   "',
        "",
        "[system_one]",
        'base_url = "https://openrouter.ai/api/v1"',
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

  it("rejects an empty GitHub login override", () => {
    const homeDir = createTempHome();

    writeConfig(
      homeDir,
      ["[github]", 'token = "ghp_test_123"', 'login = "   "', ""].join("\n"),
    );

    expect(() => loadConfig({ homeDir })).toThrowError(
      new ConfigError("github.login must be a non-empty string when provided"),
    );
  });

  it("accepts other providers and a model override, trimming surrounding whitespace", () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, [
      "[github]", 'token = "github-test"', "[system_one]",
      'base_url = " https://api.typesafe.ai/v1/ "', 'api_key = " other-key "',
      'model = " jev-1.13.0 "',
    ].join("\n"));
    expect(loadConfig({ homeDir }).systemOne).toEqual({
      baseUrl: "https://api.typesafe.ai/v1/", apiKey: "other-key", model: "jev-1.13.0",
    });
  });

  it.each([
    ['api_key = "key"', "system_one.base_url"],
    ['base_url = "https://provider.example/v1"', "system_one.api_key"],
    ['base_url = " "\napi_key = "key"', "system_one.base_url"],
    ['base_url = "https://provider.example"\napi_key = " "', "system_one.api_key"],
    ['base_url = "https://provider.example"\napi_key = "key"\nmodel = " "', "system_one.model"],
    ['base_url = "not a URL"\napi_key = "key"', "system_one.base_url"],
    ['base_url = "file:///tmp/provider"\napi_key = "key"', "system_one.base_url"],
    ['base_url = "https://user:secret@provider.example"\napi_key = "key"', "system_one.base_url"],
    ['base_url = "https://provider.example?api_key=secret"\napi_key = "key"', "system_one.base_url"],
    ['base_url = "https://provider.example#secret"\napi_key = "key"', "system_one.base_url"],
  ])("rejects invalid System One config without echoing secrets: %s", (section, field) => {
    const homeDir = createTempHome();
    writeConfig(homeDir, `[github]\ntoken = "github-test"\n[system_one]\n${section}`);
    let thrownError: unknown;
    try {
      loadConfig({ homeDir });
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeInstanceOf(ConfigError);
    expect((thrownError as Error).message).toContain(field);
    expect((thrownError as Error).message).not.toContain("secret");
  });

  it("reports how to migrate the removed OpenAI config", () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, '[github]\ntoken = "github-test"\n[openai]\napi_key = "secret"');
    expect(() => loadConfig({ homeDir })).toThrow("Replace [openai] with [system_one]");
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
