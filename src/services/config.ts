import * as vscode from "vscode";

export interface AiDeployConfig {
  maxRetries: number;
  useAiAnalysis: boolean;
  openAiApiKey: string;
  openAiBaseUrl: string;
  openAiModel: string;
  runLocalBuildFirst: boolean;
  autoRetryAfterFix: boolean;
}

export function getAiDeployConfig(): AiDeployConfig {
  const config = vscode.workspace.getConfiguration("aiDeploy");
  return {
    maxRetries: Math.max(1, config.get<number>("maxRetries", 5)),
    useAiAnalysis: config.get<boolean>("useAiAnalysis", true),
    openAiApiKey: config.get<string>("openAiApiKey", "").trim(),
    openAiBaseUrl: config.get<string>("openAiBaseUrl", "https://api.openai.com/v1").replace(/\/$/, ""),
    openAiModel: config.get<string>("openAiModel", "gpt-4o-mini"),
    runLocalBuildFirst: config.get<boolean>("runLocalBuildFirst", true),
    autoRetryAfterFix: config.get<boolean>("autoRetryAfterFix", true)
  };
}
