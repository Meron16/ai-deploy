import { spawn } from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { DeployLogger } from "../types";
import { formatEnvKeySummary, isSensitiveEnvKey, loadProjectEnvVars } from "./envLoader";

const execAsync = promisify(exec);

function subprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0"
  };
}

export async function syncDotenvForDeploy(
  deployRoot: string,
  target: "railway" | "vercel" | "fly" | "tunnel",
  logger: DeployLogger,
  workspaceRoot?: string
): Promise<void> {
  const { vars, sources } = await loadProjectEnvVars(deployRoot, workspaceRoot);

  if (sources.length === 0) {
    logger("[AI Deploy] No .env file found — skipping environment sync");
    return;
  }

  logger(`[AI Deploy] Loaded .env from: ${sources.join(", ")}`);
  logger(`[AI Deploy] Variables found: ${formatEnvKeySummary(vars)}`);

  if (Object.keys(vars).length === 0) {
    logger("[AI Deploy] .env files are empty — skipping environment sync");
    return;
  }

  if (target === "railway") {
    await syncEnvToRailway(deployRoot, vars, logger);
    return;
  }
  if (target === "fly" || target === "tunnel") {
    logger("[AI Deploy] Skipping remote env sync for this target (local .env / Fly secrets handled separately).");
    return;
  }
  await syncEnvToVercel(deployRoot, vars, logger);
}

async function syncEnvToRailway(
  projectRoot: string,
  vars: Record<string, string>,
  logger: DeployLogger
): Promise<void> {
  const cli = await resolveRailwayCli(projectRoot);
  let synced = 0;

  for (const [key, value] of Object.entries(vars)) {
    if (!value.trim()) {
      continue;
    }

    const label = isSensitiveEnvKey(key) ? `${key}=***` : `${key}=${value}`;
    logger(`[AI Deploy] Setting Railway variable: ${label}`);

    const ok = await setRailwayVariable(projectRoot, cli, key, value);
    if (ok) {
      synced += 1;
    } else {
      logger(`[AI Deploy] Warning: could not set Railway variable ${key}`);
    }
  }

  logger(`[AI Deploy] Synced ${synced}/${Object.keys(vars).length} variables to Railway`);
}

async function setRailwayVariable(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  key: string,
  value: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [...cli.baseArgs, "variable", "set", key, "--stdin", "--skip-deploys"];
    const child = spawn(cli.command, args, {
      cwd: projectRoot,
      shell: process.platform === "win32",
      env: subprocessEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));

    child.stdin.write(value);
    child.stdin.end();
  });
}

async function syncEnvToVercel(
  projectRoot: string,
  vars: Record<string, string>,
  logger: DeployLogger
): Promise<void> {
  const cli = await resolveVercelCli(projectRoot);
  let synced = 0;

  for (const [key, value] of Object.entries(vars)) {
    if (!value.trim()) {
      continue;
    }

    const label = isSensitiveEnvKey(key) ? `${key}=***` : `${key}=${value}`;
    logger(`[AI Deploy] Setting Vercel variable: ${label}`);

    for (const environment of ["production", "preview"] as const) {
      const ok = await setVercelVariable(projectRoot, cli, key, value, environment);
      if (ok) {
        synced += 1;
      }
    }
  }

  logger(`[AI Deploy] Synced Vercel variables (${synced} sets across production/preview)`);
}

async function setVercelVariable(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  key: string,
  value: string,
  environment: "production" | "preview"
): Promise<boolean> {
  const args = [
    ...cli.baseArgs,
    "env",
    "add",
    key,
    environment,
    "--value",
    value,
    "--yes",
    "--force",
    "--sensitive"
  ];

  try {
    await execAsync([cli.command, ...args].join(" "), {
      cwd: projectRoot,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      env: subprocessEnv(),
      maxBuffer: 10 * 1024 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveRailwayCli(
  projectRoot: string
): Promise<{ command: string; baseArgs: string[] }> {
  try {
    await execAsync("railway --version", { cwd: projectRoot });
    return { command: "railway", baseArgs: [] };
  } catch {
    return { command: "npx", baseArgs: ["-y", "@railway/cli"] };
  }
}

async function resolveVercelCli(
  projectRoot: string
): Promise<{ command: string; baseArgs: string[] }> {
  try {
    await execAsync("vercel --version", { cwd: projectRoot });
    return { command: "vercel", baseArgs: [] };
  } catch {
    return { command: "npx", baseArgs: ["-y", "vercel"] };
  }
}
