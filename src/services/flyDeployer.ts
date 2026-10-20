import { access, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CommandResult, DeployLogger } from "../types";
import { runCommand } from "./commandRunner";
import { loadProjectEnvVars } from "./envLoader";

const execAsync = promisify(exec);

export async function deployWithFly(
  projectRoot: string,
  logger: DeployLogger,
  workspaceRoot?: string
): Promise<CommandResult> {
  try {
    const cli = await resolveFlyCli(projectRoot);
    logger(`[AI Deploy] Using Fly.io CLI: ${cli.label}`);

    await ensureFlyAuthenticated(projectRoot, cli, logger);
    const appName = await ensureFlyApp(projectRoot, cli, logger);

    logger("[AI Deploy] Syncing .env secrets to Fly.io...");
    await syncEnvToFly(projectRoot, cli, appName, logger, workspaceRoot);

    logger("[AI Deploy] Deploying backend to Fly.io (free)...");
    const deploy = await runCommand(
      projectRoot,
      `${cli.command} ${[...cli.baseArgs, "deploy", "--ha=false", "--app", appName].join(" ")}`,
      logger,
      { timeoutMs: 15 * 60 * 1000 }
    );

    if (!deploy.success) {
      return deploy;
    }

    const status = await runCommand(
      projectRoot,
      `${cli.command} ${[...cli.baseArgs, "status", "--app", appName].join(" ")}`,
      logger,
      { optional: true }
    );

    const url = `https://${appName}.fly.dev`;
    logger(`[AI Deploy] Fly.io URL: ${url}`);
    return {
      success: true,
      output: `${deploy.output}\n${status.output}\n${url}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: message };
  }
}

async function resolveFlyCli(
  projectRoot: string
): Promise<{ command: string; baseArgs: string[]; label: string }> {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const localFlyctl = home ? join(home, ".fly", "bin", process.platform === "win32" ? "flyctl.exe" : "flyctl") : "";
  const quotedLocal = localFlyctl.includes(" ") ? `"${localFlyctl}"` : localFlyctl;

  const candidates: Array<{ command: string; baseArgs: string[]; label: string; probe: string }> = [
    { command: "flyctl", baseArgs: [], label: "flyctl (PATH)", probe: "flyctl version" },
    ...(localFlyctl
      ? [{ command: quotedLocal, baseArgs: [], label: "flyctl (~/.fly/bin)", probe: `${quotedLocal} version` }]
      : []),
    { command: "fly", baseArgs: [], label: "fly (PATH)", probe: "fly version" }
  ];

  for (const candidate of candidates) {
    try {
      await execAsync(candidate.probe, { cwd: projectRoot });
      return { command: candidate.command, baseArgs: candidate.baseArgs, label: candidate.label };
    } catch {
      // try next
    }
  }

  return { command: "npx", baseArgs: ["-y", "flyctl"], label: "npx flyctl" };
}

async function ensureFlyAuthenticated(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  logger: DeployLogger
): Promise<void> {
  const whoami = await runCommand(
    projectRoot,
    `${cli.command} ${[...cli.baseArgs, "auth", "whoami"].join(" ")}`,
    logger,
    { optional: true }
  );
  if (whoami.success && !/error|not logged|unauthor/i.test(whoami.output)) {
    return;
  }

  logger("[AI Deploy] Fly.io login required (free account). Opening browser...");
  await runCommand(
    projectRoot,
    `${cli.command} ${[...cli.baseArgs, "auth", "login"].join(" ")}`,
    logger,
    { timeoutMs: 5 * 60 * 1000 }
  );

  const again = await runCommand(
    projectRoot,
    `${cli.command} ${[...cli.baseArgs, "auth", "whoami"].join(" ")}`,
    logger,
    { optional: true }
  );
  if (!again.success || /error|not logged|unauthor/i.test(again.output)) {
    throw new Error(
      "Fly.io is not authenticated. Create a free account at https://fly.io then run `fly auth login` and retry AI Deploy."
    );
  }
}

async function ensureFlyApp(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  logger: DeployLogger
): Promise<string> {
  const existing = await readFlyAppName(projectRoot);
  if (existing) {
    logger(`[AI Deploy] Using existing Fly app: ${existing}`);
    await ensureFlyToml(projectRoot, existing);
    return existing;
  }

  const appName = await deriveFlyAppName(projectRoot);
  await ensureFlyToml(projectRoot, appName);

  logger(`[AI Deploy] Creating Fly.io app: ${appName}`);
  const named = await runCommand(
    projectRoot,
    `${cli.command} ${[...cli.baseArgs, "apps", "create", appName].join(" ")}`,
    logger,
    { optional: true }
  );

  if (named.success || /already exists/i.test(named.output)) {
    await ensureFlyToml(projectRoot, appName);
    logger(`[AI Deploy] Fly app ready: ${appName}`);
    return appName;
  }

  const generated = await runCommand(
    projectRoot,
    `${cli.command} ${[...cli.baseArgs, "apps", "create", "--generate-name"].join(" ")}`,
    logger,
    { optional: true }
  );
  const parsed =
    generated.output.match(/New app created:\s*([a-z0-9-]+)/i)?.[1] ??
    generated.output.match(/app[:\s]+([a-z0-9-]+)/i)?.[1] ??
    appName;
  await ensureFlyToml(projectRoot, parsed);
  logger(`[AI Deploy] Fly app ready: ${parsed}`);
  return parsed;
}

async function readFlyAppName(projectRoot: string): Promise<string | undefined> {
  try {
    const toml = await readFile(join(projectRoot, "fly.toml"), "utf8");
    const match = toml.match(/^\s*app\s*=\s*["']?([a-z0-9-]+)["']?/im);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function ensureFlyToml(projectRoot: string, appName: string): Promise<void> {
  const path = join(projectRoot, "fly.toml");
  try {
    await access(path);
    const current = await readFile(path, "utf8");
    if (!/^\s*app\s*=/m.test(current)) {
      await writeFile(path, `app = "${appName}"\n${current}`, "utf8");
    }
    return;
  } catch {
    const content = [
      `app = "${appName}"`,
      'primary_region = "iad"',
      "",
      "[build]",
      "",
      "[env]",
      '  PORT = "3000"',
      "",
      "[http_service]",
      "  internal_port = 3000",
      "  force_https = true",
      "  auto_stop_machines = true",
      "  auto_start_machines = true",
      "  min_machines_running = 0",
      '  processes = ["app"]',
      "",
      "[[vm]]",
      '  memory = "512mb"',
      '  cpu_kind = "shared"',
      "  cpus = 1",
      ""
    ].join("\n");
    await writeFile(path, content, "utf8");
  }
}

async function deriveFlyAppName(projectRoot: string): Promise<string> {
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string };
    const base = sanitize(pkg.name ?? basename(projectRoot));
    return `${base}-${Math.floor(Math.random() * 900 + 100)}`.slice(0, 30);
  } catch {
    return `ai-deploy-${Math.floor(Math.random() * 900 + 100)}`;
  }
}

function sanitize(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/@[^/]+\//g, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20) || "ai-deploy"
  );
}

async function syncEnvToFly(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  appName: string,
  logger: DeployLogger,
  workspaceRoot?: string
): Promise<void> {
  const { vars } = await loadProjectEnvVars(projectRoot, workspaceRoot);
  const entries = Object.entries(vars).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) {
    logger("[AI Deploy] No .env vars to set on Fly.io");
    return;
  }

  for (const [key, value] of entries) {
    const quoted = value.includes(" ") || value.includes("&") ? `"${value.replace(/"/g, '\\"')}"` : value;
    await runCommand(
      projectRoot,
      `${cli.command} ${[...cli.baseArgs, "secrets", "set", `${key}=${quoted}`, "--app", appName, "--stage"].join(" ")}`,
      logger,
      { optional: true }
    );
  }

  logger(`[AI Deploy] Staged ${entries.length} Fly secrets from .env`);
}
