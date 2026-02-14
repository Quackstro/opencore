/**
 * Phone Plugin — OpenAI Realtime API Handler
 *
 * Manages bidirectional audio streaming between Twilio Media Streams
 * and OpenAI's Realtime API for voice conversations.
 */

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type {
  CallState,
  TranscriptEntry,
  RealtimeSessionConfig,
  RealtimeServerEvent,
  RealtimeClientEvent,
  RealtimeVoice,
  TwilioMediaStreamMessage,
  PhoneLogger,
  CallOutcome,
} from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

// =============================================================================
// Realtime Session Handler
// =============================================================================

export interface RealtimeHandlerOptions {
  apiKey: string;
  model: string;
  voice: RealtimeVoice;
  task: string;
  context?: string;
  maxDuration: number;
  logger: PhoneLogger;
  onTranscript?: (entry: TranscriptEntry) => void;
  onAudioDelta?: (audio: Buffer) => void;
  onError?: (error: Error) => void;
  onEnd?: (outcome: CallOutcome) => void;
}

export class RealtimeHandler extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: RealtimeHandlerOptions;
  private connected = false;
  private sessionId: string | null = null;
  private responseInProgress = false;
  private audioQueue: Buffer[] = [];
  private transcriptBuffer: { assistant: string; user: string } = {
    assistant: "",
    user: "",
  };
  private conversationHistory: TranscriptEntry[] = [];
  private startTime: number = 0;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RealtimeHandlerOptions) {
    super();
    this.options = options;
  }

  /**
   * Connect to OpenAI Realtime API via WebSocket.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(this.options.model)}`;

      this.options.logger.info(`phone:realtime: connecting to ${url}`);

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        this.options.logger.info("phone:realtime: connected");
        this.connected = true;
        this.startTime = Date.now();

        // Configure session
        this.configureSession();

        // Start max duration timer
        if (this.options.maxDuration > 0) {
          this.maxDurationTimer = setTimeout(() => {
            this.options.logger.info(
              `phone:realtime: max duration (${this.options.maxDuration}s) reached, ending call`,
            );
            this.endConversation("max_duration_reached");
          }, this.options.maxDuration * 1000);
        }

        resolve();
      });

      this.ws.on("error", (err) => {
        const error = err instanceof Error ? err : new Error(`WebSocket error: ${err}`);
        this.options.logger.error(`phone:realtime: WebSocket error: ${error.message}`);
        if (!this.connected) {
          reject(error);
        } else {
          this.options.onError?.(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        this.options.logger.info(
          `phone:realtime: disconnected (code: ${code}, reason: ${reason.toString()})`,
        );
        this.connected = false;
        this.cleanup();
        this.emit("close");
      });

      this.ws.on("message", (data) => {
        const str = typeof data === "string" ? data : data.toString("utf8");
        this.handleServerEvent(str);
      });
    });
  }

  /**
   * Configure the Realtime session with instructions.
   */
  private configureSession(): void {
    const instructions = this.buildInstructions();

    const sessionConfig: Partial<RealtimeSessionConfig> = {
      voice: this.options.voice,
      instructions,
      input_audio_format: "g711_ulaw", // Twilio's native format
      output_audio_format: "g711_ulaw",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
      tools: [
        {
          type: "function",
          name: "end_call",
          description:
            "End the phone call when the conversation is complete or the task is accomplished.",
          parameters: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Brief summary of what was accomplished in the call",
              },
              task_completed: {
                type: "boolean",
                description: "Whether the main task was successfully completed",
              },
              next_steps: {
                type: "array",
                items: { type: "string" },
                description: "Any follow-up actions needed",
              },
            },
            required: ["summary", "task_completed"],
          },
        },
        {
          type: "function",
          name: "transfer_to_human",
          description: "Request transfer to a human agent if the AI cannot handle the situation",
          parameters: {
            type: "object",
            properties: {
              reason: {
                type: "string",
                description: "Why transfer is needed",
              },
            },
            required: ["reason"],
          },
        },
      ],
      tool_choice: "auto",
    };

    const event: RealtimeClientEvent = {
      type: "session.update",
      session: sessionConfig,
    };

    this.send(event);
    this.options.logger.info("phone:realtime: session configured");

    // Send initial greeting to start the conversation
    this.sendInitialGreeting();
  }

  /**
   * Build conversation instructions based on task and context.
   */
  private buildInstructions(): string {
    let instructions = `You are an AI assistant making a phone call on behalf of the user.

TASK: ${this.options.task}

${this.options.context ? `ADDITIONAL CONTEXT:\n${this.options.context}\n\n` : ""}

GUIDELINES:
1. Be professional, friendly, and conversational
2. Speak naturally - this is a real phone conversation
3. Listen carefully and respond appropriately to what you hear
4. Stay focused on accomplishing the task
5. If you encounter an issue (wrong number, voicemail, etc.), handle it gracefully
6. Use the end_call function when the conversation is complete
7. Don't be pushy - if the person seems uninterested, politely wrap up
8. If you're talking to a machine/voicemail, leave a brief message and end the call
9. Confirm key information by repeating it back
10. Keep responses concise - this is a phone call, not an essay

VOICEMAIL HANDLING:
- If you detect a voicemail greeting, leave a brief, clear message
- State your name as "an AI assistant calling on behalf of [user]"
- Mention the purpose briefly and suggest they call back

IMPORTANT: Always maintain context of the conversation. Remember what was said earlier.`;

    return instructions;
  }

  /**
   * Send initial greeting to start conversation.
   */
  private sendInitialGreeting(): void {
    // Create an initial response to start the conversation
    const event: RealtimeClientEvent = {
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions:
          "Greet the person and introduce yourself. Briefly explain why you're calling based on the task. Keep it natural and concise.",
      },
    };

    this.send(event);
  }

  /**
   * Handle incoming server events from OpenAI Realtime API.
   */
  private handleServerEvent(data: string | Buffer): void {
    try {
      const event: RealtimeServerEvent = JSON.parse(
        typeof data === "string" ? data : data.toString(),
      );

      switch (event.type) {
        case "session.created":
          this.sessionId = event.session?.id ?? null;
          this.options.logger.info(`phone:realtime: session created: ${this.sessionId}`);
          break;

        case "session.updated":
          this.options.logger.debug?.(`phone:realtime: session updated`);
          break;

        case "response.created":
          this.responseInProgress = true;
          break;

        case "response.done":
          this.responseInProgress = false;
          this.flushTranscriptBuffer("assistant");
          break;

        case "response.audio.delta":
          // Audio chunk from OpenAI - send to Twilio
          if (event.delta) {
            const audioBuffer = Buffer.from(event.delta, "base64");
            this.options.onAudioDelta?.(audioBuffer);
            this.emit("audio", audioBuffer);
          }
          break;

        case "response.audio_transcript.delta":
          // Partial transcript of assistant's speech
          if (event.delta) {
            this.transcriptBuffer.assistant += event.delta;
          }
          break;

        case "response.audio_transcript.done":
          // Complete transcript of assistant's response
          if (event.transcript) {
            const entry: TranscriptEntry = {
              timestamp: new Date(),
              role: "assistant",
              text: event.transcript,
              final: true,
            };
            this.conversationHistory.push(entry);
            this.options.onTranscript?.(entry);
            this.emit("transcript", entry);
            this.transcriptBuffer.assistant = "";
          }
          break;

        case "conversation.item.input_audio_transcription.completed":
          // User's speech transcribed
          if (event.transcript) {
            const entry: TranscriptEntry = {
              timestamp: new Date(),
              role: "user",
              text: event.transcript,
              final: true,
            };
            this.conversationHistory.push(entry);
            this.options.onTranscript?.(entry);
            this.emit("transcript", entry);
          }
          break;

        case "input_audio_buffer.speech_started":
          this.options.logger.debug?.("phone:realtime: user speech started");
          break;

        case "input_audio_buffer.speech_stopped":
          this.options.logger.debug?.("phone:realtime: user speech stopped");
          break;

        case "response.function_call_arguments.done":
          // Function call completed
          this.handleFunctionCall(event);
          break;

        case "error":
          this.options.logger.error(
            `phone:realtime: API error: ${event.error?.message ?? "unknown"}`,
          );
          this.options.onError?.(new Error(event.error?.message ?? "Realtime API error"));
          break;

        case "rate_limits.updated":
          // Rate limit info - log if approaching limits
          this.options.logger.debug?.("phone:realtime: rate limits updated");
          break;

        default:
          // Log unknown events for debugging
          this.options.logger.debug?.(`phone:realtime: unhandled event: ${event.type}`);
      }
    } catch (err) {
      this.options.logger.error(`phone:realtime: failed to parse event: ${err}`);
    }
  }

  /**
   * Handle function calls from the AI.
   */
  private handleFunctionCall(event: RealtimeServerEvent): void {
    const functionName = event.name;
    let args: Record<string, unknown> = {};

    try {
      if (event.arguments) {
        args = JSON.parse(event.arguments);
      }
    } catch {
      this.options.logger.error("phone:realtime: failed to parse function arguments");
    }

    this.options.logger.info(`phone:realtime: function call: ${functionName}`);

    switch (functionName) {
      case "end_call":
        const outcome: CallOutcome = {
          success: true,
          taskCompleted: (args.task_completed as boolean) ?? false,
          summary: (args.summary as string) ?? "Call ended",
          nextSteps: args.next_steps as string[] | undefined,
        };
        this.endConversation("task_complete", outcome);
        break;

      case "transfer_to_human":
        this.options.logger.info(`phone:realtime: transfer requested: ${args.reason}`);
        // Send function result and end
        this.sendFunctionResult(event.call_id!, {
          transferred: false,
          message: "Transfer not available - ending call",
        });
        this.endConversation("transfer_requested", {
          success: false,
          taskCompleted: false,
          summary: `Transfer requested: ${args.reason}`,
        });
        break;

      default:
        this.options.logger.warn(`phone:realtime: unknown function: ${functionName}`);
        if (event.call_id) {
          this.sendFunctionResult(event.call_id, { error: "Unknown function" });
        }
    }
  }

  /**
   * Send function result back to the API.
   */
  private sendFunctionResult(callId: string, output: unknown): void {
    const event: RealtimeClientEvent = {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        // @ts-ignore - extending the type
        call_id: callId,
        output: JSON.stringify(output),
      },
    };
    this.send(event);
  }

  /**
   * Send audio from Twilio to OpenAI Realtime.
   */
  sendAudio(audioBase64: string): void {
    if (!this.connected || !this.ws) {
      return;
    }

    const event: RealtimeClientEvent = {
      type: "input_audio_buffer.append",
      audio: audioBase64,
    };

    this.send(event);
  }

  /**
   * Handle Twilio Media Stream message.
   */
  handleTwilioMedia(message: TwilioMediaStreamMessage): void {
    switch (message.event) {
      case "connected":
        this.options.logger.info("phone:realtime: Twilio stream connected");
        break;

      case "start":
        this.options.logger.info(
          `phone:realtime: Twilio stream started, streamSid: ${message.start?.streamSid}`,
        );
        break;

      case "media":
        // Forward audio to OpenAI
        if (message.media?.payload) {
          this.sendAudio(message.media.payload);
        }
        break;

      case "stop":
        this.options.logger.info("phone:realtime: Twilio stream stopped");
        this.endConversation("stream_stopped");
        break;

      case "mark":
        this.options.logger.debug?.(`phone:realtime: mark received: ${message.mark?.name}`);
        break;
    }
  }

  /**
   * Commit the audio buffer and request a response.
   */
  commitAudioBuffer(): void {
    if (!this.connected || !this.ws) {
      return;
    }

    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }

  /**
   * End the conversation gracefully.
   */
  endConversation(reason: string, outcome?: CallOutcome): void {
    this.options.logger.info(`phone:realtime: ending conversation, reason: ${reason}`);

    const finalOutcome: CallOutcome = outcome ?? {
      success: reason === "task_complete",
      taskCompleted: reason === "task_complete",
      summary: reason,
    };

    this.options.onEnd?.(finalOutcome);
    this.emit("end", finalOutcome);
    this.disconnect();
  }

  /**
   * Flush transcript buffer.
   */
  private flushTranscriptBuffer(role: "assistant" | "user"): void {
    const text = this.transcriptBuffer[role].trim();
    if (text) {
      const entry: TranscriptEntry = {
        timestamp: new Date(),
        role,
        text,
        final: true,
      };
      this.conversationHistory.push(entry);
      this.options.onTranscript?.(entry);
      this.transcriptBuffer[role] = "";
    }
  }

  /**
   * Send event to OpenAI Realtime API.
   */
  private send(event: RealtimeClientEvent): void {
    if (!this.ws || !this.connected) {
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  /**
   * Disconnect from OpenAI Realtime API.
   */
  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.cleanup();
  }

  /**
   * Cleanup resources.
   */
  private cleanup(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    this.connected = false;
  }

  /**
   * Get conversation transcript.
   */
  getTranscript(): TranscriptEntry[] {
    return [...this.conversationHistory];
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get elapsed time in seconds.
   */
  getElapsedTime(): number {
    if (this.startTime === 0) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}

// Uses 'ws' package for WebSocket
