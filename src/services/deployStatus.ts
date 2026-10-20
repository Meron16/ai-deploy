import * as vscode from "vscode";

let statusBarItem: vscode.StatusBarItem | undefined;

export function startDeployStatus(message: string): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  }
  statusBarItem.text = `$(rocket) AI Deploy: ${message}`;
  statusBarItem.show();
}

export function updateDeployStatus(message: string): void {
  if (statusBarItem) {
    statusBarItem.text = `$(rocket) AI Deploy: ${message}`;
  }
}

export function finishDeployStatus(success: boolean, message?: string): void {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = success
    ? `$(check) AI Deploy: ${message ?? "Success"}`
    : `$(error) AI Deploy: ${message ?? "Failed"}`;
  setTimeout(() => statusBarItem?.hide(), success ? 15000 : 30000);
}
