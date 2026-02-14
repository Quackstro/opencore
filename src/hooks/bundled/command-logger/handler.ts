/**
 * Example hook handler: Log all commands to a file
 *
 * This handler demonstrates how to create a hook that logs all command events
 * to a centralized log file for audit/debugging purposes.
 *
 * To enable this handler, add it to your config:
 *
 * ```json
 * {
 *   "hooks": {
 *     "internal": {
 *       "enabled": true,
 *       "handlers": [
 *         {
 *           "event": "command",
 *           "module": "./hooks/handlers/command-logger.ts"
 *         }
 *       ]
 *     }
 *   }
 * }
 * ```
 */

import os from "node:os";
import path from "node:path";
import type { HookHandler } from "../../hooks.js";
import { resolveStateDir } from "../../../config/paths.js";
import { guardedAppend } from "../../../logging/circuit-breaker.js";

/**
 * Log all command events to a file
 */
const logCommand: HookHandler = async (event) => {
  // Only trigger on command events
  if (event.type !== "command") {
    return;
  }

  try {
    const stateDir = resolveStateDir(process.env, os.homedir);
    const logFile = path.join(stateDir, "logs", "commands.log");
    const logLine =
      JSON.stringify({
        timestamp: event.timestamp.toISOString(),
        action: event.action,
        sessionKey: event.sessionKey,
        senderId: event.context.senderId ?? "unknown",
        source: event.context.commandSource ?? "unknown",
      }) + "\n";

    await guardedAppend(logFile, logLine, {
      maxFileBytes: 10 * 1024 * 1024, // 10 MB
      keepTailBytes: 1 * 1024 * 1024, // keep last 1 MB
    });
  } catch (err) {
    console.error(
      "[command-logger] Failed to log command:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default logCommand;
