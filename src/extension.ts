import * as vscode from "vscode";
import { applyAutoFixActions } from "./services/autoFixer";
import { resolveDeploymentInsight } from "./services/aiAnalyzer";
import { getOrCreateDeployTerminal, runCommand } from "./services/commandRunner";
import { getAiDeployConfig } from "./services/config";
import { extractDeployUrls, pickPrimaryDeployUrl } from "./services/deployResultParser";
import { finishDeployStatus, startDeployStatus, updateDeployStatus } from "./services/deployStatus";
import { ensureDockerfile } from "./services/dockerfileGenerator";
import { prepareForDeployment } from "./services/deploymentPreparation";
import { detectProjectType } from "./services/projectDetector";
import { runDeployPreflight } from "./services/preflightChecker";
import { deployWithSelfHealing } from "./services/selfHealingDeployer";
import { verifyLocalDocker } from "./services/localDockerVerifier";
import { formatEnvKeySummary, loadProjectEnvVars } from "./services/envLoader";
import { getBaselineRecoveryActions, mergeRecoveryActions } from "./services/recoveryPipeline";
import { buildDeploymentStrategy, collectDeployTargets } from "./services/deploymentStrategy";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("AI Deploy");
  context.subscriptions.push(output);

  const command = vscode.commands.registerCommand("ai-deploy.deployProject", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage("No project folder is open. Please open a workspace folder first.");
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    let activeRoot = workspaceRoot;

    const logger = (message: string): void => {
      output.appendLine(message);
    };

    startDeployStatus("Starting...");

    try {
      output.clear();
      output.show(true);
      getOrCreateDeployTerminal(workspaceRoot);

      const settings = getAiDeployConfig();
      output.appendLine("[AI Deploy] Starting deployment pipeline v0.4.1");
      output.appendLine(
        `[AI Deploy] AI analysis: ${settings.useAiAnalysis ? (settings.openAiApiKey ? "LLM enabled" : "heuristics + auto-recovery") : "disabled"}`
      );
      output.appendLine("[AI Deploy] All deploy commands run in the AI Deploy terminal");

      updateDeployStatus("Analyzing project...");
      const detection = await detectProjectType(workspaceRoot);
      activeRoot =
        detection.layout.backendRoot ??
        detection.layout.frontendRoot ??
        workspaceRoot;

      output.appendLine(`[AI Deploy] Workspace: ${workspaceRoot}`);
      output.appendLine(`[AI Deploy] Detection: ${JSON.stringify(detection)}`);

      if (detection.layout.kind === "monorepo") {
        output.appendLine(`[AI Deploy] Monorepo backend: ${detection.layout.backendRoot ?? "n/a"}`);
        output.appendLine(`[AI Deploy] Monorepo frontend: ${detection.layout.frontendRoot ?? "n/a"}`);
      }

      const deployTargets = collectDeployTargets(detection, workspaceRoot);
      const cliTargets = [...new Set(deployTargets.map((target) => target.target))];

      updateDeployStatus("Preflight checks...");
      await runDeployPreflight(activeRoot, cliTargets, logger);

      updateDeployStatus("Generating Dockerfiles...");
      const dockerRoots =
        detection.layout.kind === "monorepo"
          ? [detection.layout.backendRoot, detection.layout.frontendRoot].filter(
              (root): root is string => Boolean(root)
            )
          : [activeRoot];

      for (const root of dockerRoots) {
        const created = await ensureDockerfile(root, detection);
        output.appendLine(`[AI Deploy] Dockerfile (${root}): ${created ? "created/updated" : "already valid"}`);
      }

      updateDeployStatus("Preparing in terminal...");
      await prepareForDeployment(workspaceRoot, detection, logger);

      const { vars, sources } = await loadProjectEnvVars(activeRoot, workspaceRoot);
      if (sources.length > 0) {
        output.appendLine(`[AI Deploy] .env sources: ${sources.join(", ")}`);
        output.appendLine(`[AI Deploy] .env keys: ${formatEnvKeySummary(vars)}`);
      } else {
        output.appendLine("[AI Deploy] Warning: no .env file found — add DATABASE_URL to backend/.env");
      }

      updateDeployStatus("Deploying with self-healing...");
      let deploymentResult = await deployWithSelfHealing(workspaceRoot, detection, logger);

      if (!deploymentResult.success && settings.autoRetryAfterFix) {
        updateDeployStatus("Emergency recovery...");
        output.appendLine("[AI Deploy] Running emergency recovery pass in terminal...");
        await runEmergencyRecovery(workspaceRoot, detection, activeRoot, logger);
        output.appendLine("[AI Deploy] Auto-retrying full deploy after recovery...");
        deploymentResult = await deployWithSelfHealing(workspaceRoot, detection, logger);
      }

      output.appendLine(`[AI Deploy] Strategy summary: ${deploymentResult.strategySummary}`);

      if (deploymentResult.success) {
        const urls = extractDeployUrls(deploymentResult.output);
        const primaryUrl = pickPrimaryDeployUrl(urls);
        finishDeployStatus(true, primaryUrl ? "Deployed" : "Success");

        if (primaryUrl) {
          output.appendLine(`[AI Deploy] Live URL: ${primaryUrl}`);
          const open = "Open deployed app";
          const selection = await vscode.window.showInformationMessage(
            `Deployment successful 🚀\n${primaryUrl}`,
            open
          );
          if (selection === open) {
            await vscode.env.openExternal(vscode.Uri.parse(primaryUrl));
          }
        } else {
          void vscode.window.showInformationMessage("Deployment successful 🚀");
        }
      } else {
        finishDeployStatus(false, "Failed");
        await showSmartFailureGuidance(workspaceRoot, detection, output, logger, deploymentResult.output);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[AI Deploy] Pipeline error: ${message}`);
      finishDeployStatus(false, "Error");
      const detection = await detectProjectType(workspaceRoot).catch(() => undefined);
      if (detection) {
        await showSmartFailureGuidance(workspaceRoot, detection, output, logger, message);
      } else {
        void vscode.window.showErrorMessage(`Deployment failed: ${message}`);
      }
    }
  });

  const localTest = vscode.commands.registerCommand("ai-deploy.testLocal", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage("No project folder is open.");
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const logger = (message: string): void => {
      output.appendLine(message);
    };

    output.show(true);
    getOrCreateDeployTerminal(workspaceRoot);
    startDeployStatus("Local Docker test...");

    try {
      const detection = await detectProjectType(workspaceRoot);
      const root = detection.layout.backendRoot ?? detection.layout.frontendRoot ?? workspaceRoot;
      const result = await verifyLocalDocker(root, detection, logger);
      finishDeployStatus(result.success, result.success ? "Local test OK" : "Local test failed");
      if (result.success) {
        void vscode.window.showInformationMessage("Local Docker test passed — deploy packaging works without Railway.");
      } else {
        void vscode.window.showErrorMessage(`Local Docker test failed: ${result.output.slice(0, 200)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishDeployStatus(false, "Local test error");
      void vscode.window.showErrorMessage(`Local test error: ${message}`);
    }
  });

  context.subscriptions.push(command, localTest);
}

export function deactivate(): void {
  // No teardown required.
}

async function runEmergencyRecovery(
  workspaceRoot: string,
  detection: Awaited<ReturnType<typeof detectProjectType>>,
  fixRoot: string,
  logger: (message: string) => void
): Promise<void> {
  const strategy = buildDeploymentStrategy(detection);
  const actions = mergeRecoveryActions([], getBaselineRecoveryActions(strategy.primaryTarget));
  await applyAutoFixActions(fixRoot, actions, detection, logger, {
    workspaceRoot,
    deployTarget: strategy.primaryTarget
  });
}

async function showSmartFailureGuidance(
  projectRoot: string,
  detection: Awaited<ReturnType<typeof detectProjectType>>,
  output: vscode.OutputChannel,
  logger: (message: string) => void,
  failureOutput: string
): Promise<void> {
  const fixRoot = detection.layout.backendRoot ?? detection.layout.frontendRoot ?? projectRoot;
  const insight = await resolveDeploymentInsight(failureOutput, detection, logger);
  output.appendLine(`[AI Deploy][Insight] ${insight.reason}`);
  output.appendLine(`[AI Deploy][Insight] ${insight.summary}`);

  if (insight.autoFixActions.length > 0) {
    output.appendLine("[AI Deploy] Running final auto-fix pass in terminal...");
    await applyAutoFixActions(fixRoot, insight.autoFixActions, detection, logger, {
      workspaceRoot: projectRoot
    });
  }

  const settings = getAiDeployConfig();
  if (settings.autoRetryAfterFix && insight.shouldRetry) {
    updateDeployStatus("Auto-retrying...");
    output.appendLine("[AI Deploy] Auto-retrying deploy one more time...");
    const retry = await deployWithSelfHealing(projectRoot, detection, logger);
    if (retry.success) {
      const urls = extractDeployUrls(retry.output);
      const primaryUrl = pickPrimaryDeployUrl(urls);
      finishDeployStatus(true, "Recovered");
      void vscode.window.showInformationMessage(
        primaryUrl ? `Deployment successful after auto-recovery 🚀\n${primaryUrl}` : "Deployment successful after auto-recovery 🚀"
      );
      return;
    }
    output.appendLine(`[AI Deploy] Auto-retry failed: ${retry.strategySummary}`);
  }

  insight.actions.forEach((action) => {
    output.appendLine(`[AI Deploy][Action] ${action.label}${action.command ? ` -> ${action.command}` : ""}`);
  });

  const actionLabels = ["Retry AI Deploy", ...insight.actions.map((action) => action.label)];
  const selection = await vscode.window.showErrorMessage(
    `Deployment failed ❌: ${insight.reason}`,
    ...actionLabels
  );

  if (selection === "Retry AI Deploy") {
    await vscode.commands.executeCommand("ai-deploy.deployProject");
    return;
  }

  if (!selection) {
    return;
  }

  const selectedAction = insight.actions.find((action) => action.label === selection);
  if (!selectedAction?.command) {
    return;
  }

  await runCommand(fixRoot, selectedAction.command, logger);
}
