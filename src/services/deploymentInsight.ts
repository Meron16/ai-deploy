import { DetectionResult } from "../types";
import { AutoFixAction } from "./autoFixer";

export interface InsightAction {
  label: string;
  command?: string;
}

export interface DeploymentInsight {
  reason: string;
  summary: string;
  actions: InsightAction[];
  autoFixActions: AutoFixAction[];
  shouldRetry: boolean;
  fallbackTarget?: "railway" | "vercel" | "fly" | "tunnel";
}

export function analyzeDeploymentFailure(
  rawOutput: string,
  detection?: DetectionResult
): DeploymentInsight {
  const output = rawOutput.toLowerCase();

  const securityInsight = detectSecurityBlock(rawOutput);
  if (securityInsight) {
    return securityInsight;
  }

  if (
    output.includes("we need your payment information") ||
    output.includes("add a credit card") ||
    output.includes("buy credit")
  ) {
    return {
      reason: "Fly.io requires a credit card to create apps.",
      summary:
        "Fly free tier still asks for a card. AI Deploy will publish the backend with a free Cloudflare tunnel instead (no card). Keep using DATABASE_URL in .env.",
      actions: [
        { label: "Open Fly billing (optional card)", command: "flyctl dashboard" },
        { label: "Test local build", command: "npm run build" }
      ],
      autoFixActions: [{ kind: "package-json", label: "Ensure start script" }],
      shouldRetry: true,
      fallbackTarget: "tunnel"
    };
  }

  if (
    output.includes("trial has expired") ||
    output.includes("please select a plan") ||
    output.includes("selecta plan") ||
    (output.includes("railway") && output.includes("payment required"))
  ) {
    return {
      reason: "Railway trial expired — paid plan required.",
      summary:
        "Railway cannot host this app. AI Deploy will use a free Cloudflare tunnel for the backend (no card) and keep DATABASE_URL from .env.",
      actions: [{ label: "Test local build", command: "npm run build" }],
      autoFixActions: [{ kind: "package-json", label: "Ensure start script" }],
      shouldRetry: true,
      fallbackTarget: "tunnel"
    };
  }

  if (output.includes("vercel cli is not authenticated") || (output.includes("not logged in") && output.includes("vercel"))) {
    return {
      reason: "Vercel CLI is not authenticated.",
      summary: "Run vercel login in the AI Deploy terminal, then retry.",
      actions: [{ label: "Run vercel login", command: "vercel login" }],
      autoFixActions: [],
      shouldRetry: false
    };
  }

  if (output.includes("railway cli is not authenticated") || output.includes("usernotloggedin")) {
    return {
      reason: "Railway CLI is not authenticated in this shell.",
      summary: "Run railway login in the AI Deploy terminal, then click Retry AI Deploy.",
      actions: [{ label: "Run railway login", command: "railway login" }],
      autoFixActions: [],
      shouldRetry: false
    };
  }

  if (output.includes("no linked project")) {
    return {
      reason: "Project is not linked to Railway.",
      summary: "AI Deploy will create and link a Railway project automatically.",
      actions: [{ label: "Run railway init", command: "railway init --json" }],
      autoFixActions: [{ kind: "command", label: "Initialize Railway project", command: "railway init --json" }],
      shouldRetry: true
    };
  }

  if (output.includes("not authenticated") || output.includes("not logged in")) {
    return {
      reason: "CLI is not authenticated in this shell.",
      summary: "Run railway login (or vercel login) in the AI Deploy terminal, then retry.",
      actions: [
        { label: "Run railway login", command: "railway login" },
        { label: "Run vercel login", command: "vercel login" }
      ],
      autoFixActions: [],
      shouldRetry: false
    };
  }

  if (output.includes("available options can not be empty") || output.includes("has no projects/services yet")) {
    return {
      reason: "Railway workspace has no project/service to link.",
      summary: "AI Deploy will initialize a Railway project in this folder.",
      actions: [{ label: "Run railway init", command: "railway init --json" }],
      autoFixActions: [{ kind: "command", label: "Initialize Railway project", command: "railway init --json" }],
      shouldRetry: true
    };
  }

  if (
    output.includes("no service could be found") ||
    output.includes("specify one via the `--service`") ||
    output.includes("specify one via the") ||
    (output.includes("link one with") && output.includes("service")) ||
    output.includes("service: none") ||
    output.includes("still has no linked service")
  ) {
    return {
      reason: "No Railway service is linked to this folder.",
      summary: "AI Deploy will create and link a Railway service automatically.",
      actions: [{ label: "Create Railway service", command: "railway add --service" }],
      autoFixActions: [
        { kind: "command", label: "Create Railway service", command: "railway add --service" },
        { kind: "command", label: "Show Railway status", command: "railway status", optional: true }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("cannot find module") || output.includes("module not found") || output.includes("err_module_not_found")) {
    return {
      reason: "Dependency is missing at build/runtime.",
      summary: "Install dependencies and retry deployment.",
      actions: [{ label: "Run npm install", command: "npm install" }],
      autoFixActions: [
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "command", label: "Install with legacy peer deps", command: "npm install --legacy-peer-deps" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("npm err!") && output.includes("enoent") && output.includes("package.json")) {
    return {
      reason: "Deploy ran in the wrong folder (no package.json).",
      summary: "Open the monorepo root or backend folder and run AI Deploy again.",
      actions: [],
      autoFixActions: [],
      shouldRetry: false
    };
  }

  if (
    output.includes("nest build") ||
    output.includes("nestjs") ||
    (detection?.framework.toLowerCase().includes("nestjs") && output.includes("build"))
  ) {
    return {
      reason: "NestJS build failed.",
      summary: "Fix start script, rebuild, regenerate Dockerfile, then redeploy.",
      actions: [
        { label: "Run npm install", command: "npm install" },
        { label: "Run npm run build", command: "npm run build" }
      ],
      autoFixActions: [
        { kind: "package-json", label: "Set start:prod as start script" },
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "command", label: "Run local build", command: "npm run build" },
        { kind: "dockerfile", label: "Regenerate NestJS Dockerfile" }
      ],
      shouldRetry: true
    };
  }

  if (
    output.includes("build failed") ||
    (output.includes("npm run build") && output.includes("error")) ||
    output.includes("tsc:") ||
    (output.includes("vite build") && output.includes("error"))
  ) {
    return {
      reason: "Project build failed.",
      summary: "Reinstall dependencies, rebuild locally, then redeploy.",
      actions: [
        { label: "Run npm install", command: "npm install" },
        { label: "Run npm run build", command: "npm run build" }
      ],
      autoFixActions: [
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "command", label: "Run local build", command: "npm run build" },
        { kind: "dockerfile", label: "Regenerate Dockerfile" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("missing script: start") || output.includes("missing script: \"start\"")) {
    return {
      reason: "package.json is missing a start script.",
      summary: "AI Deploy will add a start script automatically.",
      actions: [{ label: "Fix start script", command: "npm pkg set scripts.start=\"node index.js\"" }],
      autoFixActions: [{ kind: "package-json", label: "Add start script" }],
      shouldRetry: true
    };
  }

  if (
    output.includes("port already in use") ||
    output.includes("eaddrinuse") ||
    output.includes("listen eaddrinuse")
  ) {
    return {
      reason: "Application port conflict detected.",
      summary: "Ensure the app listens on process.env.PORT for Railway.",
      actions: [{ label: "Ensure PORT env", command: "echo PORT=3000>> .env" }],
      autoFixActions: [
        { kind: "env", label: "Set PORT in .env" },
        { kind: "dockerfile", label: "Regenerate Dockerfile with PORT support" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("docker") && (output.includes("failed to build") || output.includes("build error"))) {
    return {
      reason: "Docker build failed on the platform.",
      summary: "Regenerate Dockerfile for this project type and redeploy.",
      actions: [{ label: "Regenerate Dockerfile", command: "echo Regenerating Dockerfile..." }],
      autoFixActions: [
        { kind: "dockerfile", label: "Regenerate Dockerfile" },
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "package-json", label: "Ensure production start script" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("vercel") && (output.includes("error") || output.includes("failed"))) {
    return {
      reason: "Vercel deployment failed.",
      summary: "Retry on Railway as a fallback target.",
      actions: [{ label: "Deploy with Railway", command: "railway up --ci" }],
      autoFixActions: [{ kind: "command", label: "Install dependencies", command: "npm install" }],
      shouldRetry: true,
      fallbackTarget: "railway"
    };
  }

  if (output.includes("railway") && output.includes("timed out")) {
    return {
      reason: "Railway deployment timed out.",
      summary: "Retry after installing dependencies and fixing Dockerfile.",
      actions: [{ label: "View Railway logs", command: "railway logs --build --latest --lines 200" }],
      autoFixActions: [
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "dockerfile", label: "Regenerate Dockerfile" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("erresolve") || output.includes("peer dep") || output.includes("could not resolve dependency")) {
    return {
      reason: "npm peer dependency conflict.",
      summary: "Install with legacy peer deps in terminal and redeploy.",
      actions: [{ label: "npm install --legacy-peer-deps", command: "npm install --legacy-peer-deps" }],
      autoFixActions: [
        { kind: "command", label: "Install with legacy peer deps", command: "npm install --legacy-peer-deps" },
        { kind: "dockerfile", label: "Regenerate Dockerfile" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("npm ci") && output.includes("error")) {
    return {
      reason: "npm ci failed during container build.",
      summary: "Sync lockfile locally with npm install, then redeploy.",
      actions: [{ label: "Run npm install", command: "npm install" }],
      autoFixActions: [
        { kind: "command", label: "Sync dependencies", command: "npm install" },
        { kind: "dockerfile", label: "Regenerate Dockerfile" }
      ],
      shouldRetry: true
    };
  }

  if (
    detection?.framework.toLowerCase().includes("nestjs") &&
    (output.includes("database") || output.includes("typeorm") || output.includes("connect"))
  ) {
    return {
      reason: "Database connection failed at runtime.",
      summary: "Ensure DATABASE_URL in .env is correct, then redeploy so Railway receives updated variables.",
      actions: [{ label: "Resync .env to Railway", command: "railway variable list" }],
      autoFixActions: [
        { kind: "env-sync", label: "Resync .env variables to Railway" },
        { kind: "railway-postgres", label: "Add Railway Postgres if missing" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("database_url") && output.includes("undefined")) {
    return {
      reason: "DATABASE_URL is not set on the deployment platform.",
      summary: "Add DATABASE_URL to .env and redeploy, or provision Railway Postgres.",
      actions: [],
      autoFixActions: [
        { kind: "env-sync", label: "Sync .env to Railway" },
        { kind: "railway-postgres", label: "Add Railway Postgres" }
      ],
      shouldRetry: true
    };
  }

  if (
    output.includes("connect econnrefused") ||
    output.includes("connection refused") ||
    output.includes("password authentication failed") ||
    output.includes("database connection") ||
    output.includes("getaddrinfo enotfound") ||
    (output.includes("typeorm") && output.includes("connect"))
  ) {
    return {
      reason: "Database connection failed at runtime.",
      summary: "Ensure DATABASE_URL in .env is correct, then redeploy so Railway receives updated variables.",
      actions: [{ label: "Resync .env to Railway", command: "railway variable list" }],
      autoFixActions: [
        { kind: "env-sync", label: "Resync .env variables to Railway" },
        { kind: "railway-postgres", label: "Add Railway Postgres if missing" }
      ],
      shouldRetry: true
    };
  }

  if (output.includes("no deployments found")) {
    return {
      reason: "No Railway deployment exists yet.",
      summary: "First deploy attempt — retrying after setup fixes.",
      actions: [{ label: "Deploy again", command: "railway up --ci" }],
      autoFixActions: [
        { kind: "command", label: "Install dependencies", command: "npm install" },
        { kind: "package-json", label: "Ensure start script" },
        { kind: "dockerfile", label: "Regenerate Dockerfile" },
        { kind: "command", label: "Create Railway service", command: "railway add --service", optional: true }
      ],
      shouldRetry: true
    };
  }

  return {
    reason: "Deployment failed with an unclassified error.",
    summary: "AI Deploy will fix setup issues and retry automatically.",
    actions: [{ label: "View latest Railway logs", command: "railway logs --build --latest --lines 200" }],
    autoFixActions: [
      { kind: "command", label: "Install dependencies", command: "npm install" },
      { kind: "package-json", label: "Ensure start script" },
      { kind: "dockerfile", label: "Regenerate Dockerfile" },
      { kind: "command", label: "Create Railway service", command: "railway add --service", optional: true }
    ],
    shouldRetry: true
  };
}

function detectSecurityBlock(rawOutput: string): DeploymentInsight | undefined {
  const output = rawOutput.toLowerCase();
  if (!output.includes("security vulnerabilities detected")) {
    return undefined;
  }

  const upgradeMatch = rawOutput.match(/Upgrade to ([^:]+):\s*(npm install [^\r\n]+)/i);
  const packageMatch = rawOutput.match(/Found \d+ vulnerable package\(s\):[\s\S]*?\n\s*([@/\w.-]+@\d+\.\d+\.\d+)/i);

  const vulnerablePackage = packageMatch?.[1] ?? "a dependency";
  const upgradeCommand = upgradeMatch?.[2]?.trim() ?? "npm update";

  return {
    reason: `Railway blocked deployment due to vulnerabilities in ${vulnerablePackage}.`,
    summary: "Upgrade vulnerable dependencies and redeploy.",
    actions: [
      { label: "Apply security upgrade", command: upgradeCommand },
      { label: "Redeploy", command: "railway up --ci" }
    ],
    autoFixActions: [{ kind: "command", label: "Apply security upgrade", command: upgradeCommand }],
    shouldRetry: true
  };
}
