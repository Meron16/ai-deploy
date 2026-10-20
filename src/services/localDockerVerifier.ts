import { DetectionResult, DeployLogger } from "../types";
import { runCommand } from "./commandRunner";
import { ensureDockerfile } from "./dockerfileGenerator";

export { isRailwayTrialExpired } from "./billingGuard";

export async function verifyLocalDocker(
  projectRoot: string,
  detection: DetectionResult,
  logger: DeployLogger
): Promise<{ success: boolean; output: string }> {
  logger("[AI Deploy] Cloud host unavailable — verifying deploy locally with Docker");
  await ensureDockerfile(projectRoot, detection);

  const dockerOk = await runCommand(projectRoot, "docker --version", logger, { optional: true });
  if (!dockerOk.success) {
    return {
      success: false,
      output:
        "Docker is not installed or not running. Install Docker Desktop to test deployment locally without Railway."
    };
  }

  logger("[AI Deploy] Building Docker image (this can take a few minutes)...");
  const build = await runCommand(projectRoot, "docker build -t ai-deploy-local-test .", logger, {
    timeoutMs: 15 * 60 * 1000
  });

  if (!build.success) {
    return {
      success: false,
      output: `Local Docker build failed.\n${build.output}`
    };
  }

  return {
    success: true,
    output:
      "Local Docker build succeeded. Dockerfile, install, and build steps work. Railway trial is expired — use this local proof, Vercel (frontend), or Render (backend) for a live URL."
  };
}
