/**
 * Phone Plugin — TypeScript Types
 *
 * Type definitions for Twilio phone integration with OpenAI Realtime.
 */

// =============================================================================
// Plugin Configuration
// =============================================================================

export interface PhonePluginConfig {
  enabled: boolean;
  provider: "twilio";
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  realtimeModel: string;
  defaultVoice: RealtimeVoice;
  maxCallDuration: number;
  recordCalls: boolean;
  transcriptsDir: string;
  webhookPort?: number;
  webhookHost?: string;
  openaiApiKey?: string;
}

// =============================================================================
// Call State
// =============================================================================

export type CallStatus =
  | "initiating"
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed"
  | "busy"
  | "no-answer"
  | "canceled"
  | "voicemail";

export interface CallState {
  id: string;
  callSid: string;
  streamSid?: string;
  to: string;
  from: string;
  task: string;
  context?: string;
  status: CallStatus;
  startedAt: Date;
  connectedAt?: Date;
  endedAt?: Date;
  duration?: number;
  transcript: TranscriptEntry[];
  outcome?: CallOutcome;
  error?: string;
  recordingUrl?: string;
  voicemailDetected?: boolean;
}

export interface TranscriptEntry {
  timestamp: Date;
  role: "assistant" | "user";
  text: string;
  final?: boolean;
}

export interface CallOutcome {
  success: boolean;
  taskCompleted: boolean;
  summary: string;
  nextSteps?: string[];
  keyInfo?: Record<string, unknown>;
}

// =============================================================================
// Call Result (returned to agent)
// =============================================================================

export interface CallResult {
  callId: string;
  status: CallStatus;
  duration?: number;
  transcript: string;
  outcome?: CallOutcome;
  error?: string;
}

// =============================================================================
// Twilio Types
// =============================================================================

export interface TwilioCallOptions {
  to: string;
  from: string;
  url: string;
  statusCallback?: string;
  statusCallbackEvent?: string[];
  statusCallbackMethod?: "GET" | "POST";
  timeout?: number;
  record?: boolean;
  machineDetection?: "Enable" | "DetectMessageEnd";
}

export interface TwilioWebhookPayload {
  CallSid: string;
  AccountSid: string;
  From: string;
  To: string;
  CallStatus: string;
  Direction: string;
  Timestamp?: string;
  SequenceNumber?: string;
  StreamSid?: string;
  // Media stream events
  event?: string;
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64 audio
  };
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
  // Answering machine detection
  AnsweredBy?:
    | "human"
    | "machine_start"
    | "machine_end_beep"
    | "machine_end_silence"
    | "fax"
    | "unknown";
}

export interface TwilioMediaStreamMessage {
  event: "connected" | "start" | "media" | "stop" | "mark";
  sequenceNumber?: string;
  streamSid?: string;
  media?: {
    track: "inbound" | "outbound";
    chunk: string;
    timestamp: string;
    payload: string;
  };
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
  mark?: {
    name: string;
  };
}

// =============================================================================
// OpenAI Realtime Types
// =============================================================================

export type RealtimeVoice =
  | "alloy"
  | "echo"
  | "shimmer"
  | "ash"
  | "ballad"
  | "coral"
  | "sage"
  | "verse";

export interface RealtimeSessionConfig {
  model: string;
  voice: RealtimeVoice;
  instructions: string;
  input_audio_format: "pcm16" | "g711_ulaw" | "g711_alaw";
  output_audio_format: "pcm16" | "g711_ulaw" | "g711_alaw";
  turn_detection?: {
    type: "server_vad";
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
  };
  tools?: RealtimeTool[];
  tool_choice?: "auto" | "none" | "required";
}

export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeServerEvent {
  type: string;
  event_id?: string;
  // Session events
  session?: {
    id: string;
    model: string;
    voice: string;
  };
  // Response events
  response?: {
    id: string;
    status: string;
    output?: Array<{
      type: string;
      id: string;
      content?: Array<{
        type: string;
        transcript?: string;
        audio?: string;
      }>;
    }>;
  };
  // Audio events
  delta?: string;
  audio?: string;
  // Transcript events
  transcript?: string;
  // Error events
  error?: {
    type: string;
    code?: string;
    message: string;
  };
  // Item events
  item?: {
    id: string;
    type: string;
    role?: string;
    content?: Array<{
      type: string;
      transcript?: string;
      text?: string;
    }>;
  };
  // Function call events
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface RealtimeClientEvent {
  type: string;
  event_id?: string;
  session?: Partial<RealtimeSessionConfig>;
  audio?: string;
  item?: {
    type: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      audio?: string;
    }>;
  };
  response?: {
    modalities?: string[];
    instructions?: string;
  };
  call_id?: string;
  output?: string;
}

// =============================================================================
// Call History
// =============================================================================

export interface CallHistoryEntry {
  id: string;
  to: string;
  task: string;
  status: CallStatus;
  startedAt: string;
  duration?: number;
  outcome?: CallOutcome;
  transcriptPath?: string;
}

// =============================================================================
// Plugin Logger Interface
// =============================================================================

export interface PhoneLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
