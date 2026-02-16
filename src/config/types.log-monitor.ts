export type AgentDispatchConfig = {
  /** Enable agent dispatch for unresolved issues. Default: false. */
  enabled?: boolean;
  /** Agent timeout in seconds. Default: 300. */
  timeoutSeconds?: number;
  /** Model for healing agents. Default: inherits from agents.defaults.subagents.model. */
  model?: string;
  /** Thinking level for healing agents. Default: "high". */
  thinking?: string;
  /** Max concurrent healing agents. Default: 2. */
  maxConcurrent?: number;
  /** Minimum seconds between agent spawns for the same issue signature. Default: 3600 (1hr). */
  cooldownSeconds?: number;
  /** Max agent spawns per hour across all issues. Default: 5. */
  maxSpawnsPerHour?: number;
  /** Agent ID to use for healing sessions. Default: "system". */
  agentId?: string;
};

export type LogMonitorConfig = {
  enabled?: boolean;
  /** Scan interval in milliseconds. Default: 60000. */
  intervalMs?: number;
  /** Maximum log lines to read per scan cycle. Default: 500. */
  maxLinesPerScan?: number;
  /** Time window for deduplicating surfaced issues (ms). Default: 1800000 (30 min). */
  dedupeWindowMs?: number;
  /** Minimum occurrences before surfacing an issue. Default: 2. */
  minOccurrences?: number;
  /** Allow auto-resolution of known issue patterns. Default: true. */
  autoResolve?: boolean;
  /** Run crash recovery analysis on startup. Default: true. */
  crashRecovery?: boolean;
  /** Agent dispatch configuration for self-healing. */
  agentDispatch?: AgentDispatchConfig;
};
