import { initWorkflowEngine } from "../abstraction/bootstrap.js";
import { registerWorkflowHooks } from "../abstraction/hooks.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  try {
    const stateDir = resolveStateDir(process.env);
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    for (const sessionsDir of sessionDirs) {
      await cleanStaleLockFiles({
        sessionsDir,
        staleMs: SESSION_LOCK_STALE_MS,
        removeStale: true,
        log: { warn: (message) => params.log.warn(message) },
      });
    }
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  // Start OpenClaw browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  await startGmailWatcherWithLogs({
    cfg: params.cfg,
    log: params.logHooks,
  });

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Initialize the workflow engine and register hooks before channels start,
  // so workflow callback/message handlers are in place for the first message.
  try {
    const stateDir = resolveStateDir(process.env);
    initWorkflowEngine({
      dataDir: stateDir,
      toolFactory: () => createOpenClawTools({ config: params.cfg }),
    });
    registerWorkflowHooks();
  } catch (err) {
    params.log.warn(`workflow engine initialization failed: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via OPENCLAW_SKIP_CHANNELS (or legacy OPENCLAW_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  if (params.cfg.acp?.enabled) {
    void getAcpSessionManager()
      .reconcilePendingSessionIdentities({ cfg: params.cfg })
      .then((result) => {
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      })
      .catch((err) => {
        params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
      });
  }

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  // Start the log monitor background service (self-healing pipeline).
  let logMonitorHandle: { stop(): void; updateConfig(cfg: unknown): void } | null = null;
  if (params.cfg.logMonitor?.enabled) {
    try {
      const { startLogMonitor } = await import("../infra/log-monitor.js");
      // Use the default agent's session key so system events are delivered
      const defaultAgent =
        params.cfg.agents?.list?.find((a: { default?: boolean }) => a.default) ??
        params.cfg.agents?.list?.[0];
      const monitorSessionKey = defaultAgent ? `agent:${defaultAgent.id}:main` : undefined;
      // Resolve Telegram delivery target from bindings
      const defaultBinding = params.cfg.bindings?.find(
        (b: { agentId?: string }) => b.agentId === defaultAgent?.id,
      ) as { agentId?: string; match?: { channel?: string; accountId?: string } } | undefined;
      const deliveryAccountId = defaultBinding?.match?.accountId;
      // Read allowed user from Telegram credentials (allowFrom list)
      let deliveryTo: string | undefined;
      try {
        const fs = await import("node:fs");
        const homeDir = process.env.HOME || "/home/clawdbot";
        const allowFromPath = `${homeDir}/.openclaw/credentials/telegram-allowFrom.json`;
        if (fs.existsSync(allowFromPath)) {
          const data = JSON.parse(fs.readFileSync(allowFromPath, "utf-8")) as {
            allowFrom?: string[];
          };
          if (data.allowFrom?.[0]) {
            deliveryTo = data.allowFrom[0];
          }
        }
      } catch {
        // best-effort
      }
      // Resolve log file path: env var > supervisor stderr log > resolved logger settings
      let resolvedLogFile = process.env.OPENCLAW_LOG_FILE;
      if (!resolvedLogFile) {
        try {
          const fs = await import("node:fs");
          // Check supervisor stderr log (where diagnostic output goes)
          const supervisorErrLog = "/var/log/opencore.err.log";
          if (fs.existsSync(supervisorErrLog)) {
            resolvedLogFile = supervisorErrLog;
          } else {
            // Fall back to structured log file
            const { getResolvedLoggerSettings } = await import("../logging/logger.js");
            resolvedLogFile = getResolvedLoggerSettings().file;
          }
        } catch {
          resolvedLogFile = "/var/log/opencore.err.log";
        }
      }
      params.log.warn(`[log-monitor] watching: ${resolvedLogFile}`);
      logMonitorHandle = startLogMonitor(params.cfg.logMonitor, {
        logFile: resolvedLogFile,
        sessionKey: monitorSessionKey,
        deliveryChannel: deliveryTo ? "telegram" : undefined,
        deliveryTo,
        deliveryAccountId,
        logger: {
          info: (msg: string) => params.log.warn(`[log-monitor] ${msg}`),
          warn: (msg: string) => params.log.warn(`[log-monitor] ${msg}`),
        },
      });
    } catch (err) {
      params.log.warn(`log monitor failed to start: ${String(err)}`);
    }
  }

  // Resurface any unacknowledged healing reports from before the restart.
  if (!skipChannels) {
    setTimeout(async () => {
      try {
        const { resurfaceUnacknowledgedReports } =
          await import("../infra/log-monitor-agent-dispatch.js");
        const count = await resurfaceUnacknowledgedReports();
        if (count > 0) {
          params.log.warn(`resurfaced ${count} unacknowledged healing report(s)`);
        }
      } catch {
        // best-effort
      }
    }, 3000);
  }

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  return { browserControl, pluginServices, logMonitorHandle };
}
