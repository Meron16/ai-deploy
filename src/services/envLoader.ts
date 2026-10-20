import * as fs from "node:fs/promises";
import * as path from "node:path";

const ENV_FILE_NAMES = [".env", ".env.local", ".env.production"];

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    let body = line;
    if (body.startsWith("export ")) {
      body = body.slice("export ".length).trim();
    }

    const eqIndex = body.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = body.slice(0, eqIndex).trim();
    let value = body.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    value = value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");

    if (key.length > 0) {
      result[key] = value;
    }
  }

  return result;
}

export async function loadProjectEnvVars(
  deployRoot: string,
  workspaceRoot?: string
): Promise<{ vars: Record<string, string>; sources: string[] }> {
  const merged: Record<string, string> = {};
  const sources: string[] = [];
  const roots =
    workspaceRoot && path.resolve(workspaceRoot) !== path.resolve(deployRoot)
      ? [workspaceRoot, deployRoot]
      : [deployRoot];

  for (const root of roots) {
    for (const fileName of ENV_FILE_NAMES) {
      const filePath = path.join(root, fileName);
      try {
        const content = await fs.readFile(filePath, "utf8");
        Object.assign(merged, parseEnvFile(content));
        sources.push(filePath);
      } catch {
        // file not present
      }
    }
  }

  return { vars: merged, sources };
}

export function formatEnvKeySummary(vars: Record<string, string>): string {
  const keys = Object.keys(vars);
  if (keys.length === 0) {
    return "none";
  }
  const preview = keys.slice(0, 8).join(", ");
  return keys.length > 8 ? `${preview}, +${keys.length - 8} more` : preview;
}

export function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    normalized.includes("SECRET") ||
    normalized.includes("PASSWORD") ||
    normalized.includes("TOKEN") ||
    normalized.includes("KEY") ||
    normalized.includes("DATABASE") ||
    normalized.includes("PRIVATE")
  );
}
