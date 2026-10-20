import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DetectionResult, ProjectLayout } from "../types";

interface PackageJsonLike {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const BACKEND_SUBDIRS = ["backend", "server", "api", "apps/api", "apps/server", "packages/api", "packages/server"];
const FRONTEND_SUBDIRS = ["frontend", "client", "web", "apps/web", "apps/client", "packages/web", "packages/client"];

export async function detectProjectType(workspaceRoot: string): Promise<DetectionResult> {
  const layout = await detectLayout(workspaceRoot);
  const analysisRoot =
    layout.kind === "monorepo" && layout.backendRoot ? layout.backendRoot : workspaceRoot;

  const packageJsonPath = path.join(analysisRoot, "package.json");
  const packageJsonText = await fs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(packageJsonText) as PackageJsonLike;

  const fileExists = async (dir: string, fileName: string): Promise<boolean> => {
    try {
      await fs.access(path.join(dir, fileName));
      return true;
    } catch {
      return false;
    }
  };

  const dependencies = {
    ...(parsed.dependencies ?? {}),
    ...(parsed.devDependencies ?? {})
  };
  const scripts = parsed.scripts ?? {};
  const hasBuildScript = typeof scripts.build === "string";
  const hasStartScript = typeof scripts.start === "string";

  const hasReact = Boolean(dependencies.react);
  const hasVue = Boolean(dependencies.vue);
  const hasNext = Boolean(dependencies.next);
  const hasNuxt = Boolean(dependencies.nuxt);
  const hasVite = Boolean(dependencies.vite);
  const hasExpress = Boolean(dependencies.express);
  const hasFastify = Boolean(dependencies.fastify);
  const hasNest = Boolean(dependencies["@nestjs/core"]);
  const hasBackendRuntime = hasExpress || hasFastify || hasNest;

  const hasNextConfig =
    (await fileExists(analysisRoot, "next.config.js")) ||
    (await fileExists(analysisRoot, "next.config.mjs")) ||
    (await fileExists(analysisRoot, "next.config.ts"));
  const hasNuxtConfig =
    (await fileExists(analysisRoot, "nuxt.config.ts")) || (await fileExists(analysisRoot, "nuxt.config.js"));
  const hasViteConfig =
    (await fileExists(analysisRoot, "vite.config.ts")) ||
    (await fileExists(analysisRoot, "vite.config.js")) ||
    (await fileExists(analysisRoot, "vite.config.mjs"));

  if (layout.kind === "monorepo" && layout.frontendRoot && layout.backendRoot) {
    const frontendFramework = await detectFrontendFramework(layout.frontendRoot);
    const backendFramework = await detectBackendFramework(layout.backendRoot);
    return {
      projectType: "fullstack",
      framework: `${frontendFramework} + ${backendFramework}`,
      hasBuildScript: true,
      hasStartScript: true,
      layout
    };
  }

  if (hasNext || hasNextConfig) {
    return {
      projectType: "next",
      framework: "next.js",
      hasBuildScript,
      hasStartScript,
      layout
    };
  }

  if (hasNuxt || hasNuxtConfig) {
    return {
      projectType: "nuxt",
      framework: "nuxt",
      hasBuildScript,
      hasStartScript,
      layout
    };
  }

  if ((hasReact || hasVue) && hasBackendRuntime) {
    return {
      projectType: "fullstack",
      framework: hasExpress
        ? `${hasReact ? "react" : "vue"} + express`
        : hasNest
          ? `${hasReact ? "react" : "vue"} + nestjs`
          : `${hasReact ? "react" : "vue"} + fastify`,
      hasBuildScript,
      hasStartScript,
      layout
    };
  }

  if (hasVite || hasViteConfig) {
    return {
      projectType: hasBackendRuntime ? "fullstack" : "vite",
      framework: hasBackendRuntime ? `vite + ${hasExpress ? "express" : "node"}` : "vite",
      hasBuildScript,
      hasStartScript,
      layout
    };
  }

  if (hasReact) {
    return {
      projectType: "react",
      framework: "react",
      hasBuildScript,
      hasStartScript,
      layout
    };
  }

  if (hasBackendRuntime) {
    return {
      projectType: "node",
      framework: hasNest ? "nestjs" : hasFastify ? "fastify" : "express",
      hasBuildScript,
      hasStartScript,
      layout
    };
  }

  return {
    projectType: "node",
    framework: "node.js",
    hasBuildScript,
    hasStartScript,
    layout
  };
}

async function detectLayout(workspaceRoot: string): Promise<ProjectLayout> {
  const backendRoot = await findFirstPackageRoot(workspaceRoot, BACKEND_SUBDIRS);
  const frontendRoot = await findFirstPackageRoot(workspaceRoot, FRONTEND_SUBDIRS);

  if (backendRoot && frontendRoot && backendRoot !== frontendRoot) {
    return { kind: "monorepo", backendRoot, frontendRoot };
  }

  return { kind: "single" };
}

async function findFirstPackageRoot(workspaceRoot: string, subdirs: string[]): Promise<string | undefined> {
  for (const sub of subdirs) {
    const candidate = path.join(workspaceRoot, sub);
    if (await hasPackageJson(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function hasPackageJson(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "package.json"));
    return true;
  } catch {
    return false;
  }
}

async function detectFrontendFramework(frontendRoot: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(frontendRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageJsonLike;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) {
      return "next.js";
    }
    if (deps.nuxt) {
      return "nuxt";
    }
    if (deps.react) {
      return "react";
    }
    if (deps.vue) {
      return "vue";
    }
    if (deps.vite) {
      return "vite";
    }
  } catch {
    // ignore
  }
  return "frontend";
}

async function detectBackendFramework(backendRoot: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(backendRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageJsonLike;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps["@nestjs/core"]) {
      return "nestjs";
    }
    if (deps.fastify) {
      return "fastify";
    }
    if (deps.express) {
      return "express";
    }
  } catch {
    // ignore
  }
  return "node.js";
}
