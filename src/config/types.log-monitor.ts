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
};
