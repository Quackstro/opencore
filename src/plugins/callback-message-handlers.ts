/**
 * Plugin Callback & Message Handler Registry
 *
 * Manages callback_query handlers and message handlers registered by plugins.
 * Callback handlers match inline button data; message handlers intercept text
 * messages before the LLM agent.
 *
 * Uses Symbol.for() globals so the gateway runtime and plugin-sdk runtime
 * share the same arrays even when the bundler splits them into separate chunks.
 */

import type {
  PluginCallbackHandlerDef,
  PluginMessageHandlerContext,
  PluginMessageHandlerDef,
  PluginMessageHandlerResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Storage — global singletons via Symbol.for to survive chunk splitting
// ---------------------------------------------------------------------------

type RegisteredCallbackHandler = PluginCallbackHandlerDef & { pluginId: string };
type RegisteredMessageHandler = PluginMessageHandlerDef & { pluginId: string };

const CB_KEY = Symbol.for("openclaw.callbackHandlers");
const MH_KEY = Symbol.for("openclaw.messageHandlers");

const g = globalThis as Record<symbol, unknown>;
if (!g[CB_KEY]) {
  g[CB_KEY] = [];
}
if (!g[MH_KEY]) {
  g[MH_KEY] = [];
}

const callbackHandlers = g[CB_KEY] as RegisteredCallbackHandler[];
const messageHandlers = g[MH_KEY] as RegisteredMessageHandler[];

// ---------------------------------------------------------------------------
// Registration (called from registry.ts during plugin load)
// ---------------------------------------------------------------------------

export function registerCallbackHandler(pluginId: string, def: PluginCallbackHandlerDef): void {
  callbackHandlers.push({ ...def, pluginId });
}

export function registerMessageHandler(pluginId: string, def: PluginMessageHandlerDef): void {
  messageHandlers.push({ ...def, pluginId });
  // Keep sorted by descending priority
  messageHandlers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

// ---------------------------------------------------------------------------
// Query (called from Telegram integration)
// ---------------------------------------------------------------------------

/**
 * Find the first callback handler whose pattern matches the given data string.
 */
export function findCallbackHandler(data: string): RegisteredCallbackHandler | undefined {
  return callbackHandlers.find((h) => h.pattern.test(data));
}

/**
 * Run message handlers in priority order. Returns the first non-null result,
 * or null if all handlers pass.
 */
export async function runMessageHandlers(
  ctx: PluginMessageHandlerContext,
): Promise<PluginMessageHandlerResult> {
  for (const handler of messageHandlers) {
    if (handler.pattern.test(ctx.text)) {
      const result = await handler.handler(ctx);
      if (result != null) {
        return result;
      }
    }
  }
  return null;
}
