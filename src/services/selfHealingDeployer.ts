import { DetectionResult, DeployLogger } from "../types";
import { resolveDeploymentInsight } from "./aiAnalyzer";
import { applyAutoFixActions } from "./autoFixer";
import { runOptionalDiagnostic } from "./commandRunner";
import { getAiDeployConfig } from "./config";
import { deployWithTarget } from "./deploymentExecutor";
import { isCloudBillingBlocked, isFlyPaymentRequired, isRailwayTrialExpired } from "./billingGuard";
import { getBaselineRecoveryActions, mergeRecoveryActions } from "./recoveryPipeline";
import {
  buildDeploymentStrategy,
  collectDeployTargets,
  DeploymentTarget
} from "./deploymentStrategy";

export interface SelfHealingResult {
  success: boolean;
  output: string;
  strategySummary: string;
}

export async function deployWithSelfHealing(
  workspaceRoot: string,
  detection: DetectionResult,
  logger: DeployLogger
): Promise<SelfHealingResult> {
  const strategy = buildDeploymentStrategy(detection);
  const targets = collectDeployTargets(detection, workspaceRoot);
  const maxAttempts = getAiDeployConfig().maxRetries;

  logger(`[AI Deploy] Strategy: ${strategy.category} -> ${strategy.primaryTarget}`);
  logger(`[AI Deploy] Strategy rationale: ${strategy.rationale}`);
  logger(`[AI Deploy] Max retry attempts: ${maxAttempts}`);

  const outputs: string[] = [];
  let allSucceeded = true;

  for (const deployTarget of targets) {
    logger(`[AI Deploy] Deploying ${deployTarget.label} from ${deployTarget.root} via ${deployTarget.target}`);
    const result = await deploySingleRootWithHealing(
      deployTarget.root,
      detection,
      deployTarget.target,
      strategy.fallbackTarget,
      workspaceRoot,
      maxAttempts,
      logger
    );
    outputs.push(`[${deployTarget.label}] ${result.output}`);
    if (!result.success) {
      allSucceeded = false;
      break;
    }
  }

  const combinedOutput = outputs.join("\n\n");
  if (allSucceeded) {
    return {
      success: true,
      output: combinedOutput,
      strategySummary: `${strategy.category} deployed (${targets.map((t) => t.label).join(" + ")})`
    };
  }

  return {
    success: false,
    output: combinedOutput,
    strategySummary: `${strategy.category} attempted via ${targets.map((t) => `${t.label}:${t.target}`).join(", ")}`
  };
}

async function deploySingleRootWithHealing(
  projectRoot: string,
  detection: DetectionResult,
  primaryTarget: DeploymentTarget,
  fallbackTarget: DeploymentTarget | undefined,
  workspaceRoot: string,
  maxAttempts: number,
  logger: DeployLogger
): Promise<{ success: boolean; output: string }> {
  let activeTarget = primaryTarget;
  let lastOutput = "";
  const appliedFixKeys = new Set<string>();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger(`[AI Deploy] Attempt ${attempt}/${maxAttempts}: deploying via ${activeTarget}`);

    let deploymentResult: { success: boolean; output: string };
    try {
      deploymentResult = await deployWithTarget(
        projectRoot,
        activeTarget,
        logger,
        workspaceRoot
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deploymentResult = { success: false, output: message };
      logger(`[AI Deploy] Deploy setup error: ${message}`);
    }

    lastOutput = deploymentResult.output;
    logger("[AI Deploy] Deployment output:");
    logger(lastOutput);

    if (deploymentResult.success) {
      return { success: true, output: lastOutput };
    }

    const enrichedOutput = await enrichFailureOutput(projectRoot, lastOutput, logger);
    const insight = await resolveDeploymentInsight(enrichedOutput, detection, logger);
    logger(`[AI Deploy][Insight] ${insight.reason}`);
    logger(`[AI Deploy][Insight] ${insight.summary}`);

    if (insight.fallbackTarget && insight.fallbackTarget !== activeTarget) {
      logger(`[AI Deploy] Switching deploy target to ${insight.fallbackTarget}`);
      activeTarget = insight.fallbackTarget;
    } else if (
      fallbackTarget &&
      attempt >= 2 &&
      activeTarget === primaryTarget &&
      fallbackTarget !== primaryTarget
    ) {
      logger(`[AI Deploy] Trying fallback target: ${fallbackTarget}`);
      activeTarget = fallbackTarget;
    }

    if (isFlyPaymentRequired(enrichedOutput) && activeTarget !== "tunnel" && activeTarget !== "vercel") {
      logger("[AI Deploy] Fly.io requires a credit card — switching to free Cloudflare tunnel");
      activeTarget = "tunnel";
    } else if (isRailwayTrialExpired(enrichedOutput) && (activeTarget === "railway" || activeTarget === "fly")) {
      logger("[AI Deploy] Railway/Fly billing blocked — switching to free Cloudflare tunnel");
      activeTarget = "tunnel";
    }

    if (!insight.shouldRetry && !isCloudBillingBlocked(enrichedOutput) && activeTarget !== "tunnel") {
      return {
        success: false,
        output: `${enrichedOutput}\n\n[AI Deploy][Insight] ${insight.reason}\n${insight.summary}`
      };
    }

    if (attempt === maxAttempts) {
      break;
    }

    const recoveryActions = mergeRecoveryActions(
      insight.autoFixActions,
      getBaselineRecoveryActions(activeTarget, enrichedOutput)
    ).filter((action) => {
      const key = `${action.kind}:${action.command ?? action.label}`;
      if (appliedFixKeys.has(key)) {
        return false;
      }
      appliedFixKeys.add(key);
      return true;
    });

    logger(`[AI Deploy] Auto-fix phase for attempt ${attempt} (${recoveryActions.length} actions)`);
    await applyAutoFixActions(projectRoot, recoveryActions, detection, logger, {
      workspaceRoot,
      deployTarget: activeTarget
    });

    logger(`[AI Deploy] Retrying deploy (attempt ${attempt + 1}/${maxAttempts})...`);
  }

  return {
    success: false,
    output: `${lastOutput}\n\n[AI Deploy] Deployment failed after ${maxAttempts} attempts with auto-fix retries.`
  };
}

async function enrichFailureOutput(
  projectRoot: string,
  failureOutput: string,
  logger: DeployLogger
): Promise<string> {
  if (failureOutput.toLowerCase().includes("vercel") || failureOutput.toLowerCase().includes("fly")) {
    return failureOutput;
  }

  const logs = await runOptionalDiagnostic(
    projectRoot,
    "railway logs --build --latest --lines 150",
    logger
  );

  if (!logs.trim()) {
    return failureOutput;
  }

  return `${failureOutput}\n\n[Railway build logs]\n${logs}`;
}
