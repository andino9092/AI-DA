export interface HoldOptions {
  sampleRate: number;
  frameSamples: number;
  /** Stop recording (and send) after this long, even if the key is still held. */
  maxMs: number;
  /** Silence kept around the speech when trimming. */
  marginMs: number;
  /** Less speech than this counts as "nothing heard". */
  minSpeechMs: number;
}

export const DEFAULT_HOLD: HoldOptions = {
  sampleRate: 16_000,
  frameSamples: 512,
  maxMs: 19_000,
  marginMs: 300,
  minSpeechMs: 200,
};

/**
 * Push-to-talk while held: everything the mic hears between key down and key up is the command,
 * no matter how long the pauses or how loud the background. The speech detector is only used to
 * trim silence at the ends and to tell "said something" from "said nothing". Pure logic, so it
 * can be tested without a microphone.
 */
export class HoldRecorder {
  private frames: Float32Array[] = [];
  private probabilities: number[] = [];
  private recording = false;

  constructor(private readonly options: HoldOptions = DEFAULT_HOLD) {}

  get active(): boolean {
    return this.recording;
  }

  private get frameMs(): number {
    return (this.options.frameSamples / this.options.sampleRate) * 1000;
  }

  /** Starts recording, seeded with audio from just before the key went down. */
  start(recent: { frame: Float32Array; probability: number }[] = []): void {
    this.frames = recent.map((r) => r.frame);
    this.probabilities = recent.map((r) => r.probability);
    this.recording = true;
  }

  /** Adds a frame; returns true when the maximum length is reached. */
  push(frame: Float32Array, probability: number): boolean {
    if (!this.recording) return false;
    this.frames.push(frame);
    this.probabilities.push(probability);
    return this.frames.length * this.frameMs >= this.options.maxMs;
  }

  /** Stops without keeping anything; returns what was recorded (to hand to the segmenter). */
  cancel(): { frame: Float32Array; probability: number }[] {
    const recorded = this.frames.map((frame, i) => ({
      frame,
      probability: this.probabilities[i]!,
    }));
    this.reset();
    return recorded;
  }

  /** Stops and returns the speech, trimmed of leading and trailing silence, or null if none. */
  finish(threshold: number): Float32Array | null {
    const { frameSamples, marginMs, minSpeechMs } = this.options;
    const speechFrames = this.probabilities.filter((p) => p >= threshold).length;
    const first = this.probabilities.findIndex((p) => p >= threshold);
    const last = this.probabilities.findLastIndex((p) => p >= threshold);
    const frames = this.frames;
    this.reset();
    if (first < 0 || speechFrames * this.frameMs < minSpeechMs) return null;

    const margin = Math.ceil(marginMs / this.frameMs);
    const kept = frames.slice(
      Math.max(0, first - margin),
      Math.min(frames.length, last + 1 + margin),
    );
    const samples = new Float32Array(kept.length * frameSamples);
    kept.forEach((f, i) => samples.set(f, i * frameSamples));
    return samples;
  }

  private reset(): void {
    this.frames = [];
    this.probabilities = [];
    this.recording = false;
  }
}
