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
  /**
   * After this much silence, report the segment so far ("pause") so it can be transcribed while
   * waiting to see whether the speaker is done. 0 turns it off.
   */
  speculateMs: number;
  /**
   * Continuous sound (music, TV) can keep a segment going for a long time. After this long, end
   * it anyway ("cut") and carry the last overlapMs into the next one, so a wake phrase spoken
   * over the noise is checked within seconds and never split. 0 turns it off.
   */
  cutMs: number;
  overlapMs: number;
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
  speculateMs: 0,
  cutMs: 0,
  overlapMs: 0,
};

export type SegmenterEvent =
  | { type: 'start' }
  /**
   * cut: ended by cutMs while sound continued. sameAsPause: nothing but silence since the last
   * "pause", so its transcript is this segment's transcript too.
   */
  | { type: 'end'; samples: Float32Array; cut?: boolean; sameAsPause?: boolean }
  | { type: 'pause'; samples: Float32Array }
  | { type: 'discard' };

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
  /** A "pause" was reported and only silence has followed. */
  private paused = false;
  /** Frames at the start of the segment that repeat the end of the previous (cut) one. */
  private overlapFrames = 0;

  constructor(private options: SegmenterOptions = DEFAULT_SEGMENTER) {
    this.frameMs = (options.frameSamples / options.sampleRate) * 1000;
  }

  configure(patch: Partial<SegmenterOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** The current segment continues one that was cut (continuous sound). */
  get continuesCut(): boolean {
    return this.speaking && this.overlapFrames > 0;
  }

  reset(): void {
    this.preroll = [];
    this.segment = [];
    this.speaking = false;
    this.speechRun = 0;
    this.silenceMs = 0;
    this.paused = false;
    this.overlapFrames = 0;
  }

  /**
   * Keep going with what was said after the last cut, without the repeated overlap: the wake
   * phrase was found in the cut segment, and the rest of the sentence is still being spoken.
   */
  dropOverlap(): void {
    this.segment = this.segment.slice(this.overlapFrames);
    this.overlapFrames = 0;
  }

  /** Ends the current segment now (push-to-talk released), as if the speaker went quiet. */
  flush(): SegmenterEvent | null {
    if (!this.speaking) return null;
    const o = this.options;
    const frames = this.segment;
    const speechMs = frames.length * this.frameMs - this.silenceMs;
    this.endSegment();
    if (speechMs < o.minSpeechMs) return { type: 'discard' };
    return { type: 'end', samples: join(frames, o.frameSamples) };
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
    const silentBefore = this.silenceMs;
    if (probability < o.negativeThreshold) this.silenceMs += this.frameMs;
    else {
      // Anything but clear silence means the speaker may have gone on.
      this.paused = false;
      if (probability >= o.positiveThreshold) this.silenceMs = 0;
    }

    const totalMs = this.segment.length * this.frameMs;
    if (this.silenceMs >= o.endSilenceMs) return this.end();

    // Continuous sound: cut, and carry the end over into the next segment.
    if (o.cutMs > 0 && totalMs >= o.cutMs && this.silenceMs === 0) {
      const frames = this.segment;
      const keep = Math.min(frames.length, Math.round(o.overlapMs / this.frameMs));
      this.segment = frames.slice(frames.length - keep);
      this.overlapFrames = keep;
      this.paused = false;
      return { type: 'end', samples: join(frames, o.frameSamples), cut: true };
    }
    if (totalMs >= o.maxSpeechMs) return this.end();

    if (o.speculateMs > 0 && silentBefore < o.speculateMs && this.silenceMs >= o.speculateMs) {
      this.paused = true;
      return { type: 'pause', samples: join(this.trimmed(), o.frameSamples) };
    }
    return null;
  }

  private end(): SegmenterEvent {
    const o = this.options;
    const frames = this.trimmed();
    const speechMs = this.segment.length * this.frameMs - this.silenceMs;
    const sameAsPause = this.paused;
    this.endSegment();
    if (speechMs < o.minSpeechMs) return { type: 'discard' };
    return {
      type: 'end',
      samples: join(frames, o.frameSamples),
      ...(sameAsPause ? { sameAsPause } : {}),
    };
  }

  /** The segment without trailing silence beyond the tail. */
  private trimmed(): Float32Array[] {
    const trailing = Math.floor(Math.max(0, this.silenceMs - this.options.tailMs) / this.frameMs);
    return this.segment.slice(0, this.segment.length - trailing);
  }

  private endSegment(): void {
    this.speaking = false;
    this.segment = [];
    this.speechRun = 0;
    this.silenceMs = 0;
    this.paused = false;
    this.overlapFrames = 0;
  }
}

function join(frames: Float32Array[], frameSamples: number): Float32Array {
  const samples = new Float32Array(frames.length * frameSamples);
  frames.forEach((f, i) => samples.set(f, i * frameSamples));
  return samples;
}
