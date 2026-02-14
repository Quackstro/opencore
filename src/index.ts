#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getReplyFromConfig } from "./auto-reply/reply.js";
import { applyTemplate } from "./auto-reply/templating.js";
import { monitorWebChannel } from "./channel-web.js";
import { createDefaultDeps } from "./cli/deps.js";
import { promptYesNo } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import {
  deriveSessionKey,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
} from "./config/sessions.js";
import { ensureBinary } from "./infra/binaries.js";
import { loadDotEnv } from "./infra/dotenv.js";
import { normalizeEnv } from "./infra/env.js";
import { formatUncaughtError } from "./infra/errors.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawCliOnPath } from "./infra/path-env.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import { assertSupportedRuntime } from "./infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "./infra/unhandled-rejections.js";
import { enableConsoleCapture } from "./logging.js";
import { runCommandWithTimeout, runExec } from "./process/exec.js";
import { assertWebChannel, normalizeE164, toWhatsappJid } from "./utils.js";

loadDotEnv({ quiet: true });
normalizeEnv();
ensureOpenClawCliOnPath();

// Capture all console output into structured logs while keeping stdout/stderr behavior.
enableConsoleCapture();

// Enforce the minimum supported runtime before doing any work.
assertSupportedRuntime();

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

export {
  assertWebChannel,
  applyTemplate,
  createDefaultDeps,
  deriveSessionKey,
  describePortOwner,
  ensureBinary,
  ensurePortAvailable,
  getReplyFromConfig,
  handlePortError,
  loadConfig,
  loadSessionStore,
  monitorWebChannel,
  normalizeE164,
  PortInUseError,
  promptYesNo,
  resolveSessionKey,
  resolveStorePath,
  runCommandWithTimeout,
  runExec,
  saveSessionStore,
  toWhatsappJid,
  waitForever,
};

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

if (isMain) {
  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  let _handlingException = false;
  process.on("uncaughtException", (error) => {
    const errCode = (error as NodeJS.ErrnoException).code;

    // EPIPE/EIO means the output pipe is broken - logging would just trigger
    // another EPIPE, creating an infinite cascade. Silently ignore.
    if (errCode === "EPIPE" || errCode === "EIO") {
      return;
    }

    // Re-entrancy guard: if logging inside this handler throws, don't recurse.
    if (_handlingException) {
      return;
    }
    _handlingException = true;
    try {
      _handleUncaughtException(error);
    } finally {
      _handlingException = false;
    }
  });

  function _handleUncaughtException(error: Error): void {
    // FATAL errors that MUST crash - everything else gets suppressed
    const fatalErrorCodes = new Set([
      "ERR_OUT_OF_MEMORY",
      "ERR_SCRIPT_EXECUTION_TIMEOUT",
      "ERR_WORKER_OUT_OF_MEMORY",
      "ERR_WORKER_INITIALIZATION_FAILED",
      "INVALID_CONFIG",
      "MISSING_API_KEY",
      "ENOSPC", // Disk full
    ]);

    const errCode = (error as NodeJS.ErrnoException).code;
    const errMsg = error.message || "";

    // Check for fatal conditions
    const isFatal =
      (errCode && fatalErrorCodes.has(errCode)) ||
      errMsg.includes("out of memory") ||
      errMsg.includes("heap out of memory") ||
      errMsg.includes("Cannot find module") || // Missing required module
      error.name === "SyntaxError"; // Code error

    if (isFatal) {
      console.error("[openclaw] FATAL uncaught exception (crashing):", formatUncaughtError(error));
      process.exit(1);
    }

    // Non-fatal: log and continue
    // Self-healing system will pick this up from logs
    console.warn(
      "[openclaw] Suppressed non-fatal exception (continuing):",
      formatUncaughtError(error),
    );

    // Log structured error for crash-recovery analysis
    const structuredLog = {
      ts: new Date().toISOString(),
      level: "error",
      component: "exception-handler",
      event: "suppressed_exception",
      error: {
        name: error.name,
        message: errMsg,
        code: errCode,
        stack: error.stack?.split("\n").slice(0, 5).join("\n"),
      },
    };
    console.error(JSON.stringify(structuredLog));
  }

  void program.parseAsync(process.argv).catch((err) => {
    console.error("[openclaw] CLI failed:", formatUncaughtError(err));
    process.exit(1);
  });
}
