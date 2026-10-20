import { DetectionResult, DeployLogger } from "../types";
import { AutoFixAction, isSafeAutoFixCommand } from "./autoFixer";
import { getAiDeployConfig } from "./config";
import { DeploymentInsight, analyzeDeploymentFailure } from "./deploymentInsight";

interface AiFixResponse {
  reason?: string;
  summary?: string;
  shouldRetry?: boolean;
  commands?: string[];
  fixes?: Array<"dockerfile" | "package-json" | "env-sync" | "env">;
}

export async function resolveDeploymentInsight(
  rawOutput: string,
  detection: DetectionResult,
  logger: DeployLogger
): Promise<DeploymentInsight> {
  const patternInsight = analyzeDeploymentFailure(rawOutput, detection);
  const isUnclassified = patternInsight.reason.includes("unclassified");
  const settings = getAiDeployConfig();

  if (!settings.useAiAnalysis || !settings.openAiApiKey) {
    if (isUnclassified) {
      return enhanceWithDeepHeuristics(rawOutput, detection, patternInsight);
    }
    return patternInsight;
  }

  if (!isUnclassified && !shouldEscalateToAi(rawOutput)) {
    return patternInsight;
  }

  logger("[AI Deploy][AI] Analyzing failure with LLM...");
  const aiInsight = await analyzeWithLlm(rawOutput, detection, logger, settings);
  if (!aiInsight) {
    return isUnclassified ? enhanceWithDeepHeuristics(rawOutput, detection, patternInsight) : patternInsight;
  }

  return mergeInsights(patternInsight, aiInsight);
}

function shouldEscalateToAi(rawOutput: string): boolean {
  const output = rawOutput.toLowerCase();
  return (
    output.includes("error ts") ||
    output.includes("typescript error") ||
    output.includes("nest can't resolve") ||
    output.includes("cannot find module '@") ||
    output.length > 4000
  );
}

function enhanceWithDeepHeuristics(
  rawOutput: string,
  detection: DetectionResult,
  base: DeploymentInsight
): DeploymentInsight {
  const output = rawOutput.toLowerCase();
  const autoFixActions: AutoFixAction[] = [...base.autoFixActions];

  if (output.includes("ebadengine") || output.includes("engine \"node\"")) {
    autoFixActions.push({ kind: "dockerfile", label: "Regenerate Dockerfile with Node 20" });
  }

  if (output.includes("enoent") && output.includes("package-lock")) {
    autoFixActions.push({ kind: "command", label: "Install without lockfile", command: "npm install" });
    autoFixActions.push({ kind: "dockerfile", label: "Regenerate Dockerfile using npm install" });
  }

  if (
    detection.framework.toLowerCase().includes("nestjs") &&
    (output.includes("database") || output.includes("typeorm") || output.includes("connect"))
  ) {
    autoFixActions.push({ kind: "env-sync", label: "Resync DATABASE_URL from .env" });
    autoFixActions.push({ kind: "railway-postgres", label: "Add Railway Postgres if missing" });
  }

  const tsMatch = rawOutput.match(/error TS\d+:[^\n]+/g);
  if (tsMatch?.length) {
    return {
      reason: `TypeScript build error (${tsMatch.length} issue(s)).`,
      summary: tsMatch.slice(0, 2).join(" | "),
      actions: [{ label: "Run npm run build", command: "npm run build" }],
      autoFixActions: [
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "command", label: "Run local build", command: "npm run build" }
      ],
      shouldRetry: true
    };
  }

  return { ...base, autoFixActions: dedupeActions(autoFixActions), shouldRetry: true };
}

async function analyzeWithLlm(
  rawOutput: string,
  detection: DetectionResult,
  logger: DeployLogger,
  settings: ReturnType<typeof getAiDeployConfig>
): Promise<DeploymentInsight | undefined> {
  const trimmedLog = rawOutput.slice(-12000);

  const systemPrompt = `You are a deployment engineer for Node.js apps on Railway and Vercel.
Given deployment logs, respond with JSON only:
{
  "reason": "short failure reason",
  "summary": "what to do next",
  "shouldRetry": true,
  "commands": ["safe shell commands like npm install, npm run build, railway add --service"],
  "fixes": ["dockerfile" | "package-json" | "env-sync" | "env"]
}
Rules: only suggest safe fix commands (npm, railway, vercel). Never suggest rm, sudo, curl, or destructive commands.`;

  const userPrompt = `Project: ${detection.projectType} / ${detection.framework}
Layout: ${detection.layout.kind}
Logs:
${trimmedLog}`;

  try {
    const response = await fetch(`${settings.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openAiApiKey}`
      },
      body: JSON.stringify({
        model: settings.openAiModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      logger(`[AI Deploy][AI] API error: ${response.status} ${response.statusText}`);
      return undefined;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return undefined;
    }

    const parsed = JSON.parse(content) as AiFixResponse;
    logger(`[AI Deploy][AI] ${parsed.reason ?? "Analysis complete"}`);

    const autoFixActions: AutoFixAction[] = [];
    for (const fix of parsed.fixes ?? []) {
      autoFixActions.push({ kind: fix, label: `AI fix: ${fix}` });
    }
    for (const command of parsed.commands ?? []) {
      if (isSafeAutoFixCommand(command)) {
        autoFixActions.push({ kind: "command", label: `AI command: ${command}`, command });
      }
    }

    return {
      reason: parsed.reason ?? "AI analyzed deployment failure.",
      summary: parsed.summary ?? "Applying AI-suggested fixes and retrying.",
      actions: (parsed.commands ?? [])
        .filter(isSafeAutoFixCommand)
        .map((command) => ({ label: command, command })),
      autoFixActions: dedupeActions(autoFixActions),
      shouldRetry: parsed.shouldRetry !== false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[AI Deploy][AI] Failed: ${message}`);
    return undefined;
  }
}

function mergeInsights(base: DeploymentInsight, ai: DeploymentInsight): DeploymentInsight {
  return {
    reason: ai.reason || base.reason,
    summary: ai.summary || base.summary,
    actions: [...base.actions, ...ai.actions],
    autoFixActions: dedupeActions([...base.autoFixActions, ...ai.autoFixActions]),
    shouldRetry: ai.shouldRetry || base.shouldRetry,
    fallbackTarget: ai.fallbackTarget ?? base.fallbackTarget
  };
}

function dedupeActions(actions: AutoFixAction[]): AutoFixAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.kind}:${action.command ?? action.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
