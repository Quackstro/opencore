/**
 * Plugin Callback & Message Handler Registry
 *
 * Manages callback_query handlers and message handlers registered by plugins.
 * Callback handlers match inline button data; message handlers intercept text
 * messages before the LLM agent.
 */

import type {
  PluginCallbackHandlerContext,
  PluginCallbackHandlerDef,
  PluginCallbackHandlerResult,
  PluginMessageHandlerContext,
  PluginMessageHandlerDef,
  PluginMessageHandlerResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type RegisteredCallbackHandler = PluginCallbackHandlerDef & { pluginId: string };
type RegisteredMessageHandler = PluginMessageHandlerDef & { pluginId: string };

const callbackHandlers: RegisteredCallbackHandler[] = [];
const messageHandlers: RegisteredMessageHandler[] = [];

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
