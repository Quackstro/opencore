/**
 * 🐚 Shellphone - Voice Calls from the Deep
 *
 * A vendor-agnostic voice call plugin using open-source components:
 * - STT: Whisper (faster-whisper) - listens like a whale
 * - TTS: Piper (primary) with Edge TTS fallback - speaks like a siren
 * - LLM: OpenCore's configured model - thinks like an octopus
 *
 * "Can you hear me now? 🦀"
 */

import { Type } from "@sinclair/typebox";
import { VoiceCallOpenRuntime } from "./src/runtime.js";
import { VoiceCallOpenConfigSchema, type VoiceCallOpenConfig } from "./src/types.js";

// Configuration parser
const shellphoneConfigSchema = {
  parse(value: unknown): VoiceCallOpenConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return VoiceCallOpenConfigSchema.parse({
      ...raw,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
      provider: raw.provider ?? "mock",
    });
  },
  uiHints: {
    enabled: { label: "Enable Shellphone 🐚" },
    provider: { label: "Provider", help: "twilio or mock for testing" },
    fromNumber: { label: "From Number", placeholder: "+15550001234" },
    toNumber: { label: "Default To Number", placeholder: "+15550001234" },
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
    "stt.whisper.model": { label: "Whisper Model", help: "tiny, base, small, medium, large" },
    "stt.whisper.device": { label: "Whisper Device", help: "cpu or cuda" },
    "tts.provider": { label: "TTS Provider", help: "piper or edge" },
    "tts.piper.model": { label: "Piper Voice Model" },
    "tts.piper.dataDir": { label: "Piper Data Directory" },
    "vad.silenceThresholdMs": { label: "Silence Threshold (ms)", advanced: true },
    "vad.minSpeechMs": { label: "Min Speech Duration (ms)", advanced: true },
    "vad.energyThreshold": { label: "Energy Threshold", advanced: true },
    "llm.systemPrompt": { label: "System Prompt" },
    "llm.maxTokens": { label: "Max Tokens", advanced: true },
    "llm.temperature": { label: "Temperature", advanced: true },
    "serve.port": { label: "Webhook Port", advanced: true },
    "serve.bind": { label: "Webhook Bind", advanced: true },
    "serve.path": { label: "Webhook Path", advanced: true },
    "serve.streamPath": { label: "Stream Path", advanced: true },
    "tunnel.provider": { label: "Tunnel Provider", advanced: true },
    "tunnel.ngrokAuthToken": { label: "ngrok Auth Token", sensitive: true, advanced: true },
    "tunnel.ngrokDomain": { label: "ngrok Domain", advanced: true },
    inboundPolicy: { label: "Inbound Policy" },
    allowFrom: { label: "Allowed Callers" },
    inboundGreeting: { label: "Inbound Greeting" },
    maxDurationSeconds: { label: "Max Call Duration (sec)", advanced: true },
    publicUrl: { label: "Public Webhook URL", advanced: true },
    store: { label: "Call Log Store Path", advanced: true },
  },
};

// Tool schema - streamlined actions: call, hangup, status
const ShellphoneToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("call"),
    to: Type.Optional(Type.String({ description: "Phone number to call (E.164)" })),
    message: Type.Optional(Type.String({ description: "Opening message (the shell's greeting)" })),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
  }),
  Type.Object({
    action: Type.Literal("speak"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak through the shell" }),
  }),
  Type.Object({
    action: Type.Literal("hangup"),
    callId: Type.String({ description: "Call ID to hang up" }),
  }),
  Type.Object({
    action: Type.Literal("status"),
    callId: Type.Optional(Type.String({ description: "Call ID (omit for plugin status)" })),
  }),
]);

// 🐚 Plugin definition
const shellphonePlugin = {
  id: "shellphone",
  name: "Shellphone 🐚",
  description: "Voice calls from the deep - open-source STT (Whisper) and TTS (Piper)",
  configSchema: shellphoneConfigSchema,

  register(api: {
    pluginConfig: unknown;
    config: unknown;
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug: (msg: string) => void;
    };
    runtime: { llm?: unknown };
    registerGatewayMethod: (
      name: string,
      handler: (params: {
        params: unknown;
        respond: (ok: boolean, payload?: unknown) => void;
      }) => Promise<void>,
    ) => void;
    registerTool: (tool: unknown) => void;
    registerCli: (
      handler: (ctx: { program: unknown }) => void,
      opts: { commands: string[] },
    ) => void;
    registerService: (service: {
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }) => void;
  }) {
    const config = shellphoneConfigSchema.parse(api.pluginConfig);

    if (!config.enabled) {
      api.logger.info("[shellphone] 🐚 Plugin disabled - the shell remains silent");
      return;
    }

    let runtime: VoiceCallOpenRuntime | null = null;
    let runtimePromise: Promise<VoiceCallOpenRuntime> | null = null;

    const ensureRuntime = async (): Promise<VoiceCallOpenRuntime> => {
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = (async () => {
          const rt = new VoiceCallOpenRuntime({
            config,
            coreConfig: api.config as Record<string, unknown>,
            logger: api.logger,
          });
          await rt.start();
          return rt;
        })();
      }
      runtime = await runtimePromise;
      return runtime;
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    // Gateway methods - shellphone.call, shellphone.speak, shellphone.hangup, shellphone.status
    api.registerGatewayMethod("shellphone.call", async ({ params, respond }) => {
      try {
        const p = params as { to?: string; message?: string; mode?: "notify" | "conversation" };
        const rt = await ensureRuntime();
        const to = p.to?.trim() || rt.config.toNumber;
        if (!to) {
          respond(false, { error: "🐚 No destination - where should the shell call?" });
          return;
        }
        const result = await rt.initiateCall(to, {
          message: p.message?.trim(),
          mode: p.mode,
        });
        if (!result.success) {
          respond(false, { error: result.error });
          return;
        }
        respond(true, {
          callId: result.callId,
          initiated: true,
          message: "🐚 Shell is calling...",
        });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("shellphone.speak", async ({ params, respond }) => {
      try {
        const p = params as { callId?: string; message?: string };
        if (!p.callId || !p.message) {
          respond(false, { error: "🐚 Need callId and message to speak through the shell" });
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.speak(p.callId, p.message);
        if (!result.success) {
          respond(false, { error: result.error });
          return;
        }
        respond(true, { success: true, message: "🐚 The shell has spoken" });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("shellphone.hangup", async ({ params, respond }) => {
      try {
        const p = params as { callId?: string };
        if (!p.callId) {
          respond(false, { error: "🐚 Which call should the shell release?" });
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.endCall(p.callId);
        if (!result.success) {
          respond(false, { error: result.error });
          return;
        }
        respond(true, { success: true, message: "🐚 Call returned to the deep" });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("shellphone.status", async ({ params, respond }) => {
      try {
        const p = params as { callId?: string };
        if (!p.callId) {
          respond(true, {
            ready: runtime !== null,
            message: runtime ? "🐚 Shell is listening" : "🐚 Shell is dormant",
          });
          return;
        }
        const rt = await ensureRuntime();
        const call = rt.getCall(p.callId);
        respond(
          true,
          call
            ? { found: true, call }
            : { found: false, message: "🐚 Call not found in the depths" },
        );
      } catch (err) {
        sendError(respond, err);
      }
    });

    // 🐚 Tool registration
    api.registerTool({
      name: "shellphone",
      label: "Shellphone 🐚",
      description:
        "Make phone calls from the deep using open-source STT/TTS (Whisper + Piper). Actions: call, speak, hangup, status.",
      parameters: ShellphoneToolSchema,
      async execute(_toolCallId: string, params: unknown) {
        const json = (payload: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();
          const p = params as Record<string, unknown>;

          switch (p.action) {
            case "call": {
              const to = (p.to as string)?.trim() || rt.config.toNumber;
              if (!to) throw new Error("🐚 No destination - where should the shell call?");
              const result = await rt.initiateCall(to, {
                message: (p.message as string)?.trim(),
                mode: p.mode as "notify" | "conversation",
              });
              if (!result.success) throw new Error(result.error);
              return json({
                callId: result.callId,
                initiated: true,
                message: "🐚 Shell is calling...",
              });
            }

            case "speak": {
              const callId = (p.callId as string)?.trim();
              const message = (p.message as string)?.trim();
              if (!callId || !message) throw new Error("🐚 Need callId and message");
              const result = await rt.speak(callId, message);
              if (!result.success) throw new Error(result.error);
              return json({ success: true, message: "🐚 The shell has spoken" });
            }

            case "hangup": {
              const callId = (p.callId as string)?.trim();
              if (!callId) throw new Error("🐚 Which call to hang up?");
              const result = await rt.endCall(callId);
              if (!result.success) throw new Error(result.error);
              return json({ success: true, message: "🐚 Call returned to the deep" });
            }

            case "status": {
              const callId = (p.callId as string)?.trim();
              if (!callId) {
                return json({
                  ready: runtime !== null,
                  message: runtime ? "🐚 Shell is listening" : "🐚 Shell is dormant",
                });
              }
              const call = rt.getCall(callId);
              return json(
                call ? { found: true, call } : { found: false, message: "🐚 Call not found" },
              );
            }

            default:
              throw new Error(`🐚 Unknown action: ${p.action}`);
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Service registration
    api.registerService({
      id: "shellphone",
      start: async () => {
        if (!config.enabled) return;
        try {
          await ensureRuntime();
          api.logger.info("[shellphone] 🐚 Shell is ready to receive calls from the deep");
        } catch (err) {
          api.logger.error(
            `[shellphone] 🐚 Failed to emerge: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
      stop: async () => {
        if (runtime) {
          await runtime.stop();
          runtime = null;
          runtimePromise = null;
          api.logger.info("[shellphone] 🐚 Shell returns to the depths");
        }
      },
    });
  },
};

export default shellphonePlugin;
