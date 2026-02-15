---
summary: "Background log monitoring with automatic issue detection and self-healing"
read_when:
  - You want the gateway to automatically detect and resolve recurring errors
  - You want to be notified of issues without manually watching logs
  - You want to enable crash recovery analysis on startup
title: "Log Monitor (Self-Healing)"
---

# Log Monitor (Self-Healing)

The log monitor is a background service that tails gateway logs, detects
recurring issues, auto-resolves known patterns, and surfaces actionable
issues to the user as system events — without spamming.

## Quick Start

Enable the log monitor with a single config change:

```bash
openclaw config set logMonitor.enabled true
```

That's it. The monitor will start on the next gateway restart and begin
scanning logs every 60 seconds.

## How It Works

### Scan Cycle

Every `intervalMs` (default: 60s), the monitor:

1. Reads new log lines since the last cursor position
2. Classifies lines into issue categories (network, crash, stuck-session, error)
3. Records issues in the dedup registry
4. Surfaces issues that meet the occurrence threshold and are outside the dedup window
5. Runs auto-resolution handlers for known patterns
6. Persists cursor and registry state to disk

### Issue Registry

The registry tracks every detected issue by signature (a short fingerprint
derived from the error type and message). For each signature it records:

- **Occurrences** — total count
- **Last surfaced** — when the issue was last shown to the user
- **Auto-resolve attempts** — how many times a handler tried to fix it

### Dedup Window

An issue is only surfaced when:

- It has been seen at least `minOccurrences` times (default: 2)
- It has not been surfaced within the last `dedupeWindowMs` (default: 30 min)

This prevents notification floods from high-frequency transient errors.

### Diagnostic Events

In addition to log file scanning, the monitor subscribes to real-time
diagnostic events (`session.stuck`, `webhook.error`, `message.processed`
with error outcome). These events are converted to issues and fed into
the same registry, providing immediate detection without waiting for
the next log scan.

## Configuration

```json
{
  "logMonitor": {
    "enabled": true,
    "intervalMs": 60000,
    "maxLinesPerScan": 500,
    "dedupeWindowMs": 1800000,
    "minOccurrences": 2,
    "autoResolve": true,
    "crashRecovery": true
  }
}
```

| Field             | Type    | Default   | Description                     |
| ----------------- | ------- | --------- | ------------------------------- |
| `enabled`         | boolean | `false`   | Enable the log monitor          |
| `intervalMs`      | number  | `60000`   | Scan interval in milliseconds   |
| `maxLinesPerScan` | number  | `500`     | Max log lines read per cycle    |
| `dedupeWindowMs`  | number  | `1800000` | Dedup window (30 min)           |
| `minOccurrences`  | number  | `2`       | Min hits before surfacing       |
| `autoResolve`     | boolean | `true`    | Enable auto-resolution handlers |
| `crashRecovery`   | boolean | `true`    | Run crash recovery on startup   |

## Built-in Handlers

When `autoResolve` is enabled, the monitor tries to resolve known patterns
automatically before surfacing them:

| Handler              | Matches                                | Action                                                         |
| -------------------- | -------------------------------------- | -------------------------------------------------------------- |
| **TransientNetwork** | ECONNRESET, ETIMEDOUT, ENOTFOUND, etc. | Suppresses unless frequency spikes (>10)                       |
| **CrashRecovery**    | Uncaught exceptions, crash patterns    | Delegates to crash recovery module (may spawn diagnosis agent) |
| **StuckSession**     | `session.stuck` diagnostic events      | Surfaces for manual review                                     |

Handlers are tried in order; the first match wins. If a handler returns
`"needs-human"`, the issue is surfaced to the user with a note.

## State & Storage

The monitor persists its state to `~/.openclaw/log-monitor/registry.json`:

- **Cursor** — byte offset in the log file (survives restarts)
- **Issue records** — occurrence counts, timestamps, resolve attempts

The file is written with `0600` permissions. If the file is missing on
startup, the monitor starts fresh from the current end of the log file.

## Log Monitor vs Cron vs Heartbeat

| Feature                | Log Monitor                | Cron                | Heartbeat               |
| ---------------------- | -------------------------- | ------------------- | ----------------------- |
| **Purpose**            | Detect and resolve errors  | Run scheduled tasks | Periodic agent check-in |
| **Trigger**            | Background timer + events  | Schedule (cron/at)  | Fixed interval          |
| **Output**             | System events to session   | Agent turn or event | Agent turn              |
| **User action needed** | Only for unresolved issues | Define job payload  | Configure interval      |

Use the log monitor for **reactive** error detection. Use cron for
**proactive** scheduled automation. Use heartbeat for **periodic** agent
check-ins.

## Troubleshooting

### Too many notifications

Increase `dedupeWindowMs` or `minOccurrences`:

```bash
openclaw config set logMonitor.dedupeWindowMs 3600000
openclaw config set logMonitor.minOccurrences 5
```

### Missed issues

Decrease `intervalMs` for faster scanning, or increase `maxLinesPerScan`
if the log is very busy:

```bash
openclaw config set logMonitor.intervalMs 30000
openclaw config set logMonitor.maxLinesPerScan 1000
```

### Disabling auto-resolve

If you want notifications only (no automatic resolution):

```bash
openclaw config set logMonitor.autoResolve false
```

### Disabling crash recovery

To skip crash recovery analysis on startup:

```bash
openclaw config set logMonitor.crashRecovery false
```
