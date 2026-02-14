/**
 * Voice Call Open - Type Definitions
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Configuration Types
// -----------------------------------------------------------------------------

export const WhisperConfigSchema = z.object({
  model: z.enum(["tiny", "base", "small", "medium", "large"]).default("base"),
  device: z.enum(["cpu", "cuda"]).default("cpu"),
  language: z.string().default("en"),
});
export type WhisperConfig = z.infer<typeof WhisperConfigSchema>;

export const SttConfigSchema = z.object({
  provider: z.literal("whisper").default("whisper"),
  whisper: WhisperConfigSchema.default({}),
});
export type SttConfig = z.infer<typeof SttConfigSchema>;

export const PiperConfigSchema = z.object({
  model: z.string().default("en_US-amy-medium"),
  dataDir: z.string().default("~/.openclaw/piper"),
  speakerId: z.number().int().optional(),
  lengthScale: z.number().default(1.0),
});
export type PiperConfig = z.infer<typeof PiperConfigSchema>;

export const EdgeConfigSchema = z.object({
  voice: z.string().default("en-US-AriaNeural"),
});
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;

export const TtsConfigSchema = z.object({
  provider: z.enum(["piper", "edge"]).default("piper"),
  piper: PiperConfigSchema.default({}),
  edge: EdgeConfigSchema.default({}),
});
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

export const VadConfigSchema = z.object({
  silenceThresholdMs: z.number().int().default(500),
  minSpeechMs: z.number().int().default(100),
  energyThreshold: z.number().default(0.01),
});
export type VadConfig = z.infer<typeof VadConfigSchema>;

export const LlmConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().default(150),
  temperature: z.number().default(0.7),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const ServeConfigSchema = z.object({
  port: z.number().int().default(3335),
  bind: z.string().default("127.0.0.1"),
  path: z.string().default("/shellphone/webhook"),
  streamPath: z.string().default("/shellphone/stream"),
});
export type ServeConfig = z.infer<typeof ServeConfigSchema>;

export const TunnelConfigSchema = z.object({
  provider: z.enum(["none", "ngrok"]).default("none"),
  ngrokAuthToken: z.string().optional(),
  ngrokDomain: z.string().optional(),
});
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;

export const TwilioConfigSchema = z.object({
  accountSid: z.string().optional(),
  authToken: z.string().optional(),
});
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;

export const VoiceCallOpenConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["twilio", "mock"]).default("mock"),
  fromNumber: z.string().optional(),
  toNumber: z.string().optional(),
  twilio: TwilioConfigSchema.default({}),
  stt: SttConfigSchema.default({}),
  tts: TtsConfigSchema.default({}),
  vad: VadConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
  serve: ServeConfigSchema.default({}),
  tunnel: TunnelConfigSchema.default({}),
  inboundPolicy: z.enum(["disabled", "allowlist", "open"]).default("disabled"),
  allowFrom: z.array(z.string()).default([]),
  inboundGreeting: z.string().default("Hello! How can I help you today?"),
  maxDurationSeconds: z.number().int().default(300),
  publicUrl: z.string().optional(),
  store: z.string().optional(),
});
export type VoiceCallOpenConfig = z.infer<typeof VoiceCallOpenConfigSchema>;

// -----------------------------------------------------------------------------
// Call Types
// -----------------------------------------------------------------------------

export type CallDirection = "inbound" | "outbound";

export type CallState =
  | "initiated"
  | "ringing"
  | "answered"
  | "active"
  | "speaking"
  | "listening"
  | "completed"
  | "failed"
  | "busy"
  | "no-answer"
  | "hangup-user"
  | "hangup-bot"
  | "timeout"
  | "error";

export const TerminalStates = new Set<CallState>([
  "completed",
  "failed",
  "busy",
  "no-answer",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
]);

export interface TranscriptEntry {
  timestamp: number;
  speaker: "bot" | "user";
  text: string;
  isFinal: boolean;
}

export interface CallRecord {
  callId: string;
  providerCallId?: string;
  provider: string;
  direction: CallDirection;
  state: CallState;
  from: string;
  to: string;
  sessionKey?: string;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  endReason?: string;
  transcript: TranscriptEntry[];
  processedEventIds: string[];
  metadata?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Event Types
// -----------------------------------------------------------------------------

export type NormalizedEventType =
  | "call.initiated"
  | "call.ringing"
  | "call.answered"
  | "call.active"
  | "call.speaking"
  | "call.speech"
  | "call.ended"
  | "call.dtmf"
  | "call.error";

export interface NormalizedEvent {
  id: string;
  type: NormalizedEventType;
  callId: string;
  providerCallId?: string;
  timestamp: number;
  direction?: CallDirection;
  from?: string;
  to?: string;
  transcript?: string;
  isFinal?: boolean;
  confidence?: number;
  digits?: string;
  reason?: string;
  error?: string;
  retryable?: boolean;
}

// -----------------------------------------------------------------------------
// Audio Types
// -----------------------------------------------------------------------------

export interface AudioBuffer {
  data: Buffer;
  sampleRate: number;
  channels: number;
  format: "pcm16" | "mulaw" | "f32";
}

export interface SpeechSegment {
  audio: Buffer;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

// -----------------------------------------------------------------------------
// STT Types
// -----------------------------------------------------------------------------

export interface SttResult {
  text: string;
  confidence?: number;
  language?: string;
  durationMs?: number;
}

export interface SttProvider {
  name: string;
  transcribe(audio: Buffer, sampleRate?: number): Promise<SttResult>;
  isReady(): Promise<boolean>;
}

// -----------------------------------------------------------------------------
// TTS Types
// -----------------------------------------------------------------------------

export interface TtsResult {
  audio: Buffer;
  sampleRate: number;
  format: "pcm16" | "wav" | "mp3";
  durationMs?: number;
}

export interface TtsProvider {
  name: string;
  synthesize(text: string): Promise<TtsResult>;
  synthesizeForTelephony(text: string): Promise<Buffer>;
  isReady(): Promise<boolean>;
}

// -----------------------------------------------------------------------------
// Pipeline Types
// -----------------------------------------------------------------------------

export interface PipelineConfig {
  stt: SttConfig;
  tts: TtsConfig;
  vad: VadConfig;
  llm: LlmConfig;
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PipelineContext {
  callId: string;
  callRecord: CallRecord;
  conversationHistory: ConversationMessage[];
  systemPrompt: string;
}

// -----------------------------------------------------------------------------
// Provider Types
// -----------------------------------------------------------------------------

export interface WebhookContext {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: string;
  method: string;
  query: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}

export interface InitiateCallInput {
  callId: string;
  from: string;
  to: string;
  webhookUrl: string;
  inlineTwiml?: string;
}

export interface InitiateCallResult {
  providerCallId: string;
  status: string;
}

export interface HangupCallInput {
  callId: string;
  providerCallId: string;
  reason?: string;
}
