/**
 * STT Module Entry Point
 */

export {
  VoiceActivityDetector,
  createDefaultVadConfig,
  containsSpeech,
  calculateSpeechPercentage,
} from "./vad.js";
export type { VadState, VadResult } from "./vad.js";

export { WhisperSttProvider, createWhisperProvider } from "./whisper.js";

export type { SttProvider, SttResult } from "../types.js";
