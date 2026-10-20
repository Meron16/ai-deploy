import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DetectionResult } from "../types";
import { runCommand } from "./commandRunner";
import { applyAutoFixActions } from "./autoFixer";
import { getAiDeployConfig } from "./config";
import { ensureDockerfile } from "./dockerfileGenerator";
import { DeployLogger } from "../types";
import { formatEnvKeySummary, loadProjectEnvVars } from "./envLoader";

export async function prepareForDeployment(
  workspaceRoot: string,
  detection: DetectionResult,
  logger: DeployLogger
): Promise<void> {
  const installRoot = resolveInstallRoot(workspaceRoot, detection);
  await ensureDependenciesInstalled(installRoot, logger);

  const roots = collectDeployRoots(workspaceRoot, detection);
  for (const root of roots) {
    await ensureDockerfile(root, detection);
    await applyAutoFixActions(
      root,
      [{ kind: "package-json", label: "Ensure start script" }],
      detection,
      logger,
      { workspaceRoot }
    );
    await validateEnvironment(root, workspaceRoot, detection, logger);
    await runLocalBuildIfEnabled(root, detection, logger);
  }
}

function resolveInstallRoot(workspaceRoot: string, detection: DetectionResult): string {
  if (detection.layout.kind === "monorepo") {
    return workspaceRoot;
  }
  return detection.layout.backendRoot ?? detection.layout.frontendRoot ?? workspaceRoot;
}

function collectDeployRoots(workspaceRoot: string, detection: DetectionResult): string[] {
  if (detection.layout.kind === "monorepo") {
    const roots = new Set<string>();
    if (detection.layout.backendRoot) {
      roots.add(detection.layout.backendRoot);
    }
    if (detection.layout.frontendRoot) {
      roots.add(detection.layout.frontendRoot);
    }
    if (roots.size === 0) {
      roots.add(workspaceRoot);
    }
    return [...roots];
  }
  return [workspaceRoot];
}

async function ensureDependenciesInstalled(installRoot: string, logger: DeployLogger): Promise<void> {
  const hasModules = await hasNodeModules(installRoot);
  if (hasModules) {
    return;
  }

  logger(`[AI Deploy] node_modules missing — running npm install in ${installRoot}`);
  const result = await runCommand(installRoot, "npm install", logger);
  if (!result.success) {
    logger("[AI Deploy] npm install failed — trying npm install --legacy-peer-deps");
    await runCommand(installRoot, "npm install --legacy-peer-deps", logger);
  }
}

async function runLocalBuildIfEnabled(
  deployRoot: string,
  detection: DetectionResult,
  logger: DeployLogger
): Promise<void> {
  const settings = getAiDeployConfig();
  if (!settings.runLocalBuildFirst || !detection.hasBuildScript) {
    return;
  }

  const isBackend =
    detection.projectType === "node" ||
    detection.projectType === "fullstack" ||
    detection.framework.toLowerCase().includes("nestjs") ||
    detection.framework.toLowerCase().includes("express");

  if (!isBackend && detection.projectType !== "next" && detection.projectType !== "nuxt") {
    return;
  }

  logger(`[AI Deploy] Running local build in ${deployRoot} before deploy...`);
  const result = await runCommand(deployRoot, "npm run build", logger);
  if (!result.success) {
    logger("[AI Deploy] Local build failed — auto-fix will attempt repairs during deploy retries.");
  }
}

async function validateEnvironment(
  deployRoot: string,
  workspaceRoot: string,
  detection: DetectionResult,
  logger: DeployLogger
): Promise<void> {
  const { vars, sources } = await loadProjectEnvVars(deployRoot, workspaceRoot);
  const needsDatabase =
    detection.framework.toLowerCase().includes("nestjs") ||
    detection.framework.toLowerCase().includes("typeorm");

  if (sources.length === 0) {
    logger("[AI Deploy] Warning: no .env file found for this deploy target.");
  } else {
    logger(`[AI Deploy] Environment keys ready: ${formatEnvKeySummary(vars)}`);
  }

  if (needsDatabase && !vars.DATABASE_URL?.trim()) {
    logger("[AI Deploy] Warning: DATABASE_URL missing from .env — add it or use Railway Postgres.");
  }
}

async function hasNodeModules(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, "node_modules"));
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(dir: string): Promise<{ workspaces?: string[] } | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    return JSON.parse(raw) as { workspaces?: string[] };
  } catch {
    return undefined;
  }
}

export async function isNpmWorkspaceRoot(dir: string): Promise<boolean> {
  const pkg = await readPackageJson(dir);
  return Array.isArray(pkg?.workspaces) && pkg.workspaces.length > 0;
}
