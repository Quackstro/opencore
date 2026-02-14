import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { guardedAppend } from "../logging/circuit-breaker.js";

const RAW_STREAM_ENABLED = isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
const RAW_STREAM_PATH =
  process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
  path.join(resolveStateDir(), "logs", "raw-stream.jsonl");

/** Max size for raw stream log (20 MB). */
const MAX_RAW_STREAM_BYTES = 20 * 1024 * 1024;

let writeQueue = Promise.resolve();

export function appendRawStream(payload: Record<string, unknown>) {
  if (!RAW_STREAM_ENABLED) {
    return;
  }
  const line = `${JSON.stringify(payload)}\n`;
  writeQueue = writeQueue
    .then(() =>
      guardedAppend(RAW_STREAM_PATH, line, {
        maxFileBytes: MAX_RAW_STREAM_BYTES,
        keepTailBytes: 2 * 1024 * 1024,
      }),
    )
    .catch(() => undefined);
}
