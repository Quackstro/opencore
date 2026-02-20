/**
 * Tool Bridge — connects WorkflowEngine's ToolExecutor to the gateway tool system.
 *
 * Creates tools via createOpenClawTools() and dispatches by name.
 * Tools are instantiated lazily on first call and cached.
 */

import type { ToolExecutor } from "./engine.js";

/** Minimal tool shape — avoids importing pi-agent-core types. */
interface ToolLike {
  name: string;
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: unknown }>;
}

type ToolFactory = () => ToolLike[];

/** Extract text from tool content (handles array-of-objects or string formats). */
function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: string; text: string } =>
        typeof c === "object" && c !== null && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

let _toolFactory: ToolFactory | null = null;
let _toolCache: Map<string, ToolLike> | null = null;

/**
 * Set the tool factory. Called during bootstrap after tools are available.
 * The factory is called lazily on first tool execution.
 */
export function setToolFactory(factory: ToolFactory): void {
  _toolFactory = factory;
  _toolCache = null; // reset cache on new factory
}

function resolveTools(): Map<string, ToolLike> {
  if (_toolCache) {
    return _toolCache;
  }
  if (!_toolFactory) {
    _toolCache = new Map();
    return _toolCache;
  }
  const tools = _toolFactory();
  _toolCache = new Map(tools.map((t) => [t.name, t]));
  return _toolCache;
}

/**
 * Create a ToolExecutor that dispatches to the gateway's tool system.
 */
export function createToolExecutor(): ToolExecutor {
  return async (toolName: string, params: Record<string, unknown>) => {
    const tools = resolveTools();
    const tool = tools.get(toolName);

    if (!tool) {
      console.warn(`[workflow-tool-bridge] Tool not found: ${toolName}`);
      return {
        success: false,
        error: `Tool "${toolName}" not found.`,
      };
    }

    if (!tool.execute) {
      return {
        success: false,
        error: `Tool "${toolName}" has no execute method.`,
      };
    }

    try {
      const callId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await tool.execute(callId, params);
      const content = result?.content;

      // Detect tool-level errors:
      // 1. { content, details: { error } } — plugin tools
      // 2. { content, isError: true } — agent tools
      const resultObj = result as Record<string, unknown>;
      const details = resultObj?.details as Record<string, unknown> | undefined;
      const isError = details?.error || resultObj?.isError;
      if (isError) {
        // Extract error text from content
        const errorText = extractContentText(content) || (details?.error ? String(details.error) : "Tool call failed.");
        return {
          success: false,
          error: errorText,
          result: content,
        };
      }

      return {
        success: true,
        result: content,
      };
    } catch (err) {
      console.error(`[workflow-tool-bridge] Tool "${toolName}" failed: ${String(err)}`);
      return {
        success: false,
        error: String(err),
      };
    }
  };
}
