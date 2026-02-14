# Self-Healing Mechanism - Live Test Plan

## 1. Context Overflow Recovery

**Goal**: Force the context window to exceed limits and verify automatic session reset.

- Send a long conversation (or inject a very large system prompt / tool result) that pushes past the model's context window
- Temporarily set `agents.defaults.contextTokens` to a very low value (e.g., 4096) so overflow happens quickly
- Set `reserveTokensFloor` to `0` so compaction doesn't save it first
- **Verify**: Session ID rotates, user gets the "Context limit exceeded..." message, old transcript is cleaned up, new session persists in `sessions.json`

## 2. Compaction + Memory Flush

**Goal**: Trigger pre-compaction memory flush and verify durable notes are written.

- Set `agents.defaults.compaction.memoryFlush.softThresholdTokens` to a low value so flush triggers early
- Have a multi-turn conversation with memorable facts ("my favorite color is blue")
- **Verify**: A `memory/YYYY-MM-DD.md` file is created with flushed content, `compactionCount` increments in session metadata, conversation continues seamlessly after compaction

## 3. Role Ordering Conflict Recovery

**Goal**: Simulate a message ordering conflict.

- **Corrupt the transcript**: Manually edit the JSONL transcript file to put two `assistant` turns back-to-back (removing a `user` turn between them), then trigger a reply
- **Race condition**: Send messages from multiple channels/sources simultaneously to the same session to create ordering conflicts
- **Verify**: Session resets, user gets "Message ordering conflict..." message, new session works cleanly

## 4. Crash Recovery Diagnosis

**Goal**: Trigger the crash recovery agent that analyzes repeated crashes.

- Note: The module at `src/infra/crash-recovery.ts` may not be wired into the startup flow
- Write crash signatures to the stderr log path
- Simulate 2+ crashes within the 30-minute window with the same error signature
- Call the crash recovery function directly and verify it spawns the diagnosis sub-agent
- **Alternative**: Intentionally introduce a bug that crashes on startup, restart twice, and check if recovery kicks in

## 5. Transient Network Recovery (undici TLS)

**Goal**: Verify the process doesn't crash on transient TLS errors.

- **Mock the error**: In a test harness, emit the specific `Cannot read properties of null` error on a TLS socket
- **Network disruption**: Use `tc` (traffic control) or a proxy to force TLS session reuse failures during an active API call
- **Verify**: Warning is logged but process continues, no crash

## Priority

Start with #1 and #2 as they are easiest to trigger via config changes and have the highest user impact. Write tests as `*.live.test.ts` files under `vitest.live.config.ts`.
