import { AutoFixAction } from "./autoFixer";
import { DeploymentTarget } from "./deploymentStrategy";
import { isCloudBillingBlocked, isRailwayTrialExpired } from "./billingGuard";

export function getBaselineRecoveryActions(
  deployTarget: DeploymentTarget,
  lastError = ""
): AutoFixAction[] {
  const billingBlocked = isCloudBillingBlocked(lastError);
  const trialExpired = isRailwayTrialExpired(lastError);

  return [
    { kind: "command", label: "Install dependencies", command: "npm install --legacy-peer-deps" },
    { kind: "package-json", label: "Ensure production start script" },
    { kind: "dockerfile", label: "Regenerate Dockerfile" },
    ...(billingBlocked
      ? []
      : [{ kind: "env-sync" as const, label: "Sync .env to platform" }]),
    ...(deployTarget === "railway" && !trialExpired && !billingBlocked
      ? [{ kind: "railway-postgres" as const, label: "Ensure Railway Postgres", optional: true }]
      : [])
  ];
}

export function mergeRecoveryActions(
  specific: AutoFixAction[],
  baseline: AutoFixAction[]
): AutoFixAction[] {
  const merged = [...specific, ...baseline];
  const seen = new Set<string>();
  return merged.filter((action) => {
    const key = `${action.kind}:${action.command ?? action.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
