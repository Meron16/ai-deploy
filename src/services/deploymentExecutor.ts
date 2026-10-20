import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { CommandResult, DeployLogger } from "../types";
import { DeploymentTarget } from "./deploymentStrategy";
import { runStreamingCommand, runCommand } from "./commandRunner";
import { syncDotenvForDeploy } from "./envSync";
import { deployWithFly } from "./flyDeployer";
import { deployWithTunnel } from "./tunnelDeployer";

const execAsync = promisify(exec);

/** Plain-text Railway CLI output (avoids colored "None" breaking parsers). */
function railwaySubprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0"
  };
}

function railwayExecOpts(projectRoot: string): { cwd: string; maxBuffer: number; env: NodeJS.ProcessEnv } {
  return {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
    env: railwaySubprocessEnv()
  };
}

export async function deployWithTarget(
  projectRoot: string,
  target: DeploymentTarget,
  logger: DeployLogger = () => undefined,
  workspaceRoot?: string
): Promise<CommandResult> {
  if (target === "vercel") {
    return deployWithVercel(projectRoot, logger, workspaceRoot);
  }
  if (target === "fly") {
    return deployWithFly(projectRoot, logger, workspaceRoot);
  }
  if (target === "tunnel") {
    return deployWithTunnel(projectRoot, logger);
  }
  return deployWithRailway(projectRoot, logger, workspaceRoot);
}

export async function deployWithRailway(
  projectRoot: string,
  logger: DeployLogger = () => undefined,
  workspaceRoot?: string
): Promise<CommandResult> {
  try {
    const cli = await resolveRailwayCli(projectRoot);
    await ensureRailwayAuthenticated(projectRoot, cli);
    await ensureRailwayProjectLinked(projectRoot, cli);
    await ensureRailwayService(projectRoot, cli);

    logger("[AI Deploy] Syncing environment variables from .env to Railway...");
    await syncDotenvForDeploy(projectRoot, "railway", logger, workspaceRoot);

    await runCommand(projectRoot, buildRailwayExec(cli, "status"), logger, { optional: true });

    return runRailwayUp(projectRoot, cli, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: message };
  }
}

export async function deployWithVercel(
  projectRoot: string,
  logger: DeployLogger = () => undefined,
  workspaceRoot?: string
): Promise<CommandResult> {
  try {
    const cli = await resolveVercelCli(projectRoot);
    await ensureVercelAuthenticated(projectRoot, cli);

    logger("[AI Deploy] Syncing environment variables from .env to Vercel...");
    await syncDotenvForDeploy(projectRoot, "vercel", logger, workspaceRoot);

    return runVercelDeploy(projectRoot, cli, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: message };
  }
}

async function runRailwayUp(
  projectRoot: string,
  cli: { command: string; baseArgs: string[]; label: string },
  logger: DeployLogger
): Promise<CommandResult> {
  logger(`[AI Deploy] Using CLI: ${cli.label}`);
  const result = await runStreamingCommand(
    projectRoot,
    cli.command,
    [...cli.baseArgs, "up", "--ci"],
    logger,
    15 * 60 * 1000
  );
  return {
    success: result.success,
    output: `[AI Deploy] Using CLI: ${cli.label}\n${result.output}`
  };
}

async function resolveRailwayCli(
  projectRoot: string
): Promise<{ command: string; baseArgs: string[]; label: string }> {
  try {
    await execAsync("railway --version", { cwd: projectRoot });
    return { command: "railway", baseArgs: [], label: "railway (global)" };
  } catch {
    try {
      await execAsync("npx -y @railway/cli --version", { cwd: projectRoot });
      return { command: "npx", baseArgs: ["-y", "@railway/cli"], label: "npx @railway/cli" };
    } catch {
      throw new Error(
        "Railway CLI not found. Install it with `npm i -g @railway/cli` or ensure `npx` is available."
      );
    }
  }
}

async function ensureRailwayAuthenticated(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<void> {
  try {
    await execAsync(`${cli.command} ${[...cli.baseArgs, "whoami"].join(" ")}`, railwayExecOpts(projectRoot));
  } catch {
    throw new Error("Railway CLI is not authenticated. Run `railway login` and try again.");
  }
}

async function fetchRailwayStatus(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<string> {
  const { stdout, stderr } = await execAsync(
    `${cli.command} ${[...cli.baseArgs, "status"].join(" ")}`,
    railwayExecOpts(projectRoot)
  );
  return `${stdout}\n${stderr}`;
}

/**
 * Ensures this directory is linked to a Railway project. If nothing is linked,
 * runs `railway init` to create a new project and link it (non-interactive when possible).
 */
async function ensureRailwayProjectLinked(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<void> {
  const assertStatusOk = (combined: string): void => {
    const output = combined.toLowerCase();
    if (output.includes("usernotloggedin") || output.includes("not logged in")) {
      throw new Error("Railway CLI is not authenticated in this shell. Run `railway login` and try again.");
    }
    if (output.includes("available options can not be empty")) {
      throw new Error(
        "Railway has no workspace or project to use yet. Log in (`railway login`) or set RAILWAY_WORKSPACE_ID to your workspace id."
      );
    }
    if (output.includes("no linked project")) {
      throw new Error("RAILWAY_NOT_LINKED");
    }
  };

  let combined: string;
  try {
    combined = await fetchRailwayStatus(projectRoot, cli);
  } catch (error) {
    const errText = extractCommandErrorOutput(error).toLowerCase();
    if (errText.includes("usernotloggedin") || errText.includes("not logged in")) {
      throw new Error("Railway CLI is not authenticated in this shell. Run `railway login` and try again.");
    }
    if (errText.includes("available options can not be empty")) {
      throw new Error(
        "Railway has no workspace or project to use yet. Log in (`railway login`) or set RAILWAY_WORKSPACE_ID to your workspace id."
      );
    }
    if (!errText.includes("no linked project")) {
      throw new Error(
        `Railway status failed before deploy. ${extractCommandErrorOutput(error).trim() || "Unknown error."}`
      );
    }
    await createAndLinkRailwayProject(projectRoot, cli);
    combined = await fetchRailwayStatus(projectRoot, cli);
    assertStatusOk(combined);
    return;
  }

  try {
    assertStatusOk(combined);
  } catch (error) {
    if (error instanceof Error && error.message === "RAILWAY_NOT_LINKED") {
      await createAndLinkRailwayProject(projectRoot, cli);
      const again = await fetchRailwayStatus(projectRoot, cli);
      assertStatusOk(again);
      return;
    }
    throw error;
  }
}

/**
 * `railway init --name …` creates a Railway project and links the current directory.
 * Workspace id is taken from RAILWAY_WORKSPACE_ID or the first entry in `railway list --json`.
 */
async function createAndLinkRailwayProject(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<void> {
  const projectName = await deriveRailwayProjectName(projectRoot);
  const workspaceId =
    (typeof process !== "undefined" && process.env.RAILWAY_WORKSPACE_ID?.trim()) ||
    (await fetchDefaultWorkspaceIdFromRailwayList(projectRoot, cli));

  const initArgs = ["init", "--name", projectName, "--json"];
  if (workspaceId) {
    initArgs.push("--workspace", workspaceId);
  }

  try {
    await execAsync(buildRailwayExec(cli, ...initArgs), railwayExecOpts(projectRoot));
  } catch (error) {
    const detail = extractCommandErrorOutput(error);
    const workspaceHint =
      /workspace|team|multiple|ambiguous/i.test(detail) && !process.env.RAILWAY_WORKSPACE_ID
        ? " Try setting environment variable RAILWAY_WORKSPACE_ID to your Railway workspace id (see `railway list --json` → workspace.id on any row)."
        : "";
    throw new Error(
      `AI Deploy could not create a Railway project automatically (${projectName}).${workspaceHint} ${detail}`.trim()
    );
  }
}

async function fetchDefaultWorkspaceIdFromRailwayList(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(buildRailwayExec(cli, "list", "--json"), railwayExecOpts(projectRoot));
    return parseFirstWorkspaceIdFromRailwayListJson(stdout);
  } catch {
    return undefined;
  }
}

function parseFirstWorkspaceIdFromRailwayListJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(data) || data.length === 0) {
    return undefined;
  }
  for (const row of data) {
    if (row && typeof row === "object" && "workspace" in row) {
      const ws = (row as { workspace?: { id?: string } }).workspace;
      if (ws && typeof ws.id === "string" && ws.id.length > 0) {
        return ws.id;
      }
    }
  }
  return undefined;
}

async function deriveRailwayProjectName(projectRoot: string): Promise<string> {
  const base = await deriveRailwayServiceName(projectRoot);
  const withSuffix = base.endsWith("-proj") ? base : `${base}-proj`;
  return sanitizeRailwayProjectName(withSuffix);
}

function sanitizeRailwayProjectName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/@[^/]+\//g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, 40) || "ai-deploy-app";
}

/**
 * When a project is linked but no service is selected (Service: None), either link an
 * existing service from the environment or create an empty service via `railway add`.
 *
 * Railway prints ANSI colors in `railway status` (e.g. red "None"), so matchers must
 * strip escape sequences first; otherwise we never detect "no service" and skip fixes.
 */
async function ensureRailwayService(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<void> {
  let statusText = "";
  try {
    statusText = await fetchRailwayStatus(projectRoot, cli);
  } catch {
    statusText = "";
  }

  const cleaned = stripAnsiSequences(statusText);
  const needsService = railwayStatusNeedsServiceLink(cleaned);
  const linkedName = parseLinkedServiceNameFromStatus(cleaned);
  const hasUsableLink =
    linkedName !== undefined &&
    linkedName.length > 0 &&
    linkedName.toLowerCase() !== "none" &&
    !(cleaned.toLowerCase().includes("not found in project") && cleaned.toLowerCase().includes("service"));

  let existingNames: string[] = [];
  try {
    const { stdout } = await execAsync(
      buildRailwayExec(cli, "service", "list", "--json"),
      railwayExecOpts(projectRoot)
    );
    existingNames = parseServiceNamesFromListJson(stdout);
  } catch {
    existingNames = [];
  }

  if (hasUsableLink && !needsService) {
    return;
  }

  if (existingNames.length > 0) {
    try {
      await tryLinkEachServiceUntilLinked(projectRoot, cli, existingNames);
      return;
    } catch {
      // No listed service linked successfully; create a new service below.
    }
  }

  const serviceName = await deriveRailwayServiceName(projectRoot);
  try {
    await execAsync(buildRailwayExec(cli, "add", "--service", serviceName), railwayExecOpts(projectRoot));
  } catch (error) {
    throw new Error(
      `Could not create a Railway service automatically (${serviceName}). Add a service in the Railway dashboard or run \`railway add --service\` in this folder. ${extractCommandErrorOutput(error)}`
    );
  }

  try {
    await execAsync(buildRailwayExec(cli, "service", "link", serviceName), railwayExecOpts(projectRoot));
  } catch {
    // `railway add` may already link the service; link is best-effort.
  }

  await assertServiceLinkedOrRecover(projectRoot, cli, serviceName);
}

async function tryLinkEachServiceUntilLinked(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  names: string[]
): Promise<void> {
  const errors: string[] = [];
  for (const pick of names) {
    try {
      await execAsync(buildRailwayExec(cli, "service", "link", pick), railwayExecOpts(projectRoot));
      const verify = stripAnsiSequences(await fetchRailwayStatus(projectRoot, cli));
      if (!railwayStatusNeedsServiceLink(verify)) {
        return;
      }
    } catch (error) {
      errors.push(extractCommandErrorOutput(error));
    }
  }
  throw new Error(
    `Could not link any Railway service (${names.join(", ")}). ${errors.join(" | ").slice(0, 500)}`
  );
}

async function assertServiceLinkedOrRecover(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  preferredName: string
): Promise<void> {
  let verify = "";
  try {
    verify = stripAnsiSequences(await fetchRailwayStatus(projectRoot, cli));
  } catch {
    verify = "";
  }
  if (!railwayStatusNeedsServiceLink(verify)) {
    return;
  }

  await relinkServiceFromFreshList(projectRoot, cli, preferredName);

  try {
    verify = stripAnsiSequences(await fetchRailwayStatus(projectRoot, cli));
  } catch {
    verify = "";
  }
  if (railwayStatusNeedsServiceLink(verify)) {
    try {
      await execAsync(buildRailwayExec(cli, "add", "--service"), railwayExecOpts(projectRoot));
      await relinkServiceFromFreshList(projectRoot, cli, preferredName);
    } catch {
      // ignore; original error below
    }
    try {
      verify = stripAnsiSequences(await fetchRailwayStatus(projectRoot, cli));
    } catch {
      verify = "";
    }
    if (railwayStatusNeedsServiceLink(verify)) {
      throw new Error(
        "Railway still has no linked service after `railway add`. Run `railway status` in this folder; if Service is None, run `railway service link <name>` once."
      );
    }
  }
}

async function relinkServiceFromFreshList(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] },
  preferredName: string
): Promise<void> {
  let names: string[] = [];
  try {
    const { stdout } = await execAsync(
      buildRailwayExec(cli, "service", "list", "--json"),
      railwayExecOpts(projectRoot)
    );
    names = parseServiceNamesFromListJson(stdout);
  } catch {
    names = [];
  }

  const ordered = [...new Set([preferredName, ...names, ...[...names].reverse()])].filter((n) => n.length > 0);
  for (const pick of ordered) {
    try {
      await execAsync(buildRailwayExec(cli, "service", "link", pick), railwayExecOpts(projectRoot));
      const s = stripAnsiSequences(await fetchRailwayStatus(projectRoot, cli));
      if (!railwayStatusNeedsServiceLink(s)) {
        return;
      }
    } catch {
      // try next name
    }
  }
}

function stripAnsiSequences(text: string): string {
  return text
    .replace(/\u001b\[[\d;]*[A-Za-z]/g, "")
    .replace(/\u001b\[[\d;]*m/g, "")
    .replace(/\u001b\]8;;.*?\u001b\\/g, "")
    .replace(/\x1b\[[\d;]*[A-Za-z]/g, "")
    .replace(/\x1b\[[\d;]*m/g, "");
}

function parseLinkedServiceNameFromStatus(cleaned: string): string | undefined {
  const lineMatch = cleaned.match(/^\s*service:\s*(.+)$/im);
  if (!lineMatch?.[1]) {
    return undefined;
  }
  let rest = stripAnsiSequences(lineMatch[1]).trim();
  const paren = rest.indexOf("(");
  if (paren !== -1) {
    rest = rest.slice(0, paren).trim();
  }
  return rest.length > 0 ? rest : undefined;
}

function railwayStatusNeedsServiceLink(statusText: string): boolean {
  const lower = statusText.toLowerCase();
  if (lower.includes("not found in project") && lower.includes("service")) {
    return true;
  }
  if (/\bservice:\s*none\b/i.test(statusText)) {
    return true;
  }
  if (/\bservice:\s*not\s+set\b/i.test(lower)) {
    return true;
  }
  return false;
}

function parseServiceNamesFromListJson(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed) as unknown;
  } catch {
    return [];
  }
  const collected = new Set<string>();
  collectServiceNamesFromListPayload(data, collected);
  return [...collected];
}

function collectServiceNamesFromListPayload(node: unknown, out: Set<string>): void {
  if (node === null || node === undefined) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectServiceNamesFromListPayload(item, out);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.edges)) {
    for (const edge of o.edges) {
      if (edge && typeof edge === "object") {
        const n = (edge as { node?: { name?: string } }).node?.name;
        if (typeof n === "string" && n.length > 0) {
          out.add(n);
        }
        collectServiceNamesFromListPayload((edge as { node?: unknown }).node, out);
      }
    }
  }
  if (typeof o.name === "string" && o.name.length > 0) {
    if (typeof o.id === "string" && o.id.length > 8) {
      out.add(o.name);
    }
  }
  for (const [key, value] of Object.entries(o)) {
    if (key === "workspace" || key === "workspaceId") {
      continue;
    }
    collectServiceNamesFromListPayload(value, out);
  }
}

async function deriveRailwayServiceName(projectRoot: string): Promise<string> {
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      const sanitized = sanitizeRailwayServiceName(pkg.name);
      if (sanitized.length > 0) {
        return sanitized;
      }
    }
  } catch {
    // ignore missing or invalid package.json
  }
  return sanitizeRailwayServiceName(basename(projectRoot)) || "web";
}

function sanitizeRailwayServiceName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/@[^/]+\//g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, 48);
}

function buildRailwayExec(cli: { command: string; baseArgs: string[] }, ...args: string[]): string {
  const parts = [cli.command, ...cli.baseArgs, ...args];
  return parts.map(quoteExecArg).join(" ");
}

function quoteExecArg(part: string): string {
  if (!/[\s"&|<>]/.test(part)) {
    return part;
  }
  return `"${part.replace(/"/g, '\\"')}"`;
}

function extractCommandErrorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const maybeStdout = Reflect.get(error, "stdout");
  const maybeStderr = Reflect.get(error, "stderr");
  const maybeMessage = Reflect.get(error, "message");

  return [maybeMessage, maybeStdout, maybeStderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

async function resolveVercelCli(
  projectRoot: string
): Promise<{ command: string; baseArgs: string[]; label: string }> {
  try {
    await execAsync("vercel --version", { cwd: projectRoot });
    return { command: "vercel", baseArgs: [], label: "vercel (global)" };
  } catch {
    try {
      await execAsync("npx -y vercel --version", { cwd: projectRoot });
      return { command: "npx", baseArgs: ["-y", "vercel"], label: "npx vercel" };
    } catch {
      throw new Error("Vercel CLI not found. Install with `npm i -g vercel` or ensure `npx` is available.");
    }
  }
}

async function ensureVercelAuthenticated(
  projectRoot: string,
  cli: { command: string; baseArgs: string[] }
): Promise<void> {
  try {
    await execAsync(`${cli.command} ${[...cli.baseArgs, "whoami"].join(" ")}`, { cwd: projectRoot });
  } catch {
    throw new Error("Vercel CLI is not authenticated. Run `vercel login` and try again.");
  }
}

async function runVercelDeploy(
  projectRoot: string,
  cli: { command: string; baseArgs: string[]; label: string },
  logger: DeployLogger
): Promise<CommandResult> {
  logger(`[AI Deploy] Using CLI: ${cli.label}`);
  const result = await runStreamingCommand(
    projectRoot,
    cli.command,
    [...cli.baseArgs, "--prod", "--yes"],
    logger,
    5 * 60 * 1000
  );
  return {
    success: result.success,
    output: `[AI Deploy] Using CLI: ${cli.label}\n${result.output}`
  };
}
