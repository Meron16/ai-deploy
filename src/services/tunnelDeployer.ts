import { spawn } from "node:child_process";
import { CommandResult, DeployLogger } from "../types";
import { runCommand } from "./commandRunner";

export async function deployWithTunnel(
  projectRoot: string,
  logger: DeployLogger
): Promise<CommandResult> {
  logger("[AI Deploy] Paid cloud hosts blocked — publishing backend with a free Cloudflare tunnel");

  await runCommand(projectRoot, "npm run build", logger, { optional: true, timeoutMs: 10 * 60 * 1000 });

  const startCmd = "npm run start:prod || npm run start";

  logger(`[AI Deploy] Starting API locally: ${startCmd}`);
  const server = spawn(startCmd, {
    cwd: projectRoot,
    shell: true,
    env: { ...process.env, PORT: process.env.PORT ?? "3000", NODE_ENV: "production" }
  });

  let serverLog = "";
  server.stdout.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
    logger(chunk.toString().trimEnd());
  });
  server.stderr.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
    logger(chunk.toString().trimEnd());
  });

  await sleep(8000);

  logger("[AI Deploy] Opening Cloudflare quick tunnel (no credit card)...");
  const tunnel = spawn("npx -y cloudflared tunnel --url http://localhost:3000", {
    cwd: projectRoot,
    shell: true
  });

  return new Promise((resolve) => {
    let output = serverLog;
    let resolved = false;

    const finish = (result: CommandResult): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        success: false,
        output: `${output}\nTimed out waiting for Cloudflare tunnel URL. Install cloudflared or check that port 3000 started.`
      });
    }, 120000);

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      logger(text.trimEnd());
      const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      if (url) {
        logger(`[AI Deploy] Public backend URL (tunnel): ${url}`);
        logger("[AI Deploy] Keep this terminal open. Closing it stops the public URL.");
        finish({
          success: true,
          output: `${output}\n${url}\nBackend is live via Cloudflare tunnel. Leave the AI Deploy terminal open.`
        });
      }
    };

    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);
    tunnel.on("error", (error) => {
      finish({ success: false, output: `${output}\n${error.message}` });
    });
    tunnel.on("close", (code) => {
      if (!resolved) {
        finish({
          success: false,
          output: `${output}\ncloudflared exited (${code ?? "unknown"}).`
        });
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
