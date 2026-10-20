import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DetectionResult } from "../types";

export async function resolveNpmInstallCommand(projectRoot?: string): Promise<string> {
  if (!projectRoot) {
    return "npm install";
  }

  try {
    await fs.access(path.join(projectRoot, "package-lock.json"));
    return "npm ci";
  } catch {
    return "npm install";
  }
}

export async function ensureDockerfile(projectRoot: string, detection: DetectionResult): Promise<boolean> {
  const dockerfilePath = path.join(projectRoot, "Dockerfile");
  const desired = await createDockerfileContent(detection, projectRoot);

  try {
    const existing = await fs.readFile(dockerfilePath, "utf8");
    if (shouldReplaceDockerfile(existing, desired, detection)) {
      await fs.writeFile(dockerfilePath, desired, "utf8");
      await ensureDockerignore(projectRoot);
      return true;
    }
    return false;
  } catch {
    await fs.writeFile(dockerfilePath, desired, "utf8");
    await ensureDockerignore(projectRoot);
    return true;
  }
}

function shouldReplaceDockerfile(
  existing: string,
  desired: string,
  detection: DetectionResult
): boolean {
  if (existing.trim() === desired.trim()) {
    return false;
  }

  const isNest = detection.framework.toLowerCase().includes("nestjs");
  if (isNest && !existing.includes("dist/main")) {
    return true;
  }

  if (existing.includes("npm ci") && desired.includes("npm install")) {
    return true;
  }

  if (existing.includes("nest start") && !existing.includes("node dist/main")) {
    return true;
  }

  return false;
}

export async function createDockerfileContent(
  detection: DetectionResult,
  projectRoot?: string
): Promise<string> {
  const installCmd = await resolveNpmInstallCommand(projectRoot);
  const prodInstallCmd = installCmd === "npm ci" ? "npm ci --omit=dev" : "npm install --omit=dev";
  const isNest = detection.framework.toLowerCase().includes("nestjs");

  if (isNest || detection.framework === "nestjs") {
    return [
      "FROM node:20-alpine AS build",
      "WORKDIR /app",
      "COPY package*.json ./",
      `RUN ${installCmd}`,
      "COPY . .",
      "RUN npm run build",
      "",
      "FROM node:20-alpine",
      "WORKDIR /app",
      "ENV NODE_ENV=production",
      "COPY package*.json ./",
      `RUN ${prodInstallCmd}`,
      "COPY --from=build /app/dist ./dist",
      "EXPOSE 3000",
      'CMD ["node", "dist/main.js"]'
    ]
      .filter((line, index, arr) => line !== "" || arr[index - 1] !== "")
      .join("\n");
  }

  const port = "${PORT:-3000}";

  if (detection.projectType === "next") {
    return [
      "FROM node:20-alpine AS base",
      "WORKDIR /app",
      "COPY package*.json ./",
      `RUN ${installCmd}`,
      "COPY . .",
      "RUN npm run build",
      "ENV NODE_ENV=production",
      "EXPOSE 3000",
      `CMD ["sh", "-c", "npm run start -- -p ${port}"]`
    ].join("\n");
  }

  if (detection.projectType === "nuxt") {
    return [
      "FROM node:20-alpine AS base",
      "WORKDIR /app",
      "COPY package*.json ./",
      `RUN ${installCmd}`,
      "COPY . .",
      "RUN npm run build",
      "ENV NODE_ENV=production",
      "ENV NITRO_HOST=0.0.0.0",
      `ENV NITRO_PORT=${port}`,
      "EXPOSE 3000",
      `CMD ["sh", "-c", "node .output/server/index.mjs"]`
    ].join("\n");
  }

  if (detection.projectType === "react" || detection.projectType === "vite") {
    return [
      "FROM node:20-alpine AS build",
      "WORKDIR /app",
      "COPY package*.json ./",
      `RUN ${installCmd}`,
      "COPY . .",
      detection.hasBuildScript ? "RUN npm run build" : "",
      "",
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      `RUN ${prodInstallCmd}`,
      "COPY --from=build /app/dist ./dist",
      "COPY --from=build /app/build ./build",
      "ENV NODE_ENV=production",
      "EXPOSE 3000",
      detection.hasStartScript
        ? `CMD ["sh", "-c", "npm run start"]`
        : `CMD ["sh", "-c", "npx serve -s dist -l ${port} || npx serve -s build -l ${port}"]`
    ]
      .filter((line, index, arr) => line !== "" || arr[index - 1] !== "")
      .join("\n");
  }

  if (detection.projectType === "fullstack") {
    return [
      "FROM node:20-alpine AS build",
      "WORKDIR /app",
      "COPY package*.json ./",
      `RUN ${installCmd}`,
      "COPY . .",
      detection.hasBuildScript ? "RUN npm run build" : "",
      "",
      "FROM node:20-alpine",
      "WORKDIR /app",
      "ENV NODE_ENV=production",
      "COPY package*.json ./",
      `RUN ${prodInstallCmd}`,
      "COPY . .",
      detection.hasBuildScript ? "COPY --from=build /app/dist ./dist" : "",
      detection.hasBuildScript ? "COPY --from=build /app/build ./build" : "",
      "EXPOSE 3000",
      `CMD ["sh", "-c", "${detection.hasStartScript ? "npm run start:prod || npm run start" : "node server.js"}"]`
    ]
      .filter((line, index, arr) => line !== "" || arr[index - 1] !== "")
      .join("\n");
  }

  const runCommand = resolveNodeRunCommand(detection);
  return [
    "FROM node:20-alpine",
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "COPY package*.json ./",
    `RUN ${installCmd}`,
    "COPY . .",
    detection.hasBuildScript ? "RUN npm run build" : "",
    "EXPOSE 3000",
    `CMD ["sh", "-c", "${runCommand}"]`
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveNodeRunCommand(detection: DetectionResult): string {
  if (detection.framework.toLowerCase().includes("nestjs")) {
    return "node dist/main.js";
  }
  if (detection.hasStartScript) {
    return "npm run start:prod || npm run start";
  }
  return "node dist/main.js || node dist/index.js || node index.js || node server.js";
}

async function ensureDockerignore(projectRoot: string): Promise<void> {
  const dockerignorePath = path.join(projectRoot, ".dockerignore");
  try {
    await fs.access(dockerignorePath);
  } catch {
    const defaultDockerIgnore = [
      "node_modules",
      "npm-debug.log",
      ".git",
      ".github",
      ".vscode",
      "dist",
      "build",
      "coverage",
      "test",
      ".env*"
    ].join("\n");

    await fs.writeFile(dockerignorePath, defaultDockerIgnore, "utf8");
  }
}
