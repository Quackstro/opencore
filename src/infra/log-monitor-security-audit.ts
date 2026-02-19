/**
 * Log Monitor Security Audit Collector
 *
 * Periodically runs `openclaw security audit --deep --json` and converts
 * findings into issues for the log monitor registry, so they get the same
 * triage pipeline (dedup, surfacing, auto-resolve, healing agent dispatch).
 */

import { execFile } from "node:child_process";
import type { IssueCategory } from "./log-monitor-registry.js";

// ============================================================================
// Types
// ============================================================================

export interface DiagnosticIssue {
  signature: string;
  category: IssueCategory;
  message: string;
}

type IssueCallback = (issue: DiagnosticIssue) => void;

interface AuditFinding {
  checkId: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
  remediation?: string;
}

interface AuditOutput {
  ts: string;
  summary: { critical: number; warn: number; info: number };
  findings: AuditFinding[];
}

export interface SecurityAuditCollectorOpts {
  intervalMs?: number;
  acknowledgedChecks?: string[];
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const EXEC_TIMEOUT_MS = 30_000;

function mapSeverity(severity: AuditFinding["severity"]): "high" | "medium" | "low" {
  switch (severity) {
    case "critical":
      return "high";
    case "warn":
      return "medium";
    case "info":
      return "low";
  }
}

function findingToIssue(finding: AuditFinding): DiagnosticIssue {
  const detail = finding.remediation
    ? `${finding.detail} — remediation: ${finding.remediation}`
    : finding.detail;
  return {
    signature: `security:${finding.checkId}`,
    category: "security",
    message: `[${mapSeverity(finding.severity)}] ${finding.title}: ${detail}`.slice(0, 300),
  };
}

function runAudit(): Promise<AuditOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      "openclaw",
      ["security", "audit", "--deep", "--json"],
      { timeout: EXEC_TIMEOUT_MS },
      (err, stdout, _stderr) => {
        if (err) {
          reject(new Error(`openclaw security audit failed: ${String(err.message)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as AuditOutput;
          if (!Array.isArray(parsed.findings)) {
            reject(new Error("openclaw security audit: invalid output (missing findings array)"));
            return;
          }
          resolve(parsed);
        } catch (parseErr) {
          reject(new Error(`openclaw security audit: failed to parse JSON: ${String(parseErr)}`));
        }
      },
    );
  });
}

// ============================================================================
// Collector
// ============================================================================

/**
 * Start collecting security audit findings and feeding them into the registry.
 * @returns A stop function to cancel the periodic scan.
 */
export function startSecurityAuditCollector(
  onIssue: IssueCallback,
  opts?: SecurityAuditCollectorOpts,
): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const acknowledged = new Set(opts?.acknowledgedChecks ?? []);

  async function collect(): Promise<void> {
    try {
      const output = await runAudit();
      for (const finding of output.findings) {
        // Skip acknowledged (suppressed) checks
        if (acknowledged.has(finding.checkId)) {
          continue;
        }
        // Skip info-level findings
        if (finding.severity === "info") {
          continue;
        }
        onIssue(findingToIssue(finding));
      }
    } catch {
      // Audit binary missing or failed — silently skip this cycle
    }
  }

  // Run once immediately, then on interval
  void collect();
  const timer = setInterval(() => void collect(), intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
