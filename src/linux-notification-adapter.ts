import { spawn } from "node:child_process";

export interface LinuxNotification {
  title: string;
  body: string;
  clickUrl?: string | null;
}

export interface LinuxNotificationDispatchResult {
  openedClickUrl: boolean;
}

export interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandRunnerResult>;

export interface LinuxNotificationAdapterOptions {
  runCommand?: CommandRunner;
}

export class LinuxNotificationAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinuxNotificationAdapterError";
  }
}

export class LinuxNotificationAdapter {
  private readonly runCommand: CommandRunner;

  constructor(options: LinuxNotificationAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? runCommand;
  }

  async dispatchNotification(
    notification: LinuxNotification,
  ): Promise<LinuxNotificationDispatchResult> {
    const notifySendArgs = ["--app-name=Octopulse"];

    if (notification.clickUrl) {
      notifySendArgs.push("--action=default=Open");
    }

    notifySendArgs.push("--", notification.title, notification.body);

    const notifySendResult = await this.runRequiredCommand("notify-send", notifySendArgs);

    if (!notification.clickUrl || notifySendResult.stdout.trim() !== "default") {
      return {
        openedClickUrl: false,
      };
    }

    await this.runRequiredCommand("xdg-open", [notification.clickUrl]);

    return {
      openedClickUrl: true,
    };
  }

  private async runRequiredCommand(
    command: string,
    args: readonly string[],
  ): Promise<CommandRunnerResult> {
    let result: CommandRunnerResult;

    try {
      result = await this.runCommand(command, args);
    } catch (error) {
      throw new LinuxNotificationAdapterError(
        `Failed to execute ${command}: ${getErrorMessage(error)}`,
      );
    }

    if (result.signal !== null) {
      throw new LinuxNotificationAdapterError(
        `Command ${command} exited due to signal ${result.signal}: ${formatCommandFailure(result)}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new LinuxNotificationAdapterError(
        `Command ${command} exited with code ${result.exitCode}: ${formatCommandFailure(result)}`,
      );
    }

    return result;
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<CommandRunnerResult> {
  return await new Promise<CommandRunnerResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code, signal) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        signal,
      });
    });
  });
}

function formatCommandFailure(result: CommandRunnerResult): string {
  const stderr = result.stderr.trim();

  if (stderr.length > 0) {
    return stderr;
  }

  return "no error output";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
