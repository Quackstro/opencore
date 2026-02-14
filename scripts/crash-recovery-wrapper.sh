#!/bin/bash
#
# OpenCore Crash Recovery Wrapper
#
# This script wraps the OpenCore gateway and implements:
# 1. Crash loop detection (N crashes in M minutes)
# 2. Automatic halt when crash loop detected
# 3. Launch Claude CLI to diagnose and fix
# 4. Resume normal operation after fix
#
# Usage: Called by supervisord instead of direct gateway start
#

set -e

# ============================================================================
# Configuration
# ============================================================================

OPENCORE_DIR="/home/clawdbot/opencore"
STATE_DIR="/home/clawdbot/.openclaw/crash-recovery"
CRASH_LOG="$STATE_DIR/crash-history.jsonl"
LOCK_FILE="$STATE_DIR/repair-in-progress.lock"
CONFIG_FILE="$STATE_DIR/config.json"

# Defaults (can be overridden in config.json)
MAX_CRASHES=3           # Max crashes before halting
WINDOW_SECONDS=300      # Time window (5 minutes)
COOLDOWN_SECONDS=60     # Wait between repair attempts
CLAUDE_CLI="/home/clawdbot/.local/bin/claude"

# Telegram notification
BOT_TOKEN=$(python3 -c "import json; c=json.load(open('$HOME/.openclaw/openclaw.json')); print(c['channels']['telegram']['botToken'])" 2>/dev/null || echo "")
CHAT_ID="8511108690"

# ============================================================================
# Helpers
# ============================================================================

mkdir -p "$STATE_DIR"

log() {
  echo "[$(date -Iseconds)] [crash-recovery] $*" | tee -a "$STATE_DIR/wrapper.log"
}

notify() {
  local msg="$1"
  if [[ -n "$BOT_TOKEN" ]]; then
    curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="$CHAT_ID" -d text="$msg" -d parse_mode="Markdown" >/dev/null 2>&1 || true
  fi
}

record_crash() {
  local exit_code="$1"
  local timestamp
  timestamp=$(date -Iseconds)
  
  # Get last error from stderr log
  local last_error
  last_error=$(tail -50 /var/log/opencore.err.log 2>/dev/null | grep -E "Uncaught exception|TypeError|Error:" | tail -1 || echo "unknown")
  
  echo "{\"timestamp\":\"$timestamp\",\"exitCode\":$exit_code,\"error\":$(echo "$last_error" | jq -Rs .)}" >> "$CRASH_LOG"
  log "Recorded crash: exit=$exit_code"
}

count_recent_crashes() {
  local window_seconds="${1:-$WINDOW_SECONDS}"
  local cutoff
  cutoff=$(date -d "-${window_seconds} seconds" -Iseconds 2>/dev/null || date -v-${window_seconds}S -Iseconds)
  
  if [[ ! -f "$CRASH_LOG" ]]; then
    echo 0
    return
  fi
  
  # Count crashes after cutoff
  local count=0
  while IFS= read -r line; do
    local ts
    ts=$(echo "$line" | jq -r '.timestamp' 2>/dev/null || echo "")
    if [[ "$ts" > "$cutoff" ]]; then
      ((count++))
    fi
  done < "$CRASH_LOG"
  
  echo "$count"
}

get_crash_context() {
  local context_file="$STATE_DIR/crash-context.md"
  
  cat > "$context_file" << 'CONTEXT_HEADER'
# OpenCore Crash Recovery Context

## Task
OpenCore gateway is in a crash loop. Diagnose and fix the issue.

## Instructions
1. Analyze the error stack traces below
2. Find the root cause in the source code
3. Implement a fix
4. Rebuild with `pnpm build`
5. Exit when done - the wrapper will restart the gateway

## Recent Crashes
CONTEXT_HEADER

  # Add recent crash entries
  echo '```' >> "$context_file"
  tail -10 "$CRASH_LOG" 2>/dev/null >> "$context_file" || echo "No crash history"
  echo '```' >> "$context_file"

  # Add stderr log
  cat >> "$context_file" << 'STDERR_HEADER'

## Recent Stderr (errors)
```
STDERR_HEADER
  tail -100 /var/log/opencore.err.log 2>/dev/null | grep -E "Error|TypeError|exception|crash" | tail -30 >> "$context_file" || echo "No stderr"
  echo '```' >> "$context_file"

  # Add supervisor status
  cat >> "$context_file" << 'SUPERVISOR_HEADER'

## Supervisor Log
```
SUPERVISOR_HEADER
  tail -20 /var/log/supervisor/supervisord.log 2>/dev/null | grep opencore >> "$context_file" || echo "No supervisor log"
  echo '```' >> "$context_file"

  # Add relevant source file hints
  cat >> "$context_file" << 'SOURCE_HEADER'

## Key Source Files
- `/home/clawdbot/opencore/src/index.ts` - Main entry
- `/home/clawdbot/opencore/src/cli/run-main.ts` - CLI runner
- `/home/clawdbot/opencore/src/infra/unhandled-rejections.ts` - Error handling

## After Fixing
Run `pnpm build` in /home/clawdbot/opencore to rebuild.
SOURCE_HEADER

  echo "$context_file"
}

run_repair_agent() {
  log "Starting repair agent..."
  notify "🔧 *Crash Loop Detected*\n\nOpenCore crashed $MAX_CRASHES times in ${WINDOW_SECONDS}s.\n\nLaunching Claude CLI to diagnose and fix..."
  
  # Create lock file
  touch "$LOCK_FILE"
  
  # Get crash context
  local context_file
  context_file=$(get_crash_context)
  
  # Launch Claude CLI with context
  cd "$OPENCORE_DIR"
  
  local repair_log="$STATE_DIR/repair-$(date +%Y%m%d-%H%M%S).log"
  
  if [[ -x "$CLAUDE_CLI" ]]; then
    log "Running: claude -p --allowedTools='Read,Write,Edit,Bash' with crash context"
    
    # Run Claude CLI with the crash context as initial prompt
    timeout 600 "$CLAUDE_CLI" -p \
      --allowedTools='Read,Write,Edit,Bash,computer' \
      "$(cat "$context_file")" \
      2>&1 | tee "$repair_log"
    
    local repair_exit=$?
    
    if [[ $repair_exit -eq 0 ]]; then
      log "Repair agent completed successfully"
      notify "✅ *Repair Complete*\n\nClaude CLI finished. Resuming gateway..."
      
      # Clear crash history after successful repair
      > "$CRASH_LOG"
    else
      log "Repair agent exited with code $repair_exit"
      notify "⚠️ *Repair Incomplete*\n\nClaude CLI exited with code $repair_exit.\n\nCheck logs: $repair_log"
    fi
  else
    log "Claude CLI not found at $CLAUDE_CLI, falling back to alert-only mode"
    notify "🚨 *Crash Loop - Manual Fix Required*\n\nClaude CLI not available.\n\nContext saved to: $context_file"
    
    # Wait for manual intervention
    sleep "$COOLDOWN_SECONDS"
  fi
  
  # Remove lock file
  rm -f "$LOCK_FILE"
}

# ============================================================================
# Main Logic
# ============================================================================

main() {
  log "Wrapper starting..."
  
  # Check if repair is in progress
  if [[ -f "$LOCK_FILE" ]]; then
    log "Repair in progress, waiting..."
    sleep 10
    exit 0
  fi
  
  # Check crash history
  local crash_count
  crash_count=$(count_recent_crashes)
  log "Recent crashes in last ${WINDOW_SECONDS}s: $crash_count"
  
  if [[ $crash_count -ge $MAX_CRASHES ]]; then
    log "CRASH LOOP DETECTED: $crash_count crashes >= $MAX_CRASHES threshold"
    run_repair_agent
  fi
  
  # Start the gateway
  log "Starting OpenCore gateway..."
  cd "$OPENCORE_DIR"
  
  # Notify startup
  MEM=$(free -h | awk '/Mem:/{printf "%s/%s", $3, $2}')
  SWAP=$(free -h | awk '/Swap:/{printf "%s/%s", $3, $2}')
  
  # Start gateway in foreground
  node ./openclaw.mjs gateway &
  GW_PID=$!
  
  # Wait for health check
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:18789/health" >/dev/null 2>&1; then
      notify "🚀 OpenCore online — RAM $MEM, Swap $SWAP"
      break
    fi
    sleep 1
  done
  
  # Wait for gateway to exit
  wait $GW_PID
  EXIT_CODE=$?
  
  log "Gateway exited with code $EXIT_CODE"
  
  # Record crash if non-zero exit
  if [[ $EXIT_CODE -ne 0 ]]; then
    record_crash "$EXIT_CODE"
  fi
  
  exit $EXIT_CODE
}

main "$@"
