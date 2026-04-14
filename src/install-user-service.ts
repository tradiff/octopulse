import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAppPaths, type ResolveAppPathsOptions } from "./config.js";
import { DESKTOP_ENTRY_FILE_NAME, renderDesktopEntry } from "./desktop-entry.js";

const SERVICE_NAME = "octopulse.service";

export interface InstallUserServicePaths {
  repoRoot: string;
  servicePath: string;
  desktopEntryPath: string;
  configPath: string;
  stateDirPath: string;
  databasePath: string;
}

export interface InstallUserServiceResult {
  paths: InstallUserServicePaths;
  createdConfig: boolean;
}

export interface ResolveInstallUserServicePathsOptions extends ResolveAppPathsOptions {
  homeDir?: string;
  repoRoot?: string;
  servicePath?: string;
  desktopEntryPath?: string;
}

export function resolveInstallUserServicePaths(
  options: ResolveInstallUserServicePathsOptions = {},
): InstallUserServicePaths {
  const homeDir = options.homeDir ?? os.homedir();
  const appPaths = resolveAppPaths({
    homeDir,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.stateDirPath ? { stateDirPath: options.stateDirPath } : {}),
  });

  return {
    repoRoot: path.resolve(options.repoRoot ?? process.cwd()),
    servicePath: path.resolve(
      options.servicePath ?? path.join(homeDir, ".config", "systemd", "user", SERVICE_NAME),
    ),
    desktopEntryPath: path.resolve(
      options.desktopEntryPath ?? path.join(homeDir, ".local", "share", "applications", DESKTOP_ENTRY_FILE_NAME),
    ),
    configPath: appPaths.configPath,
    stateDirPath: appPaths.stateDirPath,
    databasePath: appPaths.databasePath,
  };
}

export function renderUserServiceUnit(repoRoot: string): string {
  return [
    "[Unit]",
    "Description=Octopulse local PR activity monitor",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoRoot}`,
    "ExecStart=/usr/bin/env mise exec -- npm run start",
    "Restart=on-failure",
    "RestartSec=5",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderExampleConfig(): string {
  return [
    "[github]",
    'token = "ghp_replace_with_your_token"',
    "",
    "# Optional file logging settings.",
    "#[logging]",
    '#level = "info"',
    '#retention = "14 days"',
    "",
    "# Optional. Use only if bot comment/review classification is enabled.",
    "#[openai]",
    '#api_key = "sk_replace_with_your_key"',
    "",
    "# Optional timing overrides.",
    "#[timings]",
    '#tracked_poll_interval = "1m"',
    '#discovery_poll_interval = "5m"',
    '#grace_period = "7 days"',
    "",
  ].join("\n");
}

export function renderInstallUserServiceSummary(
  result: InstallUserServiceResult,
  options: { serviceName?: string } = {},
): string {
  const serviceName = options.serviceName ?? SERVICE_NAME;

  return [
    `Installed ${serviceName} at ${result.paths.servicePath}`,
    `Installed desktop entry at ${result.paths.desktopEntryPath}`,
    result.createdConfig
      ? `Created example config at ${result.paths.configPath}`
      : `Kept existing config at ${result.paths.configPath}`,
    `Octopulse database path: ${result.paths.databasePath}`,
    "",
    "Next steps:",
    `1. Edit ${result.paths.configPath} and set [github].token.`,
    "2. Run: systemctl --user daemon-reload",
    `3. Run: systemctl --user enable --now ${serviceName}`,
    `4. Run: systemctl --user status ${serviceName}`,
    `5. Follow logs: journalctl --user -u ${serviceName} -f`,
  ].join("\n");
}

export function installUserService(
  options: ResolveInstallUserServicePathsOptions = {},
): InstallUserServiceResult {
  const paths = resolveInstallUserServicePaths(options);
  const serviceDirectoryPath = path.dirname(paths.servicePath);
  const desktopEntryDirectoryPath = path.dirname(paths.desktopEntryPath);
  const configDirectoryPath = path.dirname(paths.configPath);

  mkdirSync(serviceDirectoryPath, { recursive: true });
  writeFileSync(paths.servicePath, renderUserServiceUnit(paths.repoRoot), "utf8");

  mkdirSync(desktopEntryDirectoryPath, { recursive: true });
  writeFileSync(paths.desktopEntryPath, renderDesktopEntry(), "utf8");

  mkdirSync(configDirectoryPath, { recursive: true });

  let createdConfig = false;
  if (!existsSync(paths.configPath)) {
    writeFileSync(paths.configPath, renderExampleConfig(), "utf8");
    createdConfig = true;
  }

  return {
    paths,
    createdConfig,
  };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const result = installUserService();
  console.log(renderInstallUserServiceSummary(result));
}
