# Self-Healing Pipeline (`/heal`)

The self-healing pipeline monitors logs and diagnostic events for errors, auto-resolves known patterns, and dispatches AI healing agents for unresolved issues.

## How It Works

```
Log/Diagnostic Event → Classify → Deduplicate → Built-in Handler → Agent Dispatch → Report
```

1. **Log scanning** — Reads the gateway error log on a configurable interval (default: 60s)
2. **Diagnostic events** — Real-time capture of agent failures, crash signals, and system errors
3. **Classification** — Extracts error signatures, severity, and category
4. **Deduplication** — Groups by signature with a configurable window (default: 30min)
5. **Built-in handlers** — Auto-resolves known patterns (transient network errors, restart loops, etc.)
6. **Agent dispatch** — Spawns an AI healing agent for unresolved issues
7. **Reporting** — Persists structured reports with TL;DR, full diagnosis, and fix proposals

## Commands

| Command                          | Description                              |
| -------------------------------- | ---------------------------------------- |
| `/heal`                          | Show help and available actions          |
| `/heal list`                     | Show pending approval requests           |
| `/heal approve <id>`             | Approve a healing agent dispatch         |
| `/heal reject <id>`              | Reject a pending request                 |
| `/heal clear`                    | Dismiss all pending approvals            |
| `/heal history [offset]`         | Browse all healing reports (paginated)   |
| `/heal search <query>`           | Search reports by keyword or ID          |
| `/heal report <id>`              | View full healing report                 |
| `/heal dismiss <id>`             | Acknowledge and close a report           |
| `/heal apply <id>`               | Apply a suggested fix (experimental)     |
| `/heal test [low\|medium\|high]` | Inject a simulated error for E2E testing |

## Approval Gate

When `approvalGate.mode` is not `"off"`, the pipeline surfaces approval requests via Telegram inline buttons before dispatching a healing agent.

| Mode               | Behavior                                |
| ------------------ | --------------------------------------- |
| `always`           | All severities require approval         |
| `high-only`        | Only high severity needs approval       |
| `medium-and-above` | Medium + high need approval             |
| `off`              | Fully autonomous — agents auto-dispatch |

Approvals **never expire** — they persist until explicitly approved, rejected, or cleared. No more missed notifications.

## Healing Reports

After a healing agent completes, a structured report is persisted to `~/.openclaw/healing-reports/`:

- **TL;DR** — One-paragraph summary
- **Full Report** — Detailed diagnosis, root cause, evidence, recommendations
- **Fix Detection** — Whether the agent proposed a concrete fix (`hasFix: true`)
- **Delivery** — Completion notification sent via Telegram with inline buttons

Reports are browseable via `/heal history` and searchable via `/heal search`.

## Configuration

```yaml
logMonitor:
  enabled: true
  intervalMs: 60000 # Scan interval (ms)
  maxLinesPerScan: 500 # Max log lines per scan
  dedupeWindowMs: 1800000 # 30min dedup window
  minOccurrences: 2 # Occurrences before surfacing
  autoResolve: true # Try built-in handlers first
  crashRecovery: true # Auto crash detection

  agentDispatch:
    enabled: true
    agentId: "dev" # Agent profile for healing sessions
    model: "anthropic/sonnet" # Model (optional, inherits default)
    thinking: "high" # Reasoning level
    timeoutSeconds: 600 # Agent run timeout
    maxConcurrent: 2 # Max simultaneous agents
    cooldownSeconds: 3600 # Cooldown per issue after auto-resolve
    maxSpawnsPerHour: 8 # Rate limit

    approvalGate:
      mode: "medium-and-above"

    notifyTarget: "<telegram-chat-id>"
    notifyAccountId: "default"
```

## Built-in Handlers

The pipeline includes handlers for common error patterns that can be resolved without an AI agent:

- **Transient network errors** — ECONNRESET, ETIMEDOUT, DNS failures (auto-suppress)
- **Crash recovery** — Detects restart loops, back-off patterns
- **Rate limits** — API 429s with automatic cooldown
- **Module resolution** — Stale dist hash errors after builds

## Architecture

```
src/infra/log-monitor.ts              — Main service loop
src/infra/log-monitor-handlers.ts     — Built-in resolution handlers
src/infra/log-monitor-registry.ts     — Issue tracking and deduplication
src/infra/log-monitor-diagnostics.ts  — Real-time diagnostic event collector
src/infra/log-monitor-agent-dispatch.ts — Agent spawning + approval gate
src/infra/log-monitor-security-audit.ts — Security audit integration
src/infra/healing-reports.ts          — Report persistence and retrieval
src/auto-reply/reply/commands-heal.ts — Chat command handler
```
