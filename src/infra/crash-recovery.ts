/**
 * Crash Recovery Module
 *
 * Analyzes crash history on startup and spawns diagnosis agents
 * when patterns are detected.
 *
 * Features:
 * - Parses stderr log for uncaught exceptions
 * - Clusters errors by signature (message + stack)
 * - Spawns sub-agent for diagnosis when threshold reached
 * - Tracks fix attempts and success rate
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

interface CrashEntry {
  timestamp: string;
  errorType: string;
  message: string;
  stackSignature: string;
  fullStack: string;
}

interface CrashCluster {
  signature: string;
  count: number;
  lastSeen: string;
  entries: CrashEntry[];
}

interface CrashRecoveryConfig {
  stderrLogPath: string;
  stateDir: string;
  minCrashesForDiagnosis: number;
  windowMs: number;
  enabled: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: CrashRecoveryConfig = {
  stderrLogPath: "/var/log/opencore.err.log",
  stateDir: path.join(homedir(), ".openclaw", "crash-recovery"),
  minCrashesForDiagnosis: 2,
  windowMs: 30 * 60 * 1000, // 30 minutes
  enabled: true,
};

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse stderr log for uncaught exceptions.
 */
export function parseStderrLog(logPath: string): CrashEntry[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n");
  const entries: CrashEntry[] = [];

  let currentEntry: Partial<CrashEntry> | null = null;
  let stackLines: string[] = [];

  for (const line of lines) {
    // Match timestamp and uncaught exception
    const uncaughtMatch = line.match(
      /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[openclaw\]\s+Uncaught exception:\s+(\w+):\s+(.+)$/,
    );

    if (uncaughtMatch) {
      // Save previous entry if exists
      if (currentEntry && currentEntry.timestamp) {
        currentEntry.fullStack = stackLines.join("\n");
        currentEntry.stackSignature = extractStackSignature(stackLines);
        entries.push(currentEntry as CrashEntry);
      }

      // Start new entry
      currentEntry = {
        timestamp: uncaughtMatch[1],
        errorType: uncaughtMatch[2],
        message: uncaughtMatch[3],
      };
      stackLines = [line];
      continue;
    }

    // Collect stack trace lines
    if (currentEntry && line.match(/^\s+at\s+/)) {
      stackLines.push(line);
    }
  }

  // Save last entry
  if (currentEntry && currentEntry.timestamp) {
    currentEntry.fullStack = stackLines.join("\n");
    currentEntry.stackSignature = extractStackSignature(stackLines);
    entries.push(currentEntry as CrashEntry);
  }

  return entries;
}

/**
 * Extract a signature from stack trace (top 3 frames).
 */
function extractStackSignature(stackLines: string[]): string {
  const frames = stackLines
    .filter((l) => l.match(/^\s+at\s+/))
    .slice(0, 3)
    .map((l) => {
      // Extract function/location from "at X (file:line:col)" or "at file:line:col"
      const match = l.match(/at\s+(?:(\S+)\s+)?[[(]?([^)\]]+)/);
      if (match) {
        const func = match[1] || "anonymous";
        const loc = match[2].replace(/.*node_modules\//, "node_modules/").replace(/:\d+:\d+$/, "");
        return `${func}@${loc}`;
      }
      return l.trim();
    });

  return frames.join(" <- ");
}

/**
 * Cluster crashes by error signature.
 */
export function clusterCrashes(entries: CrashEntry[], windowMs: number): CrashCluster[] {
  const now = Date.now();
  const cutoff = now - windowMs;

  // Filter to recent entries
  const recent = entries.filter((e) => new Date(e.timestamp).getTime() > cutoff);

  // Group by signature
  const clusters = new Map<string, CrashCluster>();

  for (const entry of recent) {
    // Create signature from error type + message pattern + stack
    const msgPattern = entry.message.replace(/['"].*?['"]/g, "'...'").slice(0, 100);
    const sig = `${entry.errorType}:${msgPattern}::${entry.stackSignature}`;

    const existing = clusters.get(sig);
    if (existing) {
      existing.count++;
      existing.entries.push(entry);
      if (entry.timestamp > existing.lastSeen) {
        existing.lastSeen = entry.timestamp;
      }
    } else {
      clusters.set(sig, {
        signature: sig,
        count: 1,
        lastSeen: entry.timestamp,
        entries: [entry],
      });
    }
  }

  return Array.from(clusters.values()).toSorted((a, b) => b.count - a.count);
}

// ============================================================================
// Diagnosis Agent
// ============================================================================

/**
 * Build prompt for diagnosis agent.
 */
export function buildDiagnosisPrompt(cluster: CrashCluster): string {
  const example = cluster.entries[0];

  return `# OpenCore Crash Diagnosis

## Problem
OpenCore has crashed ${cluster.count} times with the same error pattern in the last 30 minutes.

## Error Details
- **Type:** ${example.errorType}
- **Message:** ${example.message}
- **First seen:** ${cluster.entries[0].timestamp}
- **Last seen:** ${cluster.lastSeen}

## Stack Trace
\`\`\`
${example.fullStack}
\`\`\`

## Stack Signature
\`\`\`
${cluster.signature}
\`\`\`

## Your Task
1. Identify the root cause of this error
2. Find the relevant source file(s) mentioned in the stack trace
3. Implement a fix that prevents this crash
4. Rebuild with \`cd /home/clawdbot/opencore && pnpm build\`
5. Report what you fixed

## Key Files
- Check files in the stack trace
- Error handlers: \`src/index.ts\`, \`src/cli/run-main.ts\`, \`src/infra/unhandled-rejections.ts\`
- If it's a library bug (node_modules), add error handling in our code

## Important
- Focus on making the system resilient, not just fixing the immediate bug
- If you can't fix it, explain what you found and what needs manual attention
`;
}

/**
 * Spawn a diagnosis sub-agent (using sessions_spawn internally).
 */
export async function spawnDiagnosisAgent(
  cluster: CrashCluster,
  api: { spawnSubagent?: (task: string, opts?: any) => Promise<any>; logger?: any },
): Promise<void> {
  const prompt = buildDiagnosisPrompt(cluster);

  if (api.spawnSubagent) {
    api.logger?.info?.(`crash-recovery: spawning diagnosis agent for ${cluster.count} crashes`);

    await api.spawnSubagent(prompt, {
      label: `Crash Diagnosis: ${cluster.entries[0].errorType}`,
      thinking: "high",
      runTimeoutSeconds: 900,
    });
  } else {
    api.logger?.warn?.("crash-recovery: spawnSubagent not available, logging context only");
    console.log("[crash-recovery] Diagnosis prompt:\n", prompt);
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run crash recovery analysis on startup.
 */
export async function runCrashRecoveryCheck(
  config: Partial<CrashRecoveryConfig> = {},
  api: { spawnSubagent?: (task: string, opts?: any) => Promise<any>; logger?: any } = {},
): Promise<{ analyzed: number; clusters: number; diagnosisSpawned: boolean }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { analyzed: 0, clusters: 0, diagnosisSpawned: false };
  }

  // Ensure state dir exists
  if (!fs.existsSync(cfg.stateDir)) {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
  }

  // Parse crash log
  const entries = parseStderrLog(cfg.stderrLogPath);
  api.logger?.info?.(`crash-recovery: parsed ${entries.length} crash entries`);

  if (entries.length === 0) {
    return { analyzed: 0, clusters: 0, diagnosisSpawned: false };
  }

  // Cluster by signature
  const clusters = clusterCrashes(entries, cfg.windowMs);
  api.logger?.info?.(`crash-recovery: found ${clusters.length} crash clusters`);

  // Find clusters that need diagnosis
  const needsDiagnosis = clusters.filter((c) => c.count >= cfg.minCrashesForDiagnosis);

  if (needsDiagnosis.length === 0) {
    return { analyzed: entries.length, clusters: clusters.length, diagnosisSpawned: false };
  }

  // Spawn diagnosis for the worst cluster
  const worst = needsDiagnosis[0];
  api.logger?.info?.(
    `crash-recovery: cluster with ${worst.count} crashes needs diagnosis: ${worst.entries[0].errorType}`,
  );

  await spawnDiagnosisAgent(worst, api);

  return { analyzed: entries.length, clusters: clusters.length, diagnosisSpawned: true };
}

// ============================================================================
// Exports
// ============================================================================

export { CrashEntry, CrashCluster, CrashRecoveryConfig };
