/**
 * Workflow Engine Bootstrap
 *
 * Factory that creates and wires up the workflow engine, adapters, and
 * workflow definitions. Called once during gateway startup.
 */

import type { TelegramProvider } from "./adapters/telegram/telegram-adapter.js";
import { TelegramAdapter } from "./adapters/telegram/telegram-adapter.js";
import { TextOnlyAdapter } from "./adapters/text/text-adapter.js";
import { WorkflowEngine } from "./engine.js";
import { IdentityService } from "./identity/identity-service.js";
import { DefaultCapabilityNegotiator } from "./negotiator.js";
import { MessageRouter } from "./router.js";
import { WorkflowStateManager } from "./state.js";
import { createToolExecutor } from "./tool-bridge.js";
import { registerArkWorkflows } from "./workflows/ark/index.js";
import { registerBrainWorkflows } from "./workflows/brain/index.js";
import { registerHealWorkflows } from "./workflows/heal/index.js";
import { registerIdentityWorkflows } from "./workflows/identity/index.js";
import { registerLedgerWorkflows } from "./workflows/ledger/index.js";
import { registerOpencoreWorkflows } from "./workflows/opencore/index.js";
// Workflow registrations
import { registerWalletWorkflows } from "./workflows/wallet/index.js";

// ─── Singleton ──────────────────────────────────────────────────────────────

let _engine: WorkflowEngine | null = null;
let _stateManager: WorkflowStateManager | null = null;
let _identityService: IdentityService | null = null;
let _messageRouter: MessageRouter | null = null;
let _telegramAdapter: TelegramAdapter | null = null;

export interface WorkflowEngineOptions {
  /** Data directory (e.g. ~/.openclaw) */
  dataDir: string;
  /** Telegram API provider for the adapter. Optional — can be set later via setTelegramProvider(). */
  telegramProvider?: TelegramProvider;
}

/**
 * Initialize the workflow engine singleton.
 * Idempotent — second call returns existing instance.
 */
export function initWorkflowEngine(opts: WorkflowEngineOptions): WorkflowEngine {
  if (_engine) {
    return _engine;
  }

  const { dataDir, telegramProvider } = opts;

  // Core services
  _stateManager = new WorkflowStateManager(dataDir);
  _identityService = new IdentityService(dataDir);
  const negotiator = new DefaultCapabilityNegotiator();
  const toolExecutor = createToolExecutor();

  // Engine
  _engine = new WorkflowEngine({
    stateManager: _stateManager,
    negotiator,
    toolExecutor,
  });

  // Register adapters
  if (telegramProvider) {
    _telegramAdapter = new TelegramAdapter(telegramProvider);
    _engine.registerAdapter(_telegramAdapter);
  }

  // Always register text fallback adapter (no-op send for now; real usage goes through Telegram)
  const textAdapter = new TextOnlyAdapter(async (_target, _text) => ({
    messageId: `text-${Date.now()}`,
  }));
  _engine.registerAdapter(textAdapter);

  // Register all workflow definitions
  const registrations = [
    registerWalletWorkflows,
    registerArkWorkflows,
    registerBrainWorkflows,
    registerHealWorkflows,
    registerIdentityWorkflows,
    registerLedgerWorkflows,
    registerOpencoreWorkflows,
  ];

  for (const register of registrations) {
    try {
      register(_engine);
    } catch (err) {
      console.error(`[workflow-bootstrap] Failed to register workflows: ${String(err)}`);
    }
  }

  // Message router (for cross-surface proactive sends)
  _messageRouter = new MessageRouter(dataDir, _identityService);

  console.log("[workflow-bootstrap] Workflow engine initialized");
  return _engine;
}

/**
 * Late-bind the Telegram provider. Called after the Telegram bot is created,
 * so the workflow engine can render steps via Telegram API.
 */
export function setTelegramProvider(provider: TelegramProvider): void {
  if (!_engine) {
    console.warn("[workflow-bootstrap] Engine not initialized, cannot set Telegram provider");
    return;
  }
  if (_telegramAdapter) {
    console.warn("[workflow-bootstrap] Telegram adapter already registered, skipping");
    return;
  }
  _telegramAdapter = new TelegramAdapter(provider);
  _engine.registerAdapter(_telegramAdapter);
  console.log("[workflow-bootstrap] Telegram adapter registered (late-bind)");
}

/** Get the workflow engine singleton. Returns null if not initialized. */
export function getWorkflowEngine(): WorkflowEngine | null {
  return _engine;
}

/** Get the identity service singleton. Returns null if not initialized. */
export function getIdentityService(): IdentityService | null {
  return _identityService;
}

/** Get the message router singleton. Returns null if not initialized. */
export function getMessageRouter(): MessageRouter | null {
  return _messageRouter;
}

/** Shutdown — flush state, clear timers. */
export function destroyWorkflowEngine(): void {
  _stateManager?.destroy();
  _identityService?.destroy();
  _messageRouter?.destroy();
  _engine = null;
  _stateManager = null;
  _identityService = null;
  _messageRouter = null;
}
