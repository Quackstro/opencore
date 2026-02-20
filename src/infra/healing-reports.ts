/**
 * Healing Report Persistence
 *
 * Stores healing agent triage reports on disk so they survive restarts
 * and can be recalled, dismissed, or resurfaced.
 */

import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface HealingReport {
  id: string;
  issueSignature: string;
  severity: "low" | "medium" | "high";
  success: boolean;
  /** Short TL;DR (first 2 sentences or ~200 chars) */
  tldr: string;
  /** Full agent output */
  fullReport: string;
  /** Whether the agent proposed a concrete fix */
  hasFix: boolean;
  /** The proposed fix description, if any */
  fixDescription?: string;
  /** ISO timestamp of completion */
  completedAt: string;
  /** Whether user has acknowledged/dismissed this report */
  acknowledged: boolean;
  /** Session key of the healing agent */
  childSessionKey: string;
  /** Session key of the requester */
  requesterSessionKey: string;
  /** Delivery context for resurfacing */
  delivery?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
}

// ============================================================================
// Storage
// ============================================================================

const REPORTS_DIR = path.join(
  process.env.OPENCLAW_HOME ?? path.join(process.env.HOME ?? "/tmp", ".openclaw"),
  "healing-reports",
);

function ensureDir(): void {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function reportPath(id: string): string {
  return path.join(REPORTS_DIR, `${id}.json`);
}

/** Save a healing report to disk. */
export function saveReport(report: HealingReport): void {
  ensureDir();
  fs.writeFileSync(reportPath(report.id), JSON.stringify(report, null, 2), "utf-8");
}

/** Load a report by ID. */
export function loadReport(id: string): HealingReport | null {
  try {
    const raw = fs.readFileSync(reportPath(id), "utf-8");
    return JSON.parse(raw) as HealingReport;
  } catch {
    return null;
  }
}

/** Acknowledge (dismiss) a report. */
export function acknowledgeReport(id: string): boolean {
  const report = loadReport(id);
  if (!report) {
    return false;
  }
  report.acknowledged = true;
  saveReport(report);
  return true;
}

/** Get all unacknowledged reports. */
export function getUnacknowledgedReports(): HealingReport[] {
  ensureDir();
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json"));
  const reports: HealingReport[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(REPORTS_DIR, file), "utf-8");
      const report = JSON.parse(raw) as HealingReport;
      if (!report.acknowledged) {
        reports.push(report);
      }
    } catch {
      // skip corrupt files
    }
  }
  // Sort newest first
  reports.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
  return reports;
}

/** Get all reports (both acknowledged and unacknowledged), newest first. */
export function getAllReports(opts?: { limit?: number }): HealingReport[] {
  ensureDir();
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json"));
  const reports: HealingReport[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(REPORTS_DIR, file), "utf-8");
      reports.push(JSON.parse(raw) as HealingReport);
    } catch {
      // skip corrupt files
    }
  }
  reports.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
  if (opts?.limit && opts.limit > 0) {
    return reports.slice(0, opts.limit);
  }
  return reports;
}

/** Clean up old acknowledged reports (older than N days). */
export function pruneOldReports(maxAgeDays = 7): number {
  ensureDir();
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json"));
  let pruned = 0;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(REPORTS_DIR, file), "utf-8");
      const report = JSON.parse(raw) as HealingReport;
      if (report.acknowledged && new Date(report.completedAt).getTime() < cutoff) {
        fs.unlinkSync(path.join(REPORTS_DIR, file));
        pruned++;
      }
    } catch {
      // skip
    }
  }
  return pruned;
}

// ============================================================================
// Report Extraction Helpers
// ============================================================================

/**
 * Extract a TL;DR from a full agent report.
 * Grabs the first meaningful paragraph or ~200 chars.
 */
export function extractTldr(fullReport: string): string {
  if (!fullReport || fullReport === "(no output)") {
    return "No output from healing agent.";
  }

  const lines = fullReport.split("\n").map((l) => l.trim());
  let tldr = "";
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    if (!line) {
      continue;
    }
    // Skip markdown headers, tables, horizontal rules
    if (line.startsWith("#") || line.startsWith("|") || /^[-*_]{3,}$/.test(line)) {
      continue;
    }

    const clean = line.replace(/^\*\*([^*]+)\*\*$/, "$1");
    if (tldr.length + clean.length > 250) {
      break;
    }
    tldr += (tldr ? " " : "") + clean;
  }
  return tldr || fullReport.slice(0, 200);
}

/**
 * Detect if the agent proposed a fix action.
 */
export function detectFix(fullReport: string): { hasFix: boolean; fixDescription?: string } {
  if (!fullReport) {
    return { hasFix: false };
  }
  const lower = fullReport.toLowerCase();
  const fixSignals = [
    "fix applied",
    "fixed by",
    "applied fix",
    "applied the fix",
    "restarted the",
    "restarted service",
    "resolved by",
    "patched the",
    "corrected the",
    "updated the config",
    "modified config",
    "remediation applied",
    "remediation complete",
  ];
  const hasFix = fixSignals.some((s) => lower.includes(s));
  if (!hasFix) {
    return { hasFix: false };
  }

  // Try to extract the fix description
  const lines = fullReport.split("\n");
  for (const line of lines) {
    const ll = line.toLowerCase();
    if (fixSignals.some((s) => ll.includes(s))) {
      return { hasFix: true, fixDescription: line.trim() };
    }
  }
  return { hasFix: true };
}

/**
 * Detect if the agent recommends a restart.
 */
export function detectRestartNeeded(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const restartSignals = [
    "restart required",
    "restart needed",
    "restart recommended",
    "needs a restart",
    "needs restart",
    "recommend restarting",
    "should restart",
    "requires a restart",
    "requires restart",
    "reboot required",
    "reboot needed",
  ];
  return restartSignals.some((s) => lower.includes(s));
}

// ============================================================================
// Formatted Message Builder
// ============================================================================

/**
 * Build a structured completion message with inline buttons.
 */
export function buildCompletionMessage(report: HealingReport): {
  text: string;
  buttons: Array<Array<{ text: string; callback_data: string }>>;
} {
  const statusEmoji = report.success ? "✅" : "❌";
  const statusLabel = report.success ? "Resolved" : "Failed";
  const severityEmoji =
    report.severity === "high" ? "🔴" : report.severity === "medium" ? "🟡" : "🟢";

  const sigShort =
    report.issueSignature.length > 40
      ? `${report.issueSignature.slice(0, 40)}…`
      : report.issueSignature;

  const text = [
    `${statusEmoji} **Healing Agent — ${statusLabel}**`,
    "",
    `${severityEmoji} **Issue:** \`${sigShort}\``,
    `🆔 **Report:** \`${report.id}\``,
    "",
    `**TL;DR:** ${report.tldr}`,
    ...(report.hasFix && report.fixDescription ? [`\n🔧 **Fix:** ${report.fixDescription}`] : []),
  ].join("\n");

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  const row: Array<{ text: string; callback_data: string }> = [
    { text: "📋 Full Report", callback_data: `/heal report ${report.id}` },
  ];
  if (report.hasFix) {
    row.push({ text: "🔧 Apply Fix", callback_data: `/heal apply ${report.id}` });
  }
  row.push({ text: "🗑 Dismiss", callback_data: `/heal dismiss ${report.id}` });
  buttons.push(row);

  // If fix was applied successfully, offer deploy button to restart gateway with new build
  // Show Deploy & Restart button if agent applied a fix or recommends restart
  const needsRestart = report.hasFix || detectRestartNeeded(report.fullReport ?? report.tldr);
  if (report.success && needsRestart) {
    buttons.push([
      { text: "🚀 Deploy & Restart", callback_data: "/deploy_restart" },
      { text: "⏭️ Skip Deploy", callback_data: "/skip_deploy" },
    ]);
  }

  return { text, buttons };
}
