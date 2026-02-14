/**
 * Audio Utilities for Voice Call Open
 *
 * Handles format conversion between different audio formats:
 * - mu-law (G.711) - Twilio's native format
 * - PCM 16-bit - Standard processing format
 * - Various sample rates (8kHz telephony, 16kHz Whisper, etc.)
 */

const TELEPHONY_SAMPLE_RATE = 8000;
const WHISPER_SAMPLE_RATE = 16000;

// mu-law encoding/decoding tables for fast lookup
const MULAW_ENCODE_TABLE = new Uint8Array(65536);
const MULAW_DECODE_TABLE = new Int16Array(256);

// Initialize lookup tables
(function initMulawTables() {
  // Build encode table (linear to mu-law)
  for (let i = 0; i < 65536; i++) {
    const sample = i < 32768 ? i : i - 65536;
    MULAW_ENCODE_TABLE[i] = linearToMulawSlow(sample);
  }

  // Build decode table (mu-law to linear)
  for (let i = 0; i < 256; i++) {
    MULAW_DECODE_TABLE[i] = mulawToLinearSlow(i);
  }
})();

function linearToMulawSlow(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;

  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinearSlow(mulaw: number): number {
  mulaw = ~mulaw;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

/**
 * Convert mu-law buffer to PCM 16-bit (fast lookup table version).
 */
export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulaw[i]], i * 2);
  }
  return pcm;
}

/**
 * Convert PCM 16-bit to mu-law (fast lookup table version).
 */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    // Convert signed to unsigned index
    const idx = sample < 0 ? sample + 65536 : sample;
    mulaw[i] = MULAW_ENCODE_TABLE[idx];
  }
  return mulaw;
}

/**
 * Resample PCM 16-bit audio using linear interpolation.
 */
export function resamplePcm(input: Buffer, inputRate: number, outputRate: number): Buffer {
  if (inputRate === outputRate) return input;

  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);

  const ratio = inputRate / outputRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = input.readInt16LE(s1Index * 2);

    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Resample PCM to Whisper's expected 16kHz.
 */
export function resampleToWhisper(pcm: Buffer, inputRate: number): Buffer {
  return resamplePcm(pcm, inputRate, WHISPER_SAMPLE_RATE);
}

/**
 * Resample PCM to telephony 8kHz.
 */
export function resampleToTelephony(pcm: Buffer, inputRate: number): Buffer {
  return resamplePcm(pcm, inputRate, TELEPHONY_SAMPLE_RATE);
}

/**
 * Convert mu-law 8kHz to PCM 16kHz (for Whisper).
 */
export function mulawToWhisperPcm(mulaw: Buffer): Buffer {
  const pcm8k = mulawToPcm(mulaw);
  return resampleToWhisper(pcm8k, TELEPHONY_SAMPLE_RATE);
}

/**
 * Convert PCM to mu-law 8kHz (for Twilio).
 */
export function pcmToMulaw8k(pcm: Buffer, inputRate: number): Buffer {
  const pcm8k = resampleToTelephony(pcm, inputRate);
  return pcmToMulaw(pcm8k);
}

/**
 * Convert PCM 16-bit to float32 array (for some ML models).
 */
export function pcmToFloat32(pcm: Buffer): Float32Array {
  const samples = Math.floor(pcm.length / 2);
  const float32 = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    float32[i] = pcm.readInt16LE(i * 2) / 32768.0;
  }
  return float32;
}

/**
 * Convert float32 array to PCM 16-bit.
 */
export function float32ToPcm(float32: Float32Array): Buffer {
  const pcm = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.round(float32[i] * 32767);
    pcm.writeInt16LE(clamp16(sample), i * 2);
  }
  return pcm;
}

/**
 * Calculate RMS (Root Mean Square) energy of PCM audio.
 */
export function calculateRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768.0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Calculate RMS energy of mu-law audio.
 */
export function calculateMulawRms(mulaw: Buffer): number {
  if (mulaw.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const sample = MULAW_DECODE_TABLE[mulaw[i]] / 32768.0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / mulaw.length);
}

/**
 * Chunk audio buffer into frames.
 */
export function* chunkAudio(audio: Buffer, chunkSize: number): Generator<Buffer, void, unknown> {
  for (let i = 0; i < audio.length; i += chunkSize) {
    yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
  }
}

/**
 * Concatenate multiple audio buffers.
 */
export function concatAudio(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

/**
 * Create a WAV header for PCM audio.
 */
export function createWavHeader(
  dataLength: number,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Wrap PCM audio in a WAV container.
 */
export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = createWavHeader(pcm.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([header, pcm]);
}

/**
 * Parse WAV header and extract PCM data.
 */
export function wavToPcm(wav: Buffer): {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
} {
  if (wav.length < 44) {
    throw new Error("Invalid WAV: too short");
  }

  const riff = wav.toString("ascii", 0, 4);
  const wave = wav.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV: missing RIFF/WAVE header");
  }

  // Find fmt chunk
  let offset = 12;
  while (offset < wav.length - 8) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      const audioFormat = wav.readUInt16LE(offset + 8);
      const channels = wav.readUInt16LE(offset + 10);
      const sampleRate = wav.readUInt32LE(offset + 12);
      const bitsPerSample = wav.readUInt16LE(offset + 22);

      if (audioFormat !== 1) {
        throw new Error(`Unsupported WAV format: ${audioFormat}`);
      }

      // Find data chunk
      offset += 8 + chunkSize;
      while (offset < wav.length - 8) {
        const dataChunkId = wav.toString("ascii", offset, offset + 4);
        const dataChunkSize = wav.readUInt32LE(offset + 4);

        if (dataChunkId === "data") {
          const pcm = wav.subarray(offset + 8, offset + 8 + dataChunkSize);
          return { pcm, sampleRate, channels, bitsPerSample };
        }

        offset += 8 + dataChunkSize;
      }
    }

    offset += 8 + chunkSize;
  }

  throw new Error("Invalid WAV: missing fmt or data chunk");
}

/**
 * Clamp a value to 16-bit signed range.
 */
function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

// Export constants
export const SAMPLE_RATES = {
  TELEPHONY: TELEPHONY_SAMPLE_RATE,
  WHISPER: WHISPER_SAMPLE_RATE,
} as const;
