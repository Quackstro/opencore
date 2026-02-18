/**
 * Tool Bridge — connects WorkflowEngine's ToolExecutor to the gateway tool system.
 *
 * Phase 2 stub: returns failure for all tool calls.
 * Phase 3 will wire this to the real tool execution pipeline.
 */

import type { ToolExecutor } from "./engine.js";

/**
 * Create a stub ToolExecutor.
 *
 * TODO(phase-3): Wire to the real tool system. The gateway's tool execution
 * lives in the agent session pipeline — we'll need to either:
 * (a) Call the tool registry directly (bypassing LLM), or
 * (b) Inject a reference to the session's tool runner at workflow start time.
 * Option (a) is cleaner for workflow-driven tool calls.
 */
export function createToolExecutor(): ToolExecutor {
  return async (toolName: string, params: Record<string, unknown>) => {
    // Log for debugging during integration
    console.warn(
      `[workflow-tool-bridge] Tool call attempted but bridge not connected: ${toolName}(${JSON.stringify(params)})`,
    );
    return {
      success: false,
      error: `Tool bridge not yet connected. Cannot execute "${toolName}".`,
    };
  };
}
