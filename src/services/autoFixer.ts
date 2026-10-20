import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DetectionResult, DeployLogger } from "../types";
import { createDockerfileContent } from "./dockerfileGenerator";
import { runCommand } from "./commandRunner";
import { syncDotenvForDeploy } from "./envSync";
import { ensureRailwayPostgres } from "./railwayEnvHelper";
import { verifyLocalDocker } from "./localDockerVerifier";
import { DeploymentTarget } from "./deploymentStrategy";

export type AutoFixKind =
  | "command"
  | "dockerfile"
  | "package-json"
  | "env"
  | "env-sync"
  | "railway-postgres"
  | "local-docker";

export interface AutoFixAction {
  kind: AutoFixKind;
  label: string;
  command?: string;
  optional?: boolean;
}

export async function applyAutoFixActions(
  projectRoot: string,
  actions: AutoFixAction[],
  detection: DetectionResult,
  logger: DeployLogger,
  options: { workspaceRoot?: string; deployTarget?: DeploymentTarget } = {}
): Promise<boolean> {
  let attempted = false;

  for (const action of actions) {
    logger(`[AI Deploy] Auto-fix: ${action.label}`);
    attempted = true;

    if (action.kind === "command" && action.command) {
      if (!isSafeAutoFixCommand(action.command)) {
        logger(`[AI Deploy] Skipped unsafe command: ${action.command}`);
        continue;
      }
      await runCommand(projectRoot, action.command, logger, { optional: action.optional });
      continue;
    }

    if (action.kind === "dockerfile") {
      const dockerfile = await createDockerfileContent(detection, projectRoot);
      await fs.writeFile(path.join(projectRoot, "Dockerfile"), dockerfile, "utf8");
      logger("[AI Deploy] Regenerated Dockerfile");
      continue;
    }

    if (action.kind === "package-json") {
      const patched = await ensureStartScript(projectRoot, detection);
      if (patched) {
        logger("[AI Deploy] Added or fixed start script in package.json");
      }
      continue;
    }

    if (action.kind === "env") {
      const patched = await ensurePortEnvFile(projectRoot);
      if (patched) {
        logger("[AI Deploy] Ensured PORT in .env");
      }
      continue;
    }

    if (action.kind === "env-sync") {
      const target = options.deployTarget ?? "railway";
      await syncDotenvForDeploy(projectRoot, target, logger, options.workspaceRoot);
      continue;
    }

    if (action.kind === "railway-postgres") {
      await ensureRailwayPostgres(projectRoot, logger, options.workspaceRoot);
      continue;
    }

    if (action.kind === "local-docker") {
      await verifyLocalDocker(projectRoot, detection, logger);
    }
  }

  return attempted;
}

export function isSafeAutoFixCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  const safePrefixes = [
    "npm install",
    "npm ci",
    "npm update",
    "npm audit fix",
    "npm install --legacy-peer-deps",
    "npm run build",
    "npm rebuild",
    "npx -y @railway/cli",
    "railway ",
    "railway.cmd ",
    "railway add",
    "npx -y vercel",
    "vercel ",
    "docker "
  ];

  const blockedFragments = ["&& rm ", "&& del ", "| rm ", "| del ", "sudo ", "curl ", "wget "];

  if (blockedFragments.some((fragment) => normalized.includes(fragment))) {
    return false;
  }

  return safePrefixes.some((prefix) => normalized.startsWith(prefix));
}

async function ensureStartScript(projectRoot: string, detection: DetectionResult): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    pkg.scripts = pkg.scripts ?? {};

    const isNest = detection.framework.toLowerCase().includes("nestjs");
    if (isNest && typeof pkg.scripts["start:prod"] === "string") {
      if (pkg.scripts.start === pkg.scripts["start:prod"]) {
        return false;
      }
      pkg.scripts.start = pkg.scripts["start:prod"];
      await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      return true;
    }

    if (typeof pkg.scripts.start === "string" && pkg.scripts.start.trim()) {
      return false;
    }

    if (typeof pkg.scripts["start:prod"] === "string") {
      pkg.scripts.start = pkg.scripts["start:prod"];
    } else if (typeof pkg.scripts.dev === "string") {
      pkg.scripts.start = pkg.scripts.dev.replace(/\s--watch\b/g, "");
    } else if (typeof pkg.scripts.serve === "string") {
      pkg.scripts.start = pkg.scripts.serve;
    } else {
      const candidates = [
        "dist/main.js",
        "index.js",
        "server.js",
        "dist/index.js",
        "dist/server.js",
        "src/index.js"
      ];
      for (const file of candidates) {
        try {
          await fs.access(path.join(projectRoot, file));
          pkg.scripts.start = `node ${file.replace(/\\/g, "/")}`;
          break;
        } catch {
          // try next
        }
      }
      if (!pkg.scripts.start && typeof pkg.scripts.build === "string") {
        pkg.scripts.start = isNest ? "node dist/main" : "npm run build && node dist/index.js";
      }
    }

    if (!pkg.scripts.start) {
      return false;
    }

    await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function ensurePortEnvFile(projectRoot: string): Promise<boolean> {
  const envPath = path.join(projectRoot, ".env");
  try {
    const existing = await fs.readFile(envPath, "utf8");
    if (/^PORT=/m.test(existing)) {
      return false;
    }
    await fs.writeFile(envPath, `${existing.trimEnd()}\nPORT=3000\n`, "utf8");
    return true;
  } catch {
    await fs.writeFile(envPath, "PORT=3000\n", "utf8");
    return true;
  }
}
