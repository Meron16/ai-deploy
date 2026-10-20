import { exec, spawn } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CommandResult, DeployLogger } from "../types";

const execAsync = promisify(exec);

let activeTerminal: vscode.Terminal | undefined;
let activeTerminalCwd: string | undefined;

function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const extraPaths: string[] = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;

  if (appData) {
    extraPaths.push(path.join(appData, "npm"));
  }
  if (localAppData) {
    extraPaths.push(path.join(localAppData, "npm"));
  }
  if (programFiles) {
    extraPaths.push(path.join(programFiles, "nodejs"));
  }

  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    extraPaths.push(path.join(home, ".fly", "bin"));
  }

  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? "";

  return {
    ...process.env,
    [pathKey]: [...extraPaths, currentPath].filter(Boolean).join(path.delimiter),
    NO_COLOR: "1",
    FORCE_COLOR: "0"
  };
}

export function getOrCreateDeployTerminal(cwd: string): vscode.Terminal {
  if (activeTerminal && activeTerminal.exitStatus === undefined && activeTerminalCwd === cwd) {
    return activeTerminal;
  }

  activeTerminalCwd = cwd;
  activeTerminal = vscode.window.createTerminal({
    name: "AI Deploy",
    cwd,
    shellPath: process.platform === "win32" ? "powershell.exe" : undefined,
    shellArgs: process.platform === "win32" ? ["-NoLogo"] : undefined
  });
  return activeTerminal;
}

export function disposeDeployTerminal(): void {
  activeTerminal = undefined;
  activeTerminalCwd = undefined;
}

export async function runCommand(
  cwd: string,
  command: string,
  logger: DeployLogger,
  options: { optional?: boolean; silent?: boolean; timeoutMs?: number } = {}
): Promise<CommandResult> {
  logger(`[AI Deploy] $ ${command}`);

  if (options.silent) {
    return execCommand(cwd, command, logger, options);
  }

  const terminal = getOrCreateDeployTerminal(cwd);
  terminal.show(true);

  const result = await runInTerminal(terminal, cwd, command, logger, options.timeoutMs ?? 10 * 60 * 1000);

  if (!result.success && options.optional && isBenignOptionalFailure(result.output)) {
    logger(`[AI Deploy] Optional step skipped: ${summarizeError(result.output)}`);
    return { success: true, output: result.output };
  }

  return result;
}

export async function runStreamingCommand(
  cwd: string,
  command: string,
  args: string[],
  logger: DeployLogger,
  timeoutMs = 15 * 60 * 1000
): Promise<CommandResult> {
  const fullCommand = buildCommandLine(command, args);
  return runCommand(cwd, fullCommand, logger, { timeoutMs });
}

async function runInTerminal(
  terminal: vscode.Terminal,
  cwd: string,
  commandLine: string,
  logger: DeployLogger,
  timeoutMs: number
): Promise<CommandResult> {
  const hasIntegration = await waitForShellIntegration(terminal, 8000);
  if (hasIntegration && terminal.shellIntegration) {
    logger("[AI Deploy] Running in terminal (shell integration)...");
    return runViaShellIntegration(terminal, commandLine, logger, timeoutMs);
  }

  logger("[AI Deploy] Running in terminal (subprocess mirror)...");
  return runViaSubprocessWithTerminalMirror(terminal, cwd, commandLine, logger, timeoutMs);
}

async function waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
  if (terminal.shellIntegration) {
    return true;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(Boolean(terminal.shellIntegration));
    }, timeoutMs);

    const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal && event.shellIntegration) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(true);
      }
    });
  });
}

async function runViaShellIntegration(
  terminal: vscode.Terminal,
  commandLine: string,
  logger: DeployLogger,
  timeoutMs: number
): Promise<CommandResult> {
  const integration = terminal.shellIntegration;
  if (!integration) {
    return { success: false, output: "Shell integration unavailable." };
  }

  const execution = integration.executeCommand(commandLine);
  let output = "";

  const readTask = (async () => {
    try {
      for await (const chunk of execution.read()) {
        const cleaned = stripAnsi(chunk);
        output += cleaned;
        appendChunkToLogger(logger, cleaned);
      }
    } catch {
      // Some shells stop the read stream early; exit event still fires.
    }
  })();

  const exitCode = await waitForExecutionEnd(execution, timeoutMs);
  await readTask;

  const success = exitCode === 0;
  if (!success && exitCode !== undefined) {
    logger(`[AI Deploy] Command exited with code ${exitCode}`);
  }

  return {
    success,
    output: output.trim() || (success ? "Command completed." : `Command failed (exit ${exitCode ?? "unknown"}).`)
  };
}

function waitForExecutionEnd(
  execution: vscode.TerminalShellExecution,
  timeoutMs: number
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, timeoutMs);

    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(event.exitCode);
      }
    });
  });
}

async function runViaSubprocessWithTerminalMirror(
  terminal: vscode.Terminal,
  cwd: string,
  commandLine: string,
  logger: DeployLogger,
  timeoutMs: number
): Promise<CommandResult> {
  printTerminalBanner(terminal, commandLine);

  return new Promise((resolve) => {
    const child = spawn(commandLine, {
      cwd,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      env: buildSubprocessEnv()
    });

    let output = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      output += text;
      appendChunkToLogger(logger, text);
      mirrorChunkToTerminal(terminal, text);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      output += text;
      appendChunkToLogger(logger, text);
      mirrorChunkToTerminal(terminal, text);
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        success: false,
        output: `${output}\nCommand timed out after ${Math.round(timeoutMs / 60000)} minutes.`
      });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ success: false, output: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const success = code === 0;
      if (process.platform === "win32") {
        terminal.sendText(
          success
            ? `Write-Host "[AI Deploy] Done (exit 0)" -ForegroundColor Green`
            : `Write-Host "[AI Deploy] Failed (exit ${code ?? 1})" -ForegroundColor Red`,
          true
        );
      }
      resolve({
        success,
        output: output.trim() || (success ? "Command completed." : `Command failed (exit ${code ?? 1}).`)
      });
    });
  });
}

function mirrorChunkToTerminal(terminal: vscode.Terminal, chunk: string): void {
  const lines = stripAnsi(chunk).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    if (process.platform === "win32") {
      terminal.sendText(`Write-Host "${escapePowerShell(line)}"`, true);
    } else {
      terminal.sendText(`echo "${line.replace(/"/g, '\\"')}"`, true);
    }
  }
}

function printTerminalBanner(terminal: vscode.Terminal, commandLine: string): void {
  if (process.platform === "win32") {
    terminal.sendText(`Write-Host ""`, true);
    terminal.sendText(`Write-Host "[AI Deploy] Running: ${escapePowerShell(commandLine)}" -ForegroundColor Cyan`, true);
    terminal.sendText(`Write-Host ""`, true);
    return;
  }

  terminal.sendText(`echo ""`, true);
  terminal.sendText(`echo "[AI Deploy] Running: ${commandLine}"`, true);
  terminal.sendText(`echo ""`, true);
}

function escapePowerShell(value: string): string {
  return value.replace(/"/g, '`"').slice(0, 400);
}

async function execCommand(
  cwd: string,
  command: string,
  logger: DeployLogger,
  options: { optional?: boolean; timeoutMs?: number } = {}
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      env: buildSubprocessEnv(),
      timeout: options.timeoutMs ?? 10 * 60 * 1000
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (output) {
      logger(output);
    }
    return { success: true, output };
  } catch (error) {
    const output = extractCommandErrorOutput(error);
    if (output) {
      logger(output);
    }
    return { success: false, output };
  }
}

function buildCommandLine(command: string, args: string[]): string {
  if (args.length === 0) {
    return command;
  }
  const quotedArgs = args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
  return [command, ...quotedArgs].join(" ");
}

function appendChunkToLogger(logger: DeployLogger, chunk: string): void {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length > 0) {
      logger(line);
    }
  }
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[\d;]*[A-Za-z]/g, "")
    .replace(/\u001b\[[\d;]*m/g, "")
    .replace(/\x1b\[[\d;]*[A-Za-z]/g, "");
}

function summarizeError(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 3).join(" | ") || "Unknown error";
}

function isBenignOptionalFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("no deployments found") ||
    normalized.includes("no deployment found") ||
    normalized.includes("no linked project") ||
    normalized.includes("not found in project")
  );
}

function extractCommandErrorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return error instanceof Error ? error.message : String(error);
  }

  const maybeStdout = Reflect.get(error, "stdout");
  const maybeStderr = Reflect.get(error, "stderr");
  const maybeMessage = Reflect.get(error, "message");

  return [maybeMessage, maybeStdout, maybeStderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export async function runOptionalDiagnostic(
  cwd: string,
  command: string,
  logger: DeployLogger
): Promise<string> {
  const result = await runCommand(cwd, command, logger, { optional: true, silent: true });
  return result.output;
}
