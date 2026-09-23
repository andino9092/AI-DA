import { describe, expect, it } from 'vitest';
import { splitForSpeech } from '../../../src/main/voice/sentences';
import { encodeWav, normalizePeak, peakDbfs } from '../../../src/main/voice/wav';

describe('splitForSpeech', () => {
  it('splits sentences so the first can play early', () => {
    expect(splitForSpeech('Opening Spotify. Volume set to 30%. Anything else?')).toEqual([
      'Opening Spotify.',
      'Volume set to 30%.',
      'Anything else?',
    ]);
  });

  it('does not split on decimals or lowercase continuations', () => {
    expect(splitForSpeech('Version 2.0 is out. e.g. this stays')).toEqual([
      'Version 2.0 is out. e.g. this stays',
    ]);
  });

  it('breaks very long sentences at commas', () => {
    const long = Array.from(
      { length: 12 },
      (_, i) => `this is clause number ${i} of a long reply`,
    ).join(', ');
    const chunks = splitForSpeech(`${long}.`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 220)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(`${long}.`);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit mono header and clamps samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, -32768, 32767]);
  });
});

describe('normalizePeak', () => {
  it('raises quiet audio toward full scale, with capped gain', () => {
    const quiet = Float32Array.from([0.1, -0.2, 0.05]);
    const out = normalizePeak(quiet);
    expect(Math.max(...out.map(Math.abs))).toBeCloseTo(0.9);
    const whisper = Float32Array.from([0.01, -0.02]);
    expect(Math.max(...normalizePeak(whisper).map(Math.abs))).toBeCloseTo(0.2); // 10x max
  });

  it('leaves loud audio and silence alone', () => {
    const loud = Float32Array.from([0.95, -0.5]);
    expect(normalizePeak(loud)).toBe(loud);
    const silent = new Float32Array(4);
    expect(normalizePeak(silent)).toBe(silent);
  });

  it('reports the peak in dBFS', () => {
    expect(peakDbfs(Float32Array.from([0.5, -1]))).toBeCloseTo(0);
    expect(Math.round(peakDbfs(Float32Array.from([0.1])))).toBe(-20);
  });
});
