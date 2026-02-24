// @openclaw-fork: KEEP OURS on merge — contains deferred-kill fix for deploy race condition.
// See: fix(deploy): defer kill to after reply delivery (commit 9eb6a194e)
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CommandHandler } from "./commands-types.js";
import { logVerbose } from "../../globals.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";

const execAsync = promisify(exec);

const COMMAND = "/deploy";

type ParsedDeployCommand =
  | { ok: true; action: "restart" }
  | { ok: true; action: "confirm_restart" }
  | { ok: true; action: "status" }
  | { ok: true; action: "skip" }
  | { ok: false; error: string };

function parseDeployCommand(raw: string): ParsedDeployCommand | null {
  const trimmed = raw.trim();

  // Handle button callbacks
  if (trimmed === "/deploy_upstream" || trimmed === "/deploy_restart") {
    return { ok: true, action: "confirm_restart" };
  }
  if (trimmed === "/deploy_confirm") {
    return { ok: true, action: "restart" };
  }
  if (trimmed === "/skip_deploy") {
    return { ok: true, action: "skip" };
  }

  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }

  const rest = trimmed.slice(COMMAND.length).trim();

  if (!rest || rest === "restart" || rest === "now") {
    return { ok: true, action: "restart" };
  }
  if (rest === "status") {
    return { ok: true, action: "status" };
  }
  if (rest === "skip" || rest === "no" || rest === "cancel") {
    return { ok: true, action: "skip" };
  }

  return {
    ok: false,
    error: "Usage: /deploy [restart|status|skip]",
  };
}

async function getDeployStatus(): Promise<{
  gatewayPid: number | null;
  gatewayStartedAt: string | null;
  lastBuildAt: string | null;
  buildNewerThanGateway: boolean;
}> {
  let gatewayPid: number | null = null;
  let gatewayStartedAt: string | null = null;
  let lastBuildAt: string | null = null;
  let buildNewerThanGateway = false;

  try {
    const { stdout: pidOut } = await execAsync("pgrep -f openclaw-gateway");
    gatewayPid = parseInt(pidOut.trim().split("\n")[0], 10) || null;
    if (gatewayPid) {
      const { stdout: lstart } = await execAsync(`ps -o lstart= -p ${gatewayPid}`);
      gatewayStartedAt = lstart.trim();
    }
  } catch {
    // gateway not running
  }

  try {
    const { stdout: buildTime } = await execAsync(
      `stat -c '%Y' /home/clawdbot/opencore/dist/openclaw.js 2>/dev/null || stat -c '%Y' /home/clawdbot/opencore/dist/*.js | sort -n | tail -1`,
    );
    const buildEpoch = parseInt(buildTime.trim(), 10);
    lastBuildAt = new Date(buildEpoch * 1000).toISOString();

    if (gatewayPid && gatewayStartedAt) {
      const gwEpoch = new Date(gatewayStartedAt).getTime() / 1000;
      buildNewerThanGateway = buildEpoch > gwEpoch;
    }
  } catch {
    // no build found
  }

  return {
    gatewayPid,
    gatewayStartedAt,
    lastBuildAt,
    buildNewerThanGateway,
  };
}

export const handleDeployCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseDeployCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  const { action } = parsed;

  if (action === "skip") {
    logVerbose("[deploy] Skip acknowledged");
    return { shouldContinue: false, reply: { text: "⏭️ Deploy skipped." } };
  }

  if (action === "status") {
    const status = await getDeployStatus();
    const lines: string[] = ["**Deploy Status**"];

    if (status.gatewayPid) {
      lines.push(`• Gateway PID: ${status.gatewayPid}`);
      lines.push(`• Started: ${status.gatewayStartedAt}`);
    } else {
      lines.push("• Gateway: **not running**");
    }

    if (status.lastBuildAt) {
      lines.push(`• Last build: ${status.lastBuildAt}`);
    }

    if (status.buildNewerThanGateway) {
      lines.push("\n⚠️ **Build is newer than running gateway.** Restart recommended.");
      return {
        shouldContinue: false,
        reply: {
          text: lines.join("\n"),
          channelData: {
            telegram: {
              buttons: [
                [
                  { text: "🚀 Deploy & Restart", callback_data: "/deploy_restart" },
                  { text: "⏭️ Skip", callback_data: "/skip_deploy" },
                ],
              ],
            },
          },
        },
      };
    }

    lines.push("\n✅ Gateway is running the latest build.");
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (action === "confirm_restart") {
    const status = await getDeployStatus();
    const lines: string[] = ["⚠️ **Confirm Gateway Restart?**"];
    if (status.gatewayPid) {
      lines.push(`• Running PID: ${status.gatewayPid} (started ${status.gatewayStartedAt})`);
    }
    if (status.buildNewerThanGateway) {
      lines.push("• Build is newer than running gateway");
    }
    lines.push("\nThis will briefly take the gateway offline.");
    return {
      shouldContinue: false,
      reply: {
        text: lines.join("\n"),
        channelData: {
          telegram: {
            buttons: [
              [
                { text: "✅ Confirm Restart", callback_data: "/deploy_confirm" },
                { text: "❌ Cancel", callback_data: "/skip_deploy" },
              ],
            ],
          },
        },
      },
    };
  }

  if (action === "restart") {
    logVerbose("[deploy] Initiating gateway restart");

    try {
      await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: params.sessionKey,
        deliveryContext: {
          channel: params.command.channel || undefined,
          to: params.command.to || params.command.senderId || undefined,
        },
        message: "✅ **Deploy complete.** Gateway restarted successfully.",
      });

      // Defer the kill so the reply has time to flush to the channel.
      // The handler returns the reply first; the process dies ~2s later.
      setTimeout(() => {
        execAsync("kill $(pgrep -f openclaw-gateway) 2>/dev/null || true")
          .then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
          .then(() => execAsync("openclaw gateway start").catch(() => {}))
          .catch(() => {});
      }, 2000);

      return {
        shouldContinue: false,
        reply: {
          text: "🚀 **Deploying...** Gateway restarting with latest build. Back in a few seconds.",
        },
      };
    } catch (err) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Deploy failed: ${String(err)}` },
      };
    }
  }

  return null;
};
