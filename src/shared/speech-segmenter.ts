export interface SegmenterOptions {
  sampleRate: number;
  frameSamples: number;
  /** Speech probability that counts as talking / as silence (hysteresis). */
  positiveThreshold: number;
  negativeThreshold: number;
  /** Consecutive speech frames needed to start a segment (ignores clicks and coughs). */
  startFrames: number;
  /** Audio kept from just before speech started, so the first syllable isn't clipped. */
  prerollMs: number;
  /** Silence that ends a segment. Shorter is snappier; longer tolerates pauses. */
  endSilenceMs: number;
  minSpeechMs: number;
  maxSpeechMs: number;
  /** Silence kept at the end of a segment. */
  tailMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  sampleRate: 16_000,
  frameSamples: 512,
  positiveThreshold: 0.5,
  negativeThreshold: 0.35,
  startFrames: 3,
  prerollMs: 320,
  endSilenceMs: 640,
  minSpeechMs: 250,
  maxSpeechMs: 15_000,
  tailMs: 160,
};

export type SegmenterEvent =
  { type: 'start' } | { type: 'end'; samples: Float32Array } | { type: 'discard' };

/**
 * Turns a stream of (frame, speech probability) pairs into whole utterances. Pure logic so it
 * can be tested without a microphone.
 */
export class SpeechSegmenter {
  private readonly frameMs: number;
  private preroll: Float32Array[] = [];
  private segment: Float32Array[] = [];
  private speaking = false;
  private speechRun = 0;
  private silenceMs = 0;

  constructor(private options: SegmenterOptions = DEFAULT_SEGMENTER) {
    this.frameMs = (options.frameSamples / options.sampleRate) * 1000;
  }

  configure(patch: Partial<SegmenterOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.preroll = [];
    this.segment = [];
    this.speaking = false;
    this.speechRun = 0;
    this.silenceMs = 0;
  }

  /** Ends the current segment now (push-to-talk released), as if the speaker went quiet. */
  flush(): SegmenterEvent | null {
    if (!this.speaking) return null;
    const o = this.options;
    const frames = this.segment;
    const speechMs = frames.length * this.frameMs - this.silenceMs;
    this.speaking = false;
    this.segment = [];
    this.speechRun = 0;
    this.silenceMs = 0;
    if (speechMs < o.minSpeechMs) return { type: 'discard' };
    const samples = new Float32Array(frames.length * o.frameSamples);
    frames.forEach((f, i) => samples.set(f, i * o.frameSamples));
    return { type: 'end', samples };
  }

  push(frame: Float32Array, probability: number): SegmenterEvent | null {
    const o = this.options;
    if (!this.speaking) {
      this.preroll.push(frame);
      const maxPreroll = Math.ceil(o.prerollMs / this.frameMs) + o.startFrames;
      if (this.preroll.length > maxPreroll) this.preroll.shift();
      this.speechRun = probability >= o.positiveThreshold ? this.speechRun + 1 : 0;
      if (this.speechRun >= o.startFrames) {
        this.speaking = true;
        this.segment = this.preroll;
        this.preroll = [];
        this.silenceMs = 0;
        return { type: 'start' };
      }
      return null;
    }

    this.segment.push(frame);
    if (probability < o.negativeThreshold) this.silenceMs += this.frameMs;
    else if (probability >= o.positiveThreshold) this.silenceMs = 0;

    const totalMs = this.segment.length * this.frameMs;
    if (this.silenceMs < o.endSilenceMs && totalMs < o.maxSpeechMs) return null;

    const trailingFrames = Math.floor(Math.max(0, this.silenceMs - o.tailMs) / this.frameMs);
    const frames = this.segment.slice(0, this.segment.length - trailingFrames);
    const speechMs = totalMs - this.silenceMs;
    this.speaking = false;
    this.segment = [];
    this.speechRun = 0;
    this.silenceMs = 0;
    if (speechMs < o.minSpeechMs) return { type: 'discard' };

    const samples = new Float32Array(frames.length * o.frameSamples);
    frames.forEach((f, i) => samples.set(f, i * o.frameSamples));
    return { type: 'end', samples };
  }
}
