/**
 * Voice Call Open Runtime
 *
 * Manages the lifecycle of the voice call plugin:
 * - Initializes STT/TTS providers
 * - Sets up webhook server for Twilio
 * - Coordinates pipeline execution
 */

import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type {
  VoiceCallOpenConfig,
  CallRecord,
  CallState,
  NormalizedEvent,
  TerminalStates,
  ConversationMessage,
} from "./types.js";
import { chunkAudio } from "./audio-utils.js";
import { VoicePipeline, type LlmRuntime, type PipelineCallbacks } from "./pipeline.js";
import { WhisperSttProvider } from "./stt/whisper.js";
import { createTtsWithFallback } from "./tts/index.js";

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Logger interface.
 */
interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

/**
 * Core config for LLM access.
 */
interface CoreConfig {
  [key: string]: unknown;
}

/**
 * Stream session for a call.
 */
interface StreamSession {
  callId: string;
  streamSid: string;
  ws: WebSocket;
}

/**
 * Active call entry.
 */
interface ActiveCall {
  record: CallRecord;
  streamSid?: string;
  streamToken?: string;
}

/**
 * Voice Call Open Runtime
 */
export class VoiceCallOpenRuntime {
  readonly config: VoiceCallOpenConfig;
  private coreConfig: CoreConfig | null;
  private logger: Logger;

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private pipeline: VoicePipeline | null = null;
  private stt: WhisperSttProvider | null = null;

  private activeCalls = new Map<string, ActiveCall>();
  private streamSessions = new Map<string, StreamSession>();
  private providerCallIdMap = new Map<string, string>();

  private publicUrl: string | null = null;

  constructor(params: {
    config: VoiceCallOpenConfig;
    coreConfig?: CoreConfig;
    llmRuntime?: LlmRuntime;
    logger?: Logger;
  }) {
    this.config = params.config;
    this.coreConfig = params.coreConfig ?? null;
    this.logger = params.logger ?? console;
  }

  /**
   * Start the runtime.
   */
  async start(): Promise<string> {
    this.logger.info("[shellphone] 🐚 Starting runtime...");

    // Initialize STT
    this.stt = new WhisperSttProvider(this.config.stt.whisper);
    await this.stt.start();
    this.logger.info("[shellphone] 🐚 Whisper STT ready");

    // Initialize TTS
    const tts = createTtsWithFallback(this.config.tts);
    await tts.isReady();
    this.logger.info("[shellphone] 🐚 TTS ready");

    // Create LLM runtime wrapper
    const llm = this.createLlmRuntime();

    // Create pipeline
    const callbacks: PipelineCallbacks = {
      onSpeechStart: (callId) => {
        this.logger.debug(`[shellphone] 🐚 Speech started: ${callId}`);
        // Interrupt any current TTS playback
        this.clearTtsQueue(callId);
      },
      onTranscript: (callId, text) => {
        this.logger.info(`[shellphone] 🐚 Transcript: ${text}`);
      },
      onResponse: (callId, text) => {
        this.logger.info(`[shellphone] 🐚 Response: ${text}`);
      },
      onAudio: (callId, audio) => {
        this.sendAudioToStream(callId, audio);
      },
      onError: (callId, error) => {
        this.logger.error(`[shellphone] 🐚 Pipeline error: ${error.message}`);
      },
    };

    this.pipeline = new VoicePipeline({
      config: {
        stt: this.config.stt,
        tts: this.config.tts,
        vad: this.config.vad,
        llm: this.config.llm,
      },
      stt: this.stt,
      tts,
      llm,
      callbacks,
    });

    // Start webhook server
    const localUrl = await this.startServer();

    // Determine public URL
    this.publicUrl = this.config.publicUrl ?? localUrl;

    this.logger.info(`[shellphone] 🐚 Runtime started`);
    this.logger.info(`[shellphone] 🐚 Webhook URL: ${this.publicUrl}`);

    return this.publicUrl;
  }

  /**
   * Stop the runtime.
   */
  async stop(): Promise<void> {
    this.logger.info("[shellphone] 🐚 Stopping runtime...");

    // Close all stream sessions
    for (const session of this.streamSessions.values()) {
      session.ws.close();
    }
    this.streamSessions.clear();

    // Stop server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Stop STT
    if (this.stt) {
      await this.stt.stop();
      this.stt = null;
    }

    this.logger.info("[shellphone] 🐚 Runtime stopped");
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(
    to: string,
    options?: { message?: string; mode?: "notify" | "conversation" },
  ): Promise<{ callId: string; success: boolean; error?: string }> {
    const callId = crypto.randomUUID();
    const from = this.config.fromNumber;

    if (!from) {
      return { callId: "", success: false, error: "fromNumber not configured" };
    }

    const call: CallRecord = {
      callId,
      provider: this.config.provider,
      direction: "outbound",
      state: "initiated",
      from,
      to,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: options?.message,
        mode: options?.mode ?? "conversation",
      },
    };

    const streamToken = crypto.randomBytes(16).toString("base64url");

    this.activeCalls.set(callId, { record: call, streamToken });

    // Initialize pipeline context
    const systemPrompt =
      this.config.llm.systemPrompt ||
      `You are a helpful voice assistant on a phone call with ${to}. Keep responses brief and conversational.`;
    this.pipeline?.initCall(callId, call, systemPrompt);

    // For mock provider, simulate connection
    if (this.config.provider === "mock") {
      setTimeout(() => {
        this.processEvent({
          id: crypto.randomUUID(),
          type: "call.answered",
          callId,
          timestamp: Date.now(),
        });
      }, 500);
      return { callId, success: true };
    }

    // For Twilio, make API call
    try {
      const result = await this.twilioInitiateCall(callId, from, to, streamToken);
      call.providerCallId = result.providerCallId;
      this.providerCallIdMap.set(result.providerCallId, callId);
      return { callId, success: true };
    } catch (err) {
      call.state = "failed";
      call.endedAt = Date.now();
      this.activeCalls.delete(callId);
      return {
        callId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * End an active call.
   */
  async endCall(callId: string): Promise<{ success: boolean; error?: string }> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return { success: false, error: "Call not found" };
    }

    // End pipeline
    await this.pipeline?.endCall(callId);

    // For Twilio, hang up
    if (this.config.provider === "twilio" && call.record.providerCallId) {
      try {
        await this.twilioHangup(call.record.providerCallId);
      } catch (err) {
        this.logger.warn(`[shellphone] 🐚 Hangup failed: ${err}`);
      }
    }

    // Update state
    call.record.state = "hangup-bot";
    call.record.endedAt = Date.now();
    this.activeCalls.delete(callId);

    if (call.record.providerCallId) {
      this.providerCallIdMap.delete(call.record.providerCallId);
    }

    return { success: true };
  }

  /**
   * Speak a message on an active call.
   */
  async speak(callId: string, text: string): Promise<{ success: boolean; error?: string }> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return { success: false, error: "Call not found" };
    }

    try {
      await this.pipeline?.speak(callId, text);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get an active call.
   */
  getCall(callId: string): CallRecord | undefined {
    return this.activeCalls.get(callId)?.record;
  }

  /**
   * Get call by provider call ID.
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    const callId = this.providerCallIdMap.get(providerCallId);
    if (!callId) return undefined;
    return this.activeCalls.get(callId)?.record;
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  private createLlmRuntime(): LlmRuntime {
    // This is a placeholder - in real implementation, this would use OpenCore's
    // runtime.llm interface. For now, return a simple mock.
    return {
      generateResponse: async (params: {
        messages: ConversationMessage[];
        maxTokens?: number;
        temperature?: number;
      }) => {
        // In production, this would call OpenCore's LLM
        // For now, return a placeholder
        const lastUserMsg = params.messages.filter((m) => m.role === "user").pop();

        if (!lastUserMsg) {
          return { text: "I didn't catch that. Could you repeat?" };
        }

        // Simple echo for testing
        return {
          text: `I heard you say: "${lastUserMsg.content}". How can I help with that?`,
        };
      },
    };
  }

  private async startServer(): Promise<string> {
    const { port, bind, path: webhookPath, streamPath } = this.config.serve;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          this.logger.error(`[shellphone] 🐚 Request error: ${err}`);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // WebSocket for media streams
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => this.handleStreamConnection(ws, req));

      this.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);
        if (url.pathname === streamPath) {
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.wss!.emit("connection", ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        this.logger.info(`[shellphone] 🐚 Server listening on ${url}`);
        resolve(url);
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (!url.pathname.startsWith(webhookPath)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const body = await this.readBody(req);
    const params = new URLSearchParams(body);
    const callIdFromQuery = url.searchParams.get("callId") ?? undefined;

    // Parse Twilio event
    const event = this.parseTwilioEvent(params, callIdFromQuery);
    if (event) {
      this.processEvent(event);
    }

    // Return TwiML
    const twiml = this.generateTwiml(params, callIdFromQuery);
    res.setHeader("Content-Type", "application/xml");
    res.end(twiml);
  }

  private parseTwilioEvent(
    params: URLSearchParams,
    callIdOverride?: string,
  ): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";
    const callStatus = params.get("CallStatus");

    const callId = callIdOverride || this.providerCallIdMap.get(callSid) || callSid;

    const baseEvent = {
      id: crypto.randomUUID(),
      callId,
      providerCallId: callSid,
      timestamp: Date.now(),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    switch (callStatus) {
      case "initiated":
        return { ...baseEvent, type: "call.initiated" };
      case "ringing":
        return { ...baseEvent, type: "call.ringing" };
      case "in-progress":
        return { ...baseEvent, type: "call.answered" };
      case "completed":
      case "busy":
      case "no-answer":
      case "failed":
        return { ...baseEvent, type: "call.ended", reason: callStatus };
      case "canceled":
        return { ...baseEvent, type: "call.ended", reason: "hangup-bot" };
      default:
        return null;
    }
  }

  private processEvent(event: NormalizedEvent): void {
    const call = this.activeCalls.get(event.callId);
    if (!call) return;

    // Update provider call ID mapping
    if (event.providerCallId && !call.record.providerCallId) {
      call.record.providerCallId = event.providerCallId;
      this.providerCallIdMap.set(event.providerCallId, event.callId);
    }

    // Process event
    switch (event.type) {
      case "call.initiated":
        call.record.state = "initiated";
        break;
      case "call.ringing":
        call.record.state = "ringing";
        break;
      case "call.answered":
        call.record.state = "answered";
        call.record.answeredAt = event.timestamp;
        break;
      case "call.ended":
        call.record.state = (event.reason as CallState) || "completed";
        call.record.endedAt = event.timestamp;
        this.pipeline?.endCall(event.callId);
        this.activeCalls.delete(event.callId);
        if (call.record.providerCallId) {
          this.providerCallIdMap.delete(call.record.providerCallId);
        }
        break;
    }
  }

  private generateTwiml(params: URLSearchParams, callIdFromQuery?: string): string {
    const callSid = params.get("CallSid") || "";
    const callStatus = params.get("CallStatus");

    if (callStatus !== "in-progress") {
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }

    // Get stream URL
    const streamUrl = this.getStreamUrl(callSid);
    if (!streamUrl) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="30"/></Response>';
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${this.escapeXml(streamUrl)}" />
  </Connect>
</Response>`;
  }

  private getStreamUrl(callSid: string): string | null {
    if (!this.publicUrl) return null;

    const call = this.getCallByProviderCallId(callSid);
    const activeCall = call ? this.activeCalls.get(call.callId) : undefined;
    const token = activeCall?.streamToken;

    if (!token) return null;

    const url = new URL(this.publicUrl);
    const wsUrl = url.origin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

    return `${wsUrl}${this.config.serve.streamPath}?token=${token}`;
  }

  private handleStreamConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    let session: StreamSession | null = null;

    ws.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.event) {
          case "connected":
            this.logger.debug("[shellphone] 🐚 Media stream connected");
            break;

          case "start":
            session = this.handleStreamStart(ws, msg, token);
            break;

          case "media":
            if (session && msg.media?.payload) {
              const audio = Buffer.from(msg.media.payload, "base64");
              await this.pipeline?.processAudio(session.callId, audio);
            }
            break;

          case "stop":
            if (session) {
              this.handleStreamStop(session);
              session = null;
            }
            break;
        }
      } catch (err) {
        this.logger.error(`[shellphone] 🐚 Stream message error: ${err}`);
      }
    });

    ws.on("close", () => {
      if (session) {
        this.handleStreamStop(session);
      }
    });

    ws.on("error", (err) => {
      this.logger.error(`[shellphone] 🐚 WebSocket error: ${err}`);
    });
  }

  private handleStreamStart(
    ws: WebSocket,
    msg: { streamSid?: string; start?: { callSid?: string } },
    token: string | null,
  ): StreamSession | null {
    const streamSid = msg.streamSid || "";
    const callSid = msg.start?.callSid || "";

    // Validate token
    const call = this.getCallByProviderCallId(callSid);
    if (!call) {
      this.logger.warn(`[shellphone] 🐚 Unknown call: ${callSid}`);
      ws.close(1008, "Unknown call");
      return null;
    }

    const activeCall = this.activeCalls.get(call.callId);
    if (activeCall?.streamToken !== token) {
      this.logger.warn(`[shellphone] 🐚 Invalid stream token`);
      ws.close(1008, "Invalid token");
      return null;
    }

    const session: StreamSession = {
      callId: call.callId,
      streamSid,
      ws,
    };

    activeCall.streamSid = streamSid;
    this.streamSessions.set(streamSid, session);

    this.logger.info(`[shellphone] 🐚 Stream started: ${callSid} -> ${streamSid}`);

    // Speak initial message if set
    const initialMsg = call.metadata?.initialMessage as string | undefined;
    if (initialMsg) {
      setTimeout(() => {
        this.speak(call.callId, initialMsg).catch((err) => {
          this.logger.warn(`[shellphone] 🐚 Failed to speak initial message: ${err}`);
        });
      }, 500);
    }

    return session;
  }

  private handleStreamStop(session: StreamSession): void {
    this.logger.info(`[shellphone] 🐚 Stream stopped: ${session.streamSid}`);
    this.streamSessions.delete(session.streamSid);
  }

  private sendAudioToStream(callId: string, audio: Buffer): void {
    const call = this.activeCalls.get(callId);
    if (!call?.streamSid) return;

    const session = this.streamSessions.get(call.streamSid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: call.streamSid,
        media: { payload: audio.toString("base64") },
      }),
    );
  }

  private clearTtsQueue(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call?.streamSid) return;

    const session = this.streamSessions.get(call.streamSid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        event: "clear",
        streamSid: call.streamSid,
      }),
    );
  }

  private async twilioInitiateCall(
    callId: string,
    from: string,
    to: string,
    streamToken: string,
  ): Promise<{ providerCallId: string }> {
    const { accountSid, authToken } = this.config.twilio;
    if (!accountSid || !authToken) {
      throw new Error("Twilio credentials not configured");
    }

    const webhookUrl = new URL(this.publicUrl!);
    webhookUrl.searchParams.set("callId", callId);

    const statusUrl = new URL(this.publicUrl!);
    statusUrl.searchParams.set("callId", callId);
    statusUrl.searchParams.set("type", "status");

    const body = new URLSearchParams({
      To: to,
      From: from,
      Url: webhookUrl.toString(),
      StatusCallback: statusUrl.toString(),
      StatusCallbackEvent: "initiated,ringing,answered,completed",
      Timeout: "30",
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twilio API error: ${response.status} ${text}`);
    }

    const result = (await response.json()) as { sid: string };
    return { providerCallId: result.sid };
  }

  private async twilioHangup(providerCallId: string): Promise<void> {
    const { accountSid, authToken } = this.config.twilio;
    if (!accountSid || !authToken) return;

    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Status: "completed" }).toString(),
      },
    );
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error("Payload too large"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}

export default VoiceCallOpenRuntime;
