/**
 * Phone Plugin — OpenClaw Plugin Entry Point
 *
 * Integrates Twilio for AI-powered outbound phone calls using
 * OpenAI's Realtime API for natural conversation.
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { IncomingMessage, ServerResponse, createServer, Server } from "node:http";
import { homedir } from "node:os";
import { WebSocketServer, WebSocket as WS } from "ws";
import type {
  PhonePluginConfig,
  CallState,
  CallStatus,
  CallResult,
  CallHistoryEntry,
  TranscriptEntry,
  TwilioMediaStreamMessage,
  CallOutcome,
  PhoneLogger,
} from "./types.js";
import { RealtimeHandler } from "./realtime-handler.js";
import { TwilioClient } from "./twilio-client.js";

// =============================================================================
// Config Parser
// =============================================================================

function parseConfig(raw: unknown): PhonePluginConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cfg = raw as Record<string, unknown>;

  if (!cfg.enabled) {
    return null;
  }

  const accountSid = cfg.accountSid as string;
  const authToken = cfg.authToken as string;
  const phoneNumber = cfg.phoneNumber as string;

  if (!accountSid || !authToken || !phoneNumber) {
    throw new Error("phone: accountSid, authToken, and phoneNumber are required");
  }

  return {
    enabled: true,
    provider: "twilio",
    accountSid,
    authToken,
    phoneNumber,
    realtimeModel: (cfg.realtimeModel as string) ?? "gpt-4o-realtime-preview-2024-12-17",
    defaultVoice: (cfg.defaultVoice as PhonePluginConfig["defaultVoice"]) ?? "alloy",
    maxCallDuration: (cfg.maxCallDuration as number) ?? 600,
    recordCalls: (cfg.recordCalls as boolean) ?? true,
    transcriptsDir: (cfg.transcriptsDir as string) ?? "~/.openclaw/phone/transcripts",
    webhookPort: (cfg.webhookPort as number) ?? 18790,
    webhookHost: (cfg.webhookHost as string) ?? undefined,
    openaiApiKey: (cfg.openaiApiKey as string) ?? process.env.OPENAI_API_KEY,
  };
}

// =============================================================================
// Call Manager
// =============================================================================

class CallManager {
  private activeCalls = new Map<string, CallState>();
  private twilioClient: TwilioClient;
  private config: PhonePluginConfig;
  private logger: PhoneLogger;
  private transcriptsDir: string;
  private historyFile: string;
  private webhookServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private resolvedWebhookHost: string;

  constructor(config: PhonePluginConfig, logger: PhoneLogger, resolvePath: (p: string) => string) {
    this.config = config;
    this.logger = logger;
    this.twilioClient = new TwilioClient(config, logger);
    this.transcriptsDir = resolvePath(config.transcriptsDir);
    this.historyFile = `${this.transcriptsDir}/../call-history.json`;
    this.resolvedWebhookHost = config.webhookHost ?? `http://localhost:${config.webhookPort}`;

    // Ensure directories exist
    mkdirSync(this.transcriptsDir, { recursive: true });
  }

  /**
   * Start the webhook server for Twilio callbacks.
   */
  async startWebhookServer(): Promise<void> {
    const port = this.config.webhookPort ?? 18790;

    this.webhookServer = createServer((req, res) => {
      this.handleWebhook(req, res).catch((err) => {
        this.logger.error(`phone: webhook error: ${err}`);
        res.writeHead(500);
        res.end("Internal error");
      });
    });

    // WebSocket server for Twilio Media Streams
    this.wsServer = new WebSocketServer({ server: this.webhookServer });

    this.wsServer.on("connection", (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    return new Promise((resolve) => {
      this.webhookServer!.listen(port, () => {
        this.logger.info(`phone: webhook server listening on port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  stopWebhookServer(): void {
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
  }

  /**
   * Handle HTTP webhook from Twilio.
   */
  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Parse body for POST requests
    let body: Record<string, string> = {};
    if (req.method === "POST") {
      body = await this.parseFormBody(req);
    }

    this.logger.info(`phone: webhook ${req.method} ${path}`);

    // Route handlers
    if (path.startsWith("/phone/twiml/")) {
      const callId = path.split("/")[3];
      return this.handleTwimlRequest(callId, res);
    }

    if (path.startsWith("/phone/status/")) {
      const callId = path.split("/")[3];
      return this.handleStatusCallback(callId, body, res);
    }

    if (path.startsWith("/phone/amd/")) {
      const callId = path.split("/")[3];
      return this.handleAmdCallback(callId, body, res);
    }

    // Unknown path
    res.writeHead(404);
    res.end("Not found");
  }

  /**
   * Parse URL-encoded form body.
   */
  private parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const params = new URLSearchParams(data);
        const result: Record<string, string> = {};
        params.forEach((value, key) => {
          result[key] = value;
        });
        resolve(result);
      });
    });
  }

  /**
   * Handle TwiML request - return WebSocket stream configuration.
   */
  private handleTwimlRequest(callId: string, res: ServerResponse): void {
    const call = this.activeCalls.get(callId);
    if (!call) {
      res.writeHead(404);
      res.end(this.twilioClient.generateTwiML({ say: "Call not found", hangup: true }));
      return;
    }

    // WebSocket URL for media streaming
    const wsUrl = this.resolvedWebhookHost.replace("http", "ws") + `/phone/media/${callId}`;

    const twiml = this.twilioClient.generateStreamTwiML({
      wsUrl,
      callId,
    });

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml);
  }

  /**
   * Handle status callback from Twilio.
   */
  private handleStatusCallback(
    callId: string,
    body: Record<string, string>,
    res: ServerResponse,
  ): void {
    const call = this.activeCalls.get(callId);
    if (!call) {
      res.writeHead(200);
      res.end();
      return;
    }

    const status = body.CallStatus?.toLowerCase() as CallStatus;
    this.logger.info(`phone: call ${callId} status: ${status}`);

    // Update call state
    call.status = this.mapTwilioStatus(status);

    if (status === "in-progress" && !call.connectedAt) {
      call.connectedAt = new Date();
    }

    if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
      call.endedAt = new Date();
      if (call.connectedAt) {
        call.duration = Math.floor((call.endedAt.getTime() - call.connectedAt.getTime()) / 1000);
      }

      // Save transcript and update history
      this.finalizeCall(callId);
    }

    res.writeHead(200);
    res.end();
  }

  /**
   * Handle answering machine detection callback.
   */
  private handleAmdCallback(
    callId: string,
    body: Record<string, string>,
    res: ServerResponse,
  ): void {
    const call = this.activeCalls.get(callId);
    const answeredBy = body.AnsweredBy;

    if (call && answeredBy) {
      this.logger.info(`phone: call ${callId} answered by: ${answeredBy}`);

      if (answeredBy.startsWith("machine")) {
        call.voicemailDetected = true;
        // The realtime handler will detect this and leave a voicemail message
      }
    }

    res.writeHead(200);
    res.end();
  }

  /**
   * Handle WebSocket connection for Twilio Media Streams.
   */
  private handleWebSocketConnection(ws: WS, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathParts = url.pathname.split("/");
    const callId = pathParts[3];

    const call = this.activeCalls.get(callId);
    if (!call) {
      this.logger.error(`phone: WebSocket connection for unknown call: ${callId}`);
      ws.close();
      return;
    }

    this.logger.info(`phone: WebSocket connected for call ${callId}`);

    // Create Realtime handler
    if (!this.config.openaiApiKey) {
      this.logger.error("phone: OpenAI API key not configured");
      ws.close();
      return;
    }

    const realtimeHandler = new RealtimeHandler({
      apiKey: this.config.openaiApiKey,
      model: this.config.realtimeModel,
      voice: this.config.defaultVoice,
      task: call.task,
      context: call.context,
      maxDuration: this.config.maxCallDuration,
      logger: this.logger,
      onTranscript: (entry) => {
        call.transcript.push(entry);
      },
      onAudioDelta: (audio) => {
        // Send audio back to Twilio
        if (ws.readyState === ws.OPEN && call.streamSid) {
          const message = {
            event: "media",
            streamSid: call.streamSid,
            media: {
              payload: audio.toString("base64"),
            },
          };
          ws.send(JSON.stringify(message));
        }
      },
      onError: (error) => {
        this.logger.error(`phone: Realtime error for call ${callId}: ${error.message}`);
        call.error = error.message;
      },
      onEnd: (outcome) => {
        call.outcome = outcome;
        // Hang up the Twilio call
        this.twilioClient.hangup(call.callSid).catch((err) => {
          this.logger.error(`phone: failed to hang up: ${err}`);
        });
      },
    });

    // Connect to OpenAI Realtime
    realtimeHandler.connect().catch((err) => {
      this.logger.error(`phone: failed to connect to Realtime API: ${err}`);
      call.error = `Realtime connection failed: ${err.message}`;
      ws.close();
    });

    // Handle messages from Twilio
    ws.on("message", (data) => {
      try {
        const message: TwilioMediaStreamMessage = JSON.parse(data.toString());

        // Capture stream SID
        if (message.event === "start" && message.start?.streamSid) {
          call.streamSid = message.start.streamSid;
        }

        // Forward to realtime handler
        realtimeHandler.handleTwilioMedia(message);
      } catch (err) {
        this.logger.error(`phone: failed to parse Twilio message: ${err}`);
      }
    });

    ws.on("close", () => {
      this.logger.info(`phone: WebSocket closed for call ${callId}`);
      realtimeHandler.disconnect();
    });

    ws.on("error", (err) => {
      this.logger.error(`phone: WebSocket error for call ${callId}: ${err}`);
      realtimeHandler.disconnect();
    });
  }

  /**
   * Initiate an outbound call.
   */
  async makeCall(params: { to: string; task: string; context?: string }): Promise<string> {
    const callId = randomUUID().slice(0, 8);

    // Create call state
    const callState: CallState = {
      id: callId,
      callSid: "",
      to: this.normalizePhoneNumber(params.to),
      from: this.twilioClient.getPhoneNumber(),
      task: params.task,
      context: params.context,
      status: "initiating",
      startedAt: new Date(),
      transcript: [],
    };

    this.activeCalls.set(callId, callState);

    try {
      // Initiate call via Twilio
      const result = await this.twilioClient.initiateCall({
        to: callState.to,
        from: callState.from,
        url: `${this.resolvedWebhookHost}/phone/twiml/${callId}`,
        statusCallback: `${this.resolvedWebhookHost}/phone/status/${callId}`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd",
        timeout: 30,
        record: this.config.recordCalls,
      });

      callState.callSid = result.callSid;
      callState.status = this.mapTwilioStatus(result.status);

      this.logger.info(`phone: call initiated, id: ${callId}, sid: ${result.callSid}`);

      return callId;
    } catch (err) {
      callState.status = "failed";
      callState.error = err instanceof Error ? err.message : String(err);
      this.finalizeCall(callId);
      throw err;
    }
  }

  /**
   * Get call status.
   */
  getCallStatus(callId: string): CallResult | null {
    const call = this.activeCalls.get(callId);
    if (!call) {
      // Check history
      const history = this.loadHistory();
      const entry = history.find((h) => h.id === callId);
      if (entry) {
        return {
          callId: entry.id,
          status: entry.status,
          duration: entry.duration,
          transcript: this.loadTranscript(callId),
          outcome: entry.outcome,
        };
      }
      return null;
    }

    return {
      callId: call.id,
      status: call.status,
      duration: call.duration,
      transcript: this.formatTranscript(call.transcript),
      outcome: call.outcome,
      error: call.error,
    };
  }

  /**
   * Get call history.
   */
  getHistory(limit = 20): CallHistoryEntry[] {
    const history = this.loadHistory();
    return history.slice(-limit).toReversed();
  }

  /**
   * Finalize a call - save transcript and update history.
   */
  private finalizeCall(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return;
    }

    // Save transcript
    const transcriptPath = `${this.transcriptsDir}/${callId}.json`;
    writeFileSync(
      transcriptPath,
      JSON.stringify(
        {
          id: call.id,
          to: call.to,
          task: call.task,
          context: call.context,
          status: call.status,
          startedAt: call.startedAt.toISOString(),
          endedAt: call.endedAt?.toISOString(),
          duration: call.duration,
          transcript: call.transcript,
          outcome: call.outcome,
          error: call.error,
        },
        null,
        2,
      ),
    );

    // Update history
    const history = this.loadHistory();
    history.push({
      id: call.id,
      to: call.to,
      task: call.task,
      status: call.status,
      startedAt: call.startedAt.toISOString(),
      duration: call.duration,
      outcome: call.outcome,
      transcriptPath,
    });
    this.saveHistory(history);

    // Remove from active calls
    this.activeCalls.delete(callId);

    this.logger.info(`phone: call ${callId} finalized, status: ${call.status}`);
  }

  /**
   * Format transcript for output.
   */
  private formatTranscript(entries: TranscriptEntry[]): string {
    return entries.map((e) => `[${e.role.toUpperCase()}] ${e.text}`).join("\n");
  }

  /**
   * Load transcript from file.
   */
  private loadTranscript(callId: string): string {
    const path = `${this.transcriptsDir}/${callId}.json`;
    if (!existsSync(path)) {
      return "";
    }
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return this.formatTranscript(data.transcript ?? []);
    } catch {
      return "";
    }
  }

  /**
   * Load call history.
   */
  private loadHistory(): CallHistoryEntry[] {
    if (!existsSync(this.historyFile)) {
      return [];
    }
    try {
      return JSON.parse(readFileSync(this.historyFile, "utf8"));
    } catch {
      return [];
    }
  }

  /**
   * Save call history.
   */
  private saveHistory(history: CallHistoryEntry[]): void {
    mkdirSync(this.transcriptsDir.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
  }

  /**
   * Map Twilio status to our status.
   */
  private mapTwilioStatus(status: string): CallStatus {
    const map: Record<string, CallStatus> = {
      queued: "initiating",
      initiated: "initiating",
      ringing: "ringing",
      "in-progress": "in-progress",
      completed: "completed",
      failed: "failed",
      busy: "busy",
      "no-answer": "no-answer",
      canceled: "canceled",
    };
    return map[status] ?? "failed";
  }

  /**
   * Normalize phone number to E.164 format.
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove non-digits except leading +
    let normalized = phone.replace(/[^\d+]/g, "");

    // Ensure E.164 format
    if (!normalized.startsWith("+")) {
      // Assume US if no country code
      if (normalized.length === 10) {
        normalized = "+1" + normalized;
      } else if (normalized.length === 11 && normalized.startsWith("1")) {
        normalized = "+" + normalized;
      }
    }

    return normalized;
  }
}

// =============================================================================
// Plugin Definition
// =============================================================================

const phonePlugin = {
  id: "phone",
  name: "Phone",
  description:
    "AI-powered phone calls via Twilio and OpenAI Realtime API. " +
    "Make outbound calls with an AI agent that can conduct natural conversations.",

  register(api: any) {
    const cfg = parseConfig(api.pluginConfig);
    if (!cfg) {
      api.logger.info("phone: plugin disabled or not configured");
      return;
    }

    if (!cfg.openaiApiKey) {
      api.logger.error(
        "phone: OpenAI API key required (set openaiApiKey in config or OPENAI_API_KEY env)",
      );
      return;
    }

    const callManager = new CallManager(cfg, api.logger, api.resolvePath);

    api.logger.info(`phone: registered (provider: ${cfg.provider}, number: ${cfg.phoneNumber})`);

    // ==================================================================
    // Tool: phone_call
    // ==================================================================

    api.registerTool(
      {
        name: "phone_call",
        label: "Phone Call",
        description:
          "Make an outbound phone call with an AI agent. The agent will conduct a natural " +
          "conversation to accomplish the specified task.",
        parameters: Type.Object({
          to: Type.String({ description: "Phone number to call (E.164 or 10-digit US)" }),
          task: Type.String({
            description:
              "What the AI should accomplish on the call (e.g., 'Schedule an appointment for next Tuesday')",
          }),
          context: Type.Optional(
            Type.String({
              description:
                "Additional context to help the AI (e.g., 'Speaking with Dr. Smith\\'s office, patient name is John Doe')",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            if (!params.to) {
              return {
                content: [{ type: "text", text: "❌ Phone number is required" }],
                details: { error: true },
              };
            }
            if (!params.task) {
              return {
                content: [{ type: "text", text: "❌ Task description is required" }],
                details: { error: true },
              };
            }

            api.logger.info(`phone: initiating call to ${params.to} for task: ${params.task}`);

            const callId = await callManager.makeCall({
              to: params.to,
              task: params.task,
              context: params.context,
            });

            // Wait for call to complete (poll status)
            const maxWait = (cfg.maxCallDuration + 60) * 1000; // Max duration + 1 min buffer
            const pollInterval = 2000;
            let elapsed = 0;

            while (elapsed < maxWait) {
              await new Promise((r) => setTimeout(r, pollInterval));
              elapsed += pollInterval;

              const result = callManager.getCallStatus(callId);
              if (!result) {
                break;
              }

              // Check if call is finished
              if (
                ["completed", "failed", "busy", "no-answer", "canceled"].includes(result.status)
              ) {
                const statusEmoji = result.status === "completed" ? "✅" : "❌";
                const outcomeText = result.outcome
                  ? `\n\n**Outcome:**\n${result.outcome.summary}${
                      result.outcome.nextSteps?.length
                        ? `\n\n**Next Steps:**\n${result.outcome.nextSteps.map((s) => `• ${s}`).join("\n")}`
                        : ""
                    }`
                  : "";

                const transcriptText = result.transcript
                  ? `\n\n**Transcript:**\n${result.transcript}`
                  : "";

                return {
                  content: [
                    {
                      type: "text",
                      text:
                        `${statusEmoji} Call ${result.status}\n\n` +
                        `📞 To: ${params.to}\n` +
                        `⏱️ Duration: ${result.duration ?? 0}s` +
                        outcomeText +
                        transcriptText +
                        (result.error ? `\n\n**Error:** ${result.error}` : ""),
                    },
                  ],
                  details: result,
                };
              }
            }

            // Timeout
            return {
              content: [
                {
                  type: "text",
                  text: `⏱️ Call timed out. Check status with phone_status tool using ID: ${callId}`,
                },
              ],
              details: { callId, status: "timeout" },
            };
          } catch (err: any) {
            api.logger.error(`phone: call failed: ${err.message}`);
            return {
              content: [{ type: "text", text: `❌ Call failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "phone_call" },
    );

    // ==================================================================
    // Tool: phone_status
    // ==================================================================

    api.registerTool(
      {
        name: "phone_status",
        label: "Phone Call Status",
        description: "Check the status of an ongoing or recent phone call.",
        parameters: Type.Object({
          callId: Type.String({ description: "The call ID to check" }),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const result = callManager.getCallStatus(params.callId);
            if (!result) {
              return {
                content: [{ type: "text", text: `❌ Call not found: ${params.callId}` }],
                details: { error: true },
              };
            }

            const statusEmoji =
              result.status === "completed"
                ? "✅"
                : result.status === "in-progress"
                  ? "🔄"
                  : result.status === "ringing"
                    ? "📞"
                    : "❌";

            return {
              content: [
                {
                  type: "text",
                  text:
                    `${statusEmoji} Call ${result.status}\n\n` +
                    `ID: ${result.callId}\n` +
                    `Duration: ${result.duration ?? 0}s` +
                    (result.outcome ? `\n\nOutcome: ${result.outcome.summary}` : "") +
                    (result.transcript ? `\n\nTranscript:\n${result.transcript}` : "") +
                    (result.error ? `\n\nError: ${result.error}` : ""),
                },
              ],
              details: result,
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `❌ Status check failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "phone_status" },
    );

    // ==================================================================
    // Tool: phone_history
    // ==================================================================

    api.registerTool(
      {
        name: "phone_history",
        label: "Phone Call History",
        description: "Get past phone call transcripts and outcomes.",
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Number({ description: "Maximum number of calls to return (default: 10)" }),
          ),
          callId: Type.Optional(
            Type.String({ description: "Specific call ID to retrieve full transcript" }),
          ),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            // Specific call lookup
            if (params.callId) {
              const result = callManager.getCallStatus(params.callId);
              if (!result) {
                return {
                  content: [{ type: "text", text: `❌ Call not found: ${params.callId}` }],
                  details: { error: true },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `📞 Call Details\n\n` +
                      `ID: ${result.callId}\n` +
                      `Status: ${result.status}\n` +
                      `Duration: ${result.duration ?? 0}s` +
                      (result.outcome
                        ? `\n\n**Outcome:**\n${result.outcome.summary}` +
                          (result.outcome.taskCompleted ? " ✓" : " ✗")
                        : "") +
                      (result.transcript ? `\n\n**Transcript:**\n${result.transcript}` : ""),
                  },
                ],
                details: result,
              };
            }

            // List recent calls
            const history = callManager.getHistory(params.limit ?? 10);

            if (history.length === 0) {
              return {
                content: [{ type: "text", text: "📞 No call history yet." }],
                details: { count: 0 },
              };
            }

            const lines = history.map((h, i) => {
              const emoji = h.status === "completed" ? "✅" : "❌";
              const duration = h.duration ? `${h.duration}s` : "-";
              const outcome = h.outcome?.taskCompleted ? "✓" : h.outcome ? "✗" : "-";
              return `${i + 1}. ${emoji} ${h.to} — ${h.task.slice(0, 40)}${h.task.length > 40 ? "…" : ""}\n   ${h.startedAt.slice(0, 16)} | ${duration} | Task: ${outcome} | ID: ${h.id}`;
            });

            return {
              content: [
                {
                  type: "text",
                  text: `📞 Call History (${history.length} calls)\n\n${lines.join("\n\n")}`,
                },
              ],
              details: { count: history.length, calls: history },
            };
          } catch (err: any) {
            return {
              content: [
                { type: "text", text: `❌ History retrieval failed: ${err.message ?? err}` },
              ],
              details: { error: true },
            };
          }
        },
      },
      { name: "phone_history" },
    );

    // ==================================================================
    // Service: Webhook Server
    // ==================================================================

    api.registerService({
      id: "phone",
      start: async () => {
        await callManager.startWebhookServer();
        api.logger.info("phone: service started");
      },
      stop: async () => {
        callManager.stopWebhookServer();
        api.logger.info("phone: service stopped");
      },
    });
  },
};

export default phonePlugin;
