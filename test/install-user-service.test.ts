import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installUserService,
  renderInstallUserServiceSummary,
} from "../src/install-user-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("installUserService", () => {
  it("installs user service file and example config", () => {
    const tempRoot = createTempDir("octopulse-install-");
    const homeDir = path.join(tempRoot, "home");
    const repoRoot = path.join(tempRoot, "repo");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });

    const result = installUserService({ homeDir, repoRoot });

    expect(existsSync(result.paths.servicePath)).toBe(true);
    expect(readFileSync(result.paths.servicePath, "utf8")).toContain(`WorkingDirectory=${repoRoot}`);
    expect(readFileSync(result.paths.servicePath, "utf8")).toContain(
      `ExecStart=/usr/bin/node ${path.join(repoRoot, "dist", "main.js")}`,
    );
    expect(existsSync(result.paths.desktopEntryPath)).toBe(true);
    expect(readFileSync(result.paths.desktopEntryPath, "utf8")).toContain("Name=Octopulse");
    expect(readFileSync(result.paths.desktopEntryPath, "utf8")).toContain("Icon=");
    expect(readFileSync(result.paths.desktopEntryPath, "utf8")).toContain("X-GNOME-UsesNotifications=true");
    expect(existsSync(result.paths.configPath)).toBe(true);
    expect(readFileSync(result.paths.configPath, "utf8")).toContain('[github]');
    expect(readFileSync(result.paths.configPath, "utf8")).toContain('token = "ghp_replace_with_your_token"');
    expect(result.createdConfig).toBe(true);
  });

  it("keeps existing config and prints service management steps", () => {
    const tempRoot = createTempDir("octopulse-install-");
    const homeDir = path.join(tempRoot, "home");
    const repoRoot = path.join(tempRoot, "repo");
    const configPath = path.join(homeDir, ".config", "octopulse", "config.toml");

    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(configPath, ['[github]', 'token = "ghp_existing"', ''].join("\n"), "utf8");

    const result = installUserService({ homeDir, repoRoot });
    const summary = renderInstallUserServiceSummary(result);

    expect(readFileSync(configPath, "utf8")).toBe('[github]\ntoken = "ghp_existing"\n');
    expect(result.createdConfig).toBe(false);
    expect(summary).toContain(`Installed desktop entry at ${result.paths.desktopEntryPath}`);
    expect(summary).toContain(`Kept existing config at ${configPath}`);
    expect(summary).toContain(`Octopulse database path: ${path.join(homeDir, ".local", "state", "octopulse", "octopulse.db")}`);
    expect(summary).toContain("npm run build");
    expect(summary).toContain("systemctl --user daemon-reload");
    expect(summary).toContain("systemctl --user enable --now octopulse.service");
    expect(summary).toContain("journalctl --user -u octopulse.service -f");
  });
});

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
