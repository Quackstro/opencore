/**
 * Brain Actions — OpenClaw Plugin Entry Point.
 *
 * Provides action detection and routing for Brain drops.
 * Hooks into brain-core's drop pipeline to detect reminders,
 * payments, and other actionable intents.
 *
 * Actual notification/payment delivery is handled via configurable
 * hooks — this plugin provides the framework, not the integrations.
 */

import { routeAction, shouldRouteAction } from "./router.js";
import type { ActionRouterConfig, ActionHooks, ActionContext } from "./types.js";

// ============================================================================
// Re-exports
// ============================================================================

export * from "./types.js";
export * from "./detector.js";
export * from "./time-extractor.js";
export * from "./router.js";
export {
  handleReminderAction,
  handleBookingAction,
  createPersistentReminder,
} from "./handlers/reminder.js";
export { handlePaymentAction, extractPaymentParams } from "./handlers/payment.js";

// ============================================================================
// Config Parser
// ============================================================================

interface BrainActionsConfig {
  enabled: boolean;
  gatewayToken?: string;
  gatewayUrl: string;
  timezone: string;
  extractionModel: string;
  reminder: {
    enabled: boolean;
    nagIntervalMinutes: number;
    defaultTime: string;
  };
  payment: {
    enabled: boolean;
    autoExecuteThreshold: number;
    maxAutoExecuteAmount: number;
  };
}

function parseConfig(raw: unknown): BrainActionsConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;

  const reminderRaw = (cfg.reminder ?? {}) as Record<string, unknown>;
  const paymentRaw = (cfg.payment ?? {}) as Record<string, unknown>;

  return {
    enabled: cfg.enabled !== false,
    gatewayToken: cfg.gatewayToken as string | undefined,
    gatewayUrl: (cfg.gatewayUrl as string) ?? "http://127.0.0.1:18789",
    timezone: (cfg.timezone as string) ?? "America/New_York",
    extractionModel: (cfg.extractionModel as string) ?? "claude-haiku-3.5",
    reminder: {
      enabled: reminderRaw.enabled !== false,
      nagIntervalMinutes: (reminderRaw.nagIntervalMinutes as number) ?? 5,
      defaultTime: (reminderRaw.defaultTime as string) ?? "09:00",
    },
    payment: {
      enabled: paymentRaw.enabled !== false,
      autoExecuteThreshold: (paymentRaw.autoExecuteThreshold as number) ?? 0.95,
      maxAutoExecuteAmount: (paymentRaw.maxAutoExecuteAmount as number) ?? 10,
    },
  };
}

// ============================================================================
// Plugin Definition
// ============================================================================

const brainActionsPlugin = {
  id: "brain-actions",
  name: "Brain Actions",
  description:
    "Action framework for Brain drops — detects reminders, payments, and other " +
    "actionable intents, then routes to configurable handlers.",
  kind: "workflow" as const,

  register(api: any) {
    const cfg = parseConfig(api.pluginConfig);
    if (!cfg || !cfg.enabled) {
      api.logger?.info?.("brain-actions: disabled or no config");
      return;
    }

    // Build router config
    const routerConfig: ActionRouterConfig = {
      enabled: cfg.enabled,
      gatewayToken: cfg.gatewayToken ?? api.gatewayToken ?? "",
      gatewayUrl: cfg.gatewayUrl,
      timezone: cfg.timezone,
      extractionModel: cfg.extractionModel,
      reminder: cfg.reminder,
      payment: cfg.payment,
    };

    // Hooks storage — populated by extension consumers
    const hooks: ActionHooks = {};

    // Expose for extension consumers
    (api as any)._brainActions = {
      config: routerConfig,
      hooks,
      routeAction,
      shouldRouteAction,
    };

    api.logger.info(
      `brain-actions: registered (timezone: ${cfg.timezone}, ` +
        `reminders: ${cfg.reminder.enabled}, payments: ${cfg.payment.enabled})`,
    );

    // ================================================================
    // Hook Registration Methods
    // ================================================================

    /**
     * Register a reminder delivery hook.
     * Called when a reminder needs to be sent to the user.
     */
    api.registerMethod("brain-actions:setReminderHook", (hook: any) => {
      hooks.onReminderDeliver = hook;
      api.logger.debug("brain-actions: reminder hook registered");
    });

    /**
     * Register a payment resolver hook.
     * Called to resolve recipient names to addresses.
     */
    api.registerMethod("brain-actions:setPaymentResolverHook", (hook: any) => {
      hooks.onPaymentResolve = hook;
      api.logger.debug("brain-actions: payment resolver hook registered");
    });

    /**
     * Register a payment execution hook.
     * Called to actually send a payment.
     */
    api.registerMethod("brain-actions:setPaymentExecuteHook", (hook: any) => {
      hooks.onPaymentExecute = hook;
      api.logger.debug("brain-actions: payment execute hook registered");
    });

    /**
     * Register a payment approval hook.
     * Called to request user approval for a payment.
     */
    api.registerMethod("brain-actions:setPaymentApprovalHook", (hook: any) => {
      hooks.onPaymentApproval = hook;
      api.logger.debug("brain-actions: payment approval hook registered");
    });

    /**
     * Register an action routed hook.
     * Called after any action is successfully routed.
     */
    api.registerMethod("brain-actions:setActionRoutedHook", (hook: any) => {
      hooks.onActionRouted = hook;
      api.logger.debug("brain-actions: action routed hook registered");
    });

    // ================================================================
    // Action Routing Method
    // ================================================================

    /**
     * Route an action for a classified drop.
     * Called by brain-core after classification.
     */
    api.registerMethod(
      "brain-actions:route",
      async (params: {
        store: any;
        embedder: any;
        classification: any;
        rawText: string;
        inboxId: string;
        inputTag?: string;
      }) => {
        const ctx: ActionContext = {
          store: params.store,
          embedder: params.embedder,
          config: routerConfig,
          hooks,
          classification: params.classification,
          rawText: params.rawText,
          inboxId: params.inboxId,
          inputTag: params.inputTag,
        };

        return await routeAction(ctx);
      },
    );

    // ================================================================
    // Service
    // ================================================================

    api.registerService({
      id: "brain-actions",
      start: () => {
        api.logger.info("brain-actions: started");
      },
      stop: () => {
        api.logger.info("brain-actions: stopped");
      },
    });
  },
};

export default brainActionsPlugin;
