import { DetectionResult } from "../types";

export type DeploymentTarget = "railway" | "vercel" | "fly" | "tunnel";

export interface DeploymentStrategy {
  category: "frontend" | "backend" | "fullstack";
  primaryTarget: DeploymentTarget;
  fallbackTarget?: DeploymentTarget;
  rationale: string;
}

export function buildDeploymentStrategy(detection: DetectionResult): DeploymentStrategy {
  if (detection.projectType === "react" || detection.projectType === "vite") {
    return {
      category: "frontend",
      primaryTarget: "vercel",
      fallbackTarget: "fly",
      rationale: `${detection.framework} frontend → Vercel (free).`
    };
  }

  if (detection.projectType === "next" || detection.projectType === "nuxt") {
    return {
      category: "frontend",
      primaryTarget: "vercel",
      fallbackTarget: "fly",
      rationale: `${detection.framework} → Vercel (free) with Fly fallback.`
    };
  }

  if (detection.projectType === "fullstack") {
    return {
      category: "fullstack",
      primaryTarget: "fly",
      fallbackTarget: "tunnel",
      rationale: "Fullstack: backend on Fly.io if billing allows, otherwise a free Cloudflare tunnel. Frontend on Vercel."
    };
  }

  return {
    category: "backend",
    primaryTarget: "fly",
    fallbackTarget: "tunnel",
    rationale: "Backend tries Fly.io, then a free Cloudflare tunnel if Fly/Railway require a card."
  };
}

export function collectDeployTargets(
  detection: DetectionResult,
  workspaceRoot: string
): Array<{ root: string; target: DeploymentTarget; label: string }> {
  if (detection.layout.kind === "monorepo" && detection.layout.backendRoot && detection.layout.frontendRoot) {
    return [
      {
        root: detection.layout.backendRoot,
        target: "fly",
        label: "backend"
      },
      {
        root: detection.layout.frontendRoot,
        target: "vercel",
        label: "frontend"
      }
    ];
  }

  const strategy = buildDeploymentStrategy(detection);
  return [
    {
      root: workspaceRoot,
      target: strategy.primaryTarget,
      label: strategy.category
    }
  ];
}
