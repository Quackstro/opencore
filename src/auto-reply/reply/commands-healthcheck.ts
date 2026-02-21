import type { CommandHandler } from "./commands-types.js";
import { logVerbose } from "../../globals.js";

const COMMAND = "/healthcheck";

type ParsedHealthcheckCommand =
  | { ok: true; action: "run"; deep: boolean }
  | { ok: true; action: "fix" }
  | { ok: false; error: string };

function parseHealthcheckCommand(raw: string): ParsedHealthcheckCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim().toLowerCase();

  if (!rest || rest === "run") {
    return { ok: true, action: "run", deep: false };
  }
  if (rest === "deep") {
    return { ok: true, action: "run", deep: true };
  }
  if (rest === "fix") {
    return { ok: true, action: "fix" };
  }

  return {
    ok: false,
    error:
      "🛡️ **Host Security Healthcheck**\n\n" +
      "**Commands:**\n" +
      "• `/healthcheck` — run security audit\n" +
      "• `/healthcheck deep` — include live gateway probe\n" +
      "• `/healthcheck fix` — apply safe remediations (file permissions, defaults)",
  };
}

export const handleHealthcheckCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseHealthcheckCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /healthcheck from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  try {
    if (parsed.action === "fix") {
      return await runHealthcheckFix();
    }
    return await runHealthcheckAudit(parsed.deep);
  } catch (err) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Healthcheck failed: ${String(err)}` },
    };
  }
};

async function runHealthcheckAudit(deep: boolean) {
  const { loadConfig } = await import("../../config/config.js");
  const { runSecurityAudit } = await import("../../security/audit.js");

  const cfg = loadConfig();
  const report = await runSecurityAudit({
    config: cfg,
    deep,
    includeFilesystem: true,
    includeChannelSecurity: true,
  });

  const { summary, findings } = report;
  const total = summary.critical + summary.warn + summary.info;

  // Header with status
  const statusEmoji = summary.critical > 0 ? "🔴" : summary.warn > 0 ? "🟡" : "🟢";
  const lines: string[] = [
    `${statusEmoji} **Host Security Healthcheck**`,
    "",
    `**${summary.critical}** critical · **${summary.warn}** warnings · **${summary.info}** info`,
    "",
  ];

  // Group findings by severity
  const criticals = findings.filter((f) => f.severity === "critical");
  const warns = findings.filter((f) => f.severity === "warn");
  const infos = findings.filter((f) => f.severity === "info");

  if (criticals.length > 0) {
    lines.push("**🔴 Critical:**");
    for (const f of criticals) {
      lines.push(`• \`${f.checkId}\` ${f.title}`);
      if (f.remediation) {
        lines.push(`  _Fix: ${f.remediation}_`);
      }
    }
    lines.push("");
  }

  if (warns.length > 0) {
    lines.push("**🟡 Warnings:**");
    for (const f of warns) {
      lines.push(`• \`${f.checkId}\` ${f.title}`);
    }
    lines.push("");
  }

  if (infos.length > 0) {
    lines.push(`**ℹ️ Info** (${infos.length} items):`);
    // Only show first 5 info items to avoid spam
    for (const f of infos.slice(0, 5)) {
      lines.push(`• ${f.title}`);
    }
    if (infos.length > 5) {
      lines.push(`_...and ${infos.length - 5} more_`);
    }
    lines.push("");
  }

  // Deep probe results
  if (deep && report.deep?.gateway) {
    const gw = report.deep.gateway;
    const gwStatus = gw.ok ? "✅ reachable" : `❌ ${gw.error ?? "unreachable"}`;
    lines.push(`**Gateway probe:** ${gwStatus}`);
    if (gw.url) {
      lines.push(`  URL: \`${gw.url}\``);
    }
    lines.push("");
  }

  if (total === 0) {
    lines.push("✅ No findings — looking good!");
  }

  // Truncate for Telegram 4096 char limit
  let text = lines.join("\n");
  if (text.length > 3800) {
    text = text.slice(0, 3800) + "\n\n_(truncated)_";
  }

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  if (!deep) {
    buttons.push([{ text: "🔍 Deep Scan", callback_data: "/healthcheck deep" }]);
  }
  if (summary.critical > 0 || summary.warn > 0) {
    buttons.push([{ text: "🔧 Auto-Fix Safe Issues", callback_data: "/healthcheck fix" }]);
  }

  return {
    shouldContinue: false,
    reply: {
      text,
      channelData: buttons.length > 0 ? { telegram: { buttons } } : undefined,
    },
  };
}

async function runHealthcheckFix() {
  const { fixSecurityFootguns } = await import("../../security/fix.js");
  const { loadConfig } = await import("../../config/config.js");
  const { runSecurityAudit } = await import("../../security/audit.js");

  const fixResult = await fixSecurityFootguns().catch(() => null);

  // Re-run audit after fix to show new state
  const cfg = loadConfig();
  const report = await runSecurityAudit({
    config: cfg,
    deep: false,
    includeFilesystem: true,
    includeChannelSecurity: true,
  });

  const lines: string[] = ["🔧 **Security Fix Applied**", ""];

  if (fixResult) {
    const changes = Object.entries(fixResult).filter(
      ([, v]) => v && typeof v === "object" && "changed" in v && v.changed,
    );
    if (changes.length > 0) {
      lines.push(`**${changes.length} item(s) fixed:**`);
      for (const [key] of changes) {
        lines.push(`• ✅ ${key}`);
      }
    } else {
      lines.push("No changes needed — already secure.");
    }
  } else {
    lines.push("⚠️ Fix returned no results.");
  }

  lines.push("");
  const { summary } = report;
  const statusEmoji = summary.critical > 0 ? "🔴" : summary.warn > 0 ? "🟡" : "🟢";
  lines.push(
    `${statusEmoji} **Post-fix:** ${summary.critical} critical · ${summary.warn} warnings · ${summary.info} info`,
  );

  return {
    shouldContinue: false,
    reply: { text: lines.join("\n") },
  };
}
