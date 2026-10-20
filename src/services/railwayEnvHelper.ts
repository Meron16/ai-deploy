import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DeployLogger } from "../types";
import { runCommand } from "./commandRunner";
import { parseEnvFile } from "./envLoader";
import { isRailwayTrialExpired } from "./localDockerVerifier";

const RAILWAY_DATABASE_KEYS = ["DATABASE_URL", "DATABASE_PRIVATE_URL", "PGDATABASE"];

export async function ensureRailwayPostgres(
  projectRoot: string,
  logger: DeployLogger,
  workspaceRoot?: string
): Promise<void> {
  logger("[AI Deploy] Ensuring Railway Postgres database...");
  const addResult = await runCommand(projectRoot, "railway add --database postgres", logger, {
    optional: true
  });

  if (isRailwayTrialExpired(addResult.output)) {
    logger(
      "[AI Deploy] Railway trial expired — skipping Postgres add. Using DATABASE_URL from .env instead."
    );
    return;
  }

  await pullRailwayDatabaseUrlIntoDotenv(projectRoot, logger, workspaceRoot);
}

export async function pullRailwayDatabaseUrlIntoDotenv(
  projectRoot: string,
  logger: DeployLogger,
  workspaceRoot?: string
): Promise<boolean> {
  const result = await runCommand(projectRoot, "railway variable list --kv", logger, {
    optional: true,
    silent: true
  });

  if (!result.success || !result.output.trim()) {
    return false;
  }

  const vars = parseKvOutput(result.output);
  const databaseUrl = RAILWAY_DATABASE_KEYS.map((key) => vars[key]).find(Boolean);
  if (!databaseUrl) {
    logger("[AI Deploy] Railway Postgres added but DATABASE_URL not found in variable list yet.");
    return false;
  }

  const envPath = await resolveDotenvPath(projectRoot, workspaceRoot);
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch {
    existing = "";
  }

  const parsed = parseEnvFile(existing);
  if (parsed.DATABASE_URL === databaseUrl) {
    return false;
  }

  const withoutOld = existing
    .split(/\r?\n/)
    .filter((line) => !/^\s*DATABASE_URL\s*=/.test(line))
    .join("\n")
    .trimEnd();

  const next = `${withoutOld}${withoutOld ? "\n" : ""}DATABASE_URL=${databaseUrl}\n`;
  await fs.writeFile(envPath, next, "utf8");
  logger(`[AI Deploy] Updated DATABASE_URL in ${envPath} from Railway`);
  return true;
}

function parseKvOutput(output: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

async function resolveDotenvPath(projectRoot: string, workspaceRoot?: string): Promise<string> {
  const candidates = [path.join(projectRoot, ".env")];
  if (workspaceRoot && workspaceRoot !== projectRoot) {
    candidates.push(path.join(workspaceRoot, ".env"));
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  return path.join(projectRoot, ".env");
}
