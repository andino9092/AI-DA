import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEGMENTER,
  SpeechSegmenter,
  type SegmenterEvent,
} from '../../src/shared/speech-segmenter';

const FRAME_MS = 32;
const frame = (value = 0) => new Float32Array(512).fill(value);

/** Feeds a pattern of [probability, durationMs] runs and returns the events. */
function feed(segmenter: SpeechSegmenter, runs: [number, number][]): SegmenterEvent[] {
  const events: SegmenterEvent[] = [];
  for (const [p, ms] of runs) {
    for (let t = 0; t < ms; t += FRAME_MS) {
      const e = segmenter.push(frame(p), p);
      if (e) events.push(e);
    }
  }
  return events;
}

describe('SpeechSegmenter', () => {
  it('emits one utterance with preroll and a short tail', () => {
    const s = new SpeechSegmenter();
    const events = feed(s, [
      [0.05, 640], // quiet room
      [0.9, 1600], // speech
      [0.05, 800], // pause long enough to end
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'end']);
    const end = events[1] as Extract<SegmenterEvent, { type: 'end' }>;
    const ms = (end.samples.length / 16_000) * 1000;
    // ≈ preroll (≤ ~416 ms) + 1600 ms speech + tail (≤ ~160 ms), in whole frames.
    expect(ms).toBeGreaterThan(1600);
    expect(ms).toBeLessThan(1600 + 420 + 200);
  });

  it('keeps a mid-sentence pause shorter than the end threshold in one utterance', () => {
    const s = new SpeechSegmenter();
    const events = feed(s, [
      [0.9, 800],
      [0.1, 400],
      [0.9, 800],
      [0.05, 800],
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'end']);
  });

  it('ignores blips shorter than the start threshold', () => {
    const s = new SpeechSegmenter();
    expect(
      feed(s, [
        [0.9, 64],
        [0.05, 1000],
      ]),
    ).toEqual([]);
  });

  it('discards speech that is too short to be a command', () => {
    const s = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, minSpeechMs: 400 });
    expect(
      feed(s, [
        [0.9, 160],
        [0.05, 800],
      ]).map((e) => e.type),
    ).toEqual(['start', 'discard']);
  });

  it('cuts off at the maximum length', () => {
    const s = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, maxSpeechMs: 2000 });
    expect(feed(s, [[0.9, 3000]]).map((e) => e.type)).toEqual(['start', 'end', 'start']);
  });

  it('can be reconfigured for longer command pauses', () => {
    const s = new SpeechSegmenter();
    s.configure({ endSilenceMs: 800 });
    expect(
      feed(s, [
        [0.9, 600],
        [0.05, 700],
      ]).map((e) => e.type),
    ).toEqual(['start']);
  });
});
