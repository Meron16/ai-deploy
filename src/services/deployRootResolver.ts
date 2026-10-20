import * as fs from "node:fs/promises";
import * as path from "node:path";

const SUBDIRS_WITH_APP = [
  "backend",
  "server",
  "api",
  "apps/api",
  "apps/server",
  "packages/api",
  "packages/server",
  "service",
  "frontend",
  "client",
  "web",
  "apps/web"
];

async function readPackageJsonDir(dir: string): Promise<{ hasStart: boolean; exists: boolean }> {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const hasStart = typeof pkg.scripts?.start === "string";
    return { hasStart, exists: true };
  } catch {
    return { hasStart: false, exists: false };
  }
}

/**
 * When the workspace root is a monorepo without its own `start` script, pick the first
 * common subfolder that has a deployable Node `package.json` so "AI Deploy" deploys the app.
 */
export async function resolveDeployablePackageRoot(workspaceRoot: string): Promise<string> {
  const rootInfo = await readPackageJsonDir(workspaceRoot);
  if (rootInfo.exists && rootInfo.hasStart) {
    return workspaceRoot;
  }

  for (const sub of SUBDIRS_WITH_APP) {
    const candidate = path.join(workspaceRoot, sub);
    const info = await readPackageJsonDir(candidate);
    if (info.exists && info.hasStart) {
      return candidate;
    }
  }

  if (rootInfo.exists) {
    return workspaceRoot;
  }

  for (const sub of SUBDIRS_WITH_APP) {
    const candidate = path.join(workspaceRoot, sub);
    const info = await readPackageJsonDir(candidate);
    if (info.exists) {
      return candidate;
    }
  }

  return workspaceRoot;
}
