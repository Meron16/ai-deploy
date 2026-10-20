export type ProjectType = "react" | "node" | "fullstack" | "next" | "nuxt" | "vite";

export interface ProjectLayout {
  kind: "single" | "monorepo";
  backendRoot?: string;
  frontendRoot?: string;
}

export interface DetectionResult {
  projectType: ProjectType;
  framework: string;
  hasBuildScript: boolean;
  hasStartScript: boolean;
  layout: ProjectLayout;
}

export interface CommandResult {
  success: boolean;
  output: string;
}

export type DeployLogger = (message: string) => void;
