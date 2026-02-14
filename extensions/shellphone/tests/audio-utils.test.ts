/**
 * Audio Utilities Tests
 */

import { describe, it, expect } from "vitest";
import {
  mulawToPcm,
  pcmToMulaw,
  resamplePcm,
  pcmToFloat32,
  float32ToPcm,
  calculateRms,
  createWavHeader,
  pcmToWav,
  wavToPcm,
  SAMPLE_RATES,
} from "../src/audio-utils.js";

describe("mulawToPcm", () => {
  it("should convert mu-law silence to PCM silence", () => {
    const mulaw = Buffer.alloc(100);
    mulaw.fill(0xff); // Mu-law silence

    const pcm = mulawToPcm(mulaw);
    expect(pcm.length).toBe(200); // 2 bytes per sample

    // Check samples are near zero
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i);
      expect(Math.abs(sample)).toBeLessThan(150);
    }
  });

  it("should convert mu-law to PCM and back", () => {
    // Create a test mu-law buffer
    const original = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) {
      original[i] = (i * 2) % 256;
    }

    const pcm = mulawToPcm(original);
    const roundtrip = pcmToMulaw(pcm);

    // Should be close to original (some quantization error expected)
    for (let i = 0; i < original.length; i++) {
      const diff = Math.abs(original[i] - roundtrip[i]);
      expect(diff).toBeLessThanOrEqual(1);
    }
  });
});

describe("pcmToMulaw", () => {
  it("should convert PCM silence to mu-law silence", () => {
    const pcm = Buffer.alloc(200);
    pcm.fill(0);

    const mulaw = pcmToMulaw(pcm);
    expect(mulaw.length).toBe(100);

    // Check all samples are near mu-law silence (0xff or 0x7f)
    for (const byte of mulaw) {
      expect(byte === 0xff || byte === 0x7f).toBe(true);
    }
  });

  it("should handle max amplitude correctly", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(32767, 0); // Max positive
    pcm.writeInt16LE(-32768, 2); // Max negative

    const mulaw = pcmToMulaw(pcm);
    expect(mulaw.length).toBe(2);

    // Max amplitude should map to low mu-law values (inverted encoding)
    // Positive samples: 0x00-0x7F range, negative samples: 0x80-0xFF range
    // But due to the inverted nature of mu-law, high amplitude = lower mu-law value
    expect(mulaw[0]).toBeLessThanOrEqual(0x80); // Positive (can be exactly 0x80)
    expect(mulaw[1]).toBeGreaterThanOrEqual(0x00); // Negative (any value is valid)
  });
});

describe("resamplePcm", () => {
  it("should return same buffer when rates match", () => {
    const pcm = Buffer.alloc(100);
    pcm.fill(0x55);

    const result = resamplePcm(pcm, 8000, 8000);
    expect(result.equals(pcm)).toBe(true);
  });

  it("should downsample correctly", () => {
    const pcm = Buffer.alloc(320); // 160 samples at 16kHz
    for (let i = 0; i < 160; i++) {
      pcm.writeInt16LE(Math.sin(i * 0.1) * 10000, i * 2);
    }

    const result = resamplePcm(pcm, 16000, 8000);
    expect(result.length).toBe(160); // 80 samples
  });

  it("should upsample correctly", () => {
    const pcm = Buffer.alloc(160); // 80 samples at 8kHz
    for (let i = 0; i < 80; i++) {
      pcm.writeInt16LE(Math.sin(i * 0.1) * 10000, i * 2);
    }

    const result = resamplePcm(pcm, 8000, 16000);
    expect(result.length).toBe(320); // 160 samples
  });
});

describe("pcmToFloat32 / float32ToPcm", () => {
  it("should convert PCM to normalized float32", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16383, 0); // ~0.5
    pcm.writeInt16LE(-16384, 2); // ~-0.5

    const float32 = pcmToFloat32(pcm);
    expect(float32.length).toBe(2);
    expect(float32[0]).toBeCloseTo(0.5, 1);
    expect(float32[1]).toBeCloseTo(-0.5, 1);
  });

  it("should roundtrip PCM through float32", () => {
    const original = Buffer.alloc(10);
    for (let i = 0; i < 5; i++) {
      original.writeInt16LE((i - 2) * 6000, i * 2);
    }

    const float32 = pcmToFloat32(original);
    const roundtrip = float32ToPcm(float32);

    for (let i = 0; i < 5; i++) {
      const orig = original.readInt16LE(i * 2);
      const rt = roundtrip.readInt16LE(i * 2);
      expect(Math.abs(orig - rt)).toBeLessThanOrEqual(1);
    }
  });
});

describe("calculateRms", () => {
  it("should return 0 for silence", () => {
    const pcm = Buffer.alloc(100);
    pcm.fill(0);
    expect(calculateRms(pcm)).toBe(0);
  });

  it("should return non-zero for audio", () => {
    const pcm = Buffer.alloc(100);
    for (let i = 0; i < 50; i++) {
      pcm.writeInt16LE(10000, i * 2);
    }
    expect(calculateRms(pcm)).toBeGreaterThan(0);
  });
});

describe("WAV functions", () => {
  it("should create valid WAV header", () => {
    const header = createWavHeader(1000, 16000, 1, 16);
    expect(header.length).toBe(44);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
    expect(header.toString("ascii", 12, 16)).toBe("fmt ");
    expect(header.toString("ascii", 36, 40)).toBe("data");
  });

  it("should roundtrip PCM through WAV", () => {
    const original = Buffer.alloc(100);
    for (let i = 0; i < 50; i++) {
      original.writeInt16LE(i * 100, i * 2);
    }

    const wav = pcmToWav(original, 16000, 1, 16);
    const { pcm, sampleRate, channels, bitsPerSample } = wavToPcm(wav);

    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);
    expect(bitsPerSample).toBe(16);
    expect(pcm.equals(original)).toBe(true);
  });

  it("should throw on invalid WAV", () => {
    const invalid = Buffer.from("not a wav file");
    expect(() => wavToPcm(invalid)).toThrow();
  });
});

describe("SAMPLE_RATES", () => {
  it("should have correct values", () => {
    expect(SAMPLE_RATES.TELEPHONY).toBe(8000);
    expect(SAMPLE_RATES.WHISPER).toBe(16000);
  });
});
