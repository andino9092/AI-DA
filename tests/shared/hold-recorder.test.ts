import { describe, expect, it } from 'vitest';
import { DEFAULT_HOLD, HoldRecorder } from '../../src/shared/hold-recorder';

const frame = (value: number) => new Float32Array(512).fill(value);

describe('HoldRecorder', () => {
  it('keeps everything between key down and up, trimming silence at the ends', () => {
    const rec = new HoldRecorder(DEFAULT_HOLD);
    rec.start([{ frame: frame(0.01), probability: 0.1 }]);
    for (let i = 0; i < 30; i++) rec.push(frame(0), 0.05); // ~1 s of silence first
    for (let i = 0; i < 10; i++) rec.push(frame(0.5), 0.9); // speech
    for (let i = 0; i < 40; i++) rec.push(frame(0), 0.05); // a long pause…
    for (let i = 0; i < 10; i++) rec.push(frame(0.5), 0.9); // …then more speech
    for (let i = 0; i < 30; i++) rec.push(frame(0), 0.05);
    const samples = rec.finish(0.5);
    // The pause in the middle is kept; ~0.3 s margins stay around the speech.
    const margin = Math.ceil(300 / 32);
    expect(samples?.length).toBe((10 + 40 + 10 + 2 * margin) * 512);
    expect(rec.active).toBe(false);
  });

  it('returns null when nothing was said', () => {
    const rec = new HoldRecorder(DEFAULT_HOLD);
    rec.start();
    for (let i = 0; i < 50; i++) rec.push(frame(0.02), 0.2);
    rec.push(frame(0.5), 0.9); // a single click isn't speech
    expect(rec.finish(0.5)).toBeNull();
  });

  it('says when the length limit is reached', () => {
    const rec = new HoldRecorder({ ...DEFAULT_HOLD, maxMs: 320 });
    rec.start();
    const results = Array.from({ length: 10 }, () => rec.push(frame(0), 0));
    expect(results.at(-1)).toBe(true);
    expect(results.slice(0, 9).every((r) => !r)).toBe(true);
  });

  it('hands a quick tap back for the speech detector', () => {
    const rec = new HoldRecorder(DEFAULT_HOLD);
    rec.start();
    rec.push(frame(0.1), 0.7);
    rec.push(frame(0.1), 0.8);
    expect(rec.cancel().map((r) => r.probability)).toEqual([0.7, 0.8]);
    expect(rec.active).toBe(false);
  });
});
