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

  it('reports a pause early so transcription can start before the end', () => {
    const s = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, speculateMs: 320 });
    const events = feed(s, [
      [0.9, 1600],
      [0.05, 800],
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'pause', 'end']);
    const pause = events[1] as Extract<SegmenterEvent, { type: 'pause' }>;
    const end = events[2] as Extract<SegmenterEvent, { type: 'end' }>;
    // Only silence followed, so the pause's audio is the utterance.
    expect(end.sameAsPause).toBe(true);
    expect(end.samples).toEqual(pause.samples);
  });

  it('does not reuse a pause when speech went on after it', () => {
    const s = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, speculateMs: 320 });
    const events = feed(s, [
      [0.9, 800],
      [0.05, 400], // long enough for a pause, too short to end
      [0.9, 800],
      [0.05, 800],
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'pause', 'pause', 'end']);
    const firstPause = events[1] as Extract<SegmenterEvent, { type: 'pause' }>;
    const end = events[3] as Extract<SegmenterEvent, { type: 'end' }>;
    expect(end.sameAsPause).toBe(true);
    expect(end.samples.length).toBeGreaterThan(firstPause.samples.length);
    // A soft sound (between the thresholds) after the pause also counts as going on.
    const soft = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, speculateMs: 320 });
    const softEvents = feed(soft, [
      [0.9, 800],
      [0.05, 352],
      [0.4, 64],
      [0.05, 800],
    ]);
    expect(softEvents.at(-1)).toMatchObject({ type: 'end' });
    expect((softEvents.at(-1) as { sameAsPause?: boolean }).sameAsPause).toBeUndefined();
  });

  it('cuts continuous sound into overlapping windows', () => {
    const s = new SpeechSegmenter({
      ...DEFAULT_SEGMENTER,
      cutMs: 2000,
      overlapMs: 640,
      maxSpeechMs: 15_000,
    });
    const events = feed(s, [[0.9, 5000]]);
    // 2 s windows that each start 640 ms into the last: cuts at about 2.0, 3.4 and 4.7 s.
    expect(events.map((e) => e.type)).toEqual(['start', 'end', 'end', 'end']);
    const [first, second] = events.slice(1) as Extract<SegmenterEvent, { type: 'end' }>[];
    expect(first!.cut).toBe(true);
    expect(second!.cut).toBe(true);
    // Each later window starts with the last 640 ms of the one before.
    const firstMs = (first!.samples.length / 16_000) * 1000;
    expect(firstMs).toBeGreaterThanOrEqual(2000);
    expect(firstMs).toBeLessThan(2000 + 420);
    expect(s.continuesCut).toBe(true);
  });

  it('drops the overlap to carry on after a wake phrase in a cut window', () => {
    const s = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, cutMs: 2000, overlapMs: 640 });
    feed(s, [[0.9, 2000]]); // cut once
    feed(s, [[0.9, 320]]); // 320 ms more after the cut
    s.dropOverlap();
    expect(s.continuesCut).toBe(false);
    const end = s.flush() as Extract<SegmenterEvent, { type: 'end' }>;
    // Only what was said after the cut.
    expect((end.samples.length / 16_000) * 1000).toBeLessThanOrEqual(352);
  });

  it('flush ends the current segment immediately (push-to-talk released)', () => {
    const seg = new SpeechSegmenter({ ...DEFAULT_SEGMENTER, endSilenceMs: 15_000 });
    expect(seg.flush()).toBeNull();
    for (let i = 0; i < 20; i++) seg.push(new Float32Array(512).fill(0.1), 0.9);
    const event = seg.flush();
    expect(event?.type).toBe('end');
    expect(seg.isSpeaking).toBe(false);
  });
});
