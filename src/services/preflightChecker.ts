import { DeployLogger } from "../types";
import { DeploymentTarget } from "./deploymentStrategy";
import { runCommand } from "./commandRunner";

export async function runDeployPreflight(
  projectRoot: string,
  targets: DeploymentTarget[],
  logger: DeployLogger
): Promise<void> {
  logger("[AI Deploy] Preflight checks (terminal)...");

  await runCommand(projectRoot, "node -v", logger, { optional: true });
  await runCommand(projectRoot, "npm -v", logger, { optional: true });

  if (targets.includes("fly")) {
    const flyctl = await runCommand(projectRoot, "flyctl version", logger, { optional: true });
    if (!flyctl.success) {
      await runCommand(projectRoot, "npx -y flyctl version", logger, { optional: true });
    }
    await runCommand(projectRoot, "flyctl auth whoami", logger, { optional: true });
  }

  if (targets.includes("railway")) {
    const railway = await runCommand(projectRoot, "railway --version", logger, { optional: true });
    if (!railway.success) {
      await runCommand(projectRoot, "npx -y @railway/cli --version", logger, { optional: true });
    }
    await runCommand(projectRoot, "railway whoami", logger, { optional: true });
  }

  if (targets.includes("vercel")) {
    const vercel = await runCommand(projectRoot, "vercel --version", logger, { optional: true });
    if (!vercel.success) {
      await runCommand(projectRoot, "npx -y vercel --version", logger, { optional: true });
    }
    await runCommand(projectRoot, "vercel whoami", logger, { optional: true });
  }
}
