import type { Chime } from '@shared/voice';

/**
 * Plays synthesized speech chunk by chunk, gap-free, and short UI chimes. Playing from the same
 * page that captures the microphone lets Chromium's echo cancellation remove AI-DA's own voice.
 */
export class Player {
  private readonly ctx = new AudioContext();
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private readonly ending = new Set<string>();
  private readonly pending = new Map<string, number>();

  constructor(private readonly onFinished: (id: string) => void) {}

  play(id: string, samples: Float32Array, sampleRate: number): void {
    void this.ctx.resume();
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const start = Math.max(this.ctx.currentTime + 0.02, this.nextStart);
    source.start(start);
    this.nextStart = start + buffer.duration;
    this.sources.add(source);
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    source.onended = () => {
      this.sources.delete(source);
      const left = (this.pending.get(id) ?? 1) - 1;
      this.pending.set(id, left);
      if (left === 0 && this.ending.has(id)) this.finish(id);
    };
  }

  /** No more chunks will arrive for this reply; report when the last one has played. */
  endOfSpeech(id: string): void {
    this.ending.add(id);
    if ((this.pending.get(id) ?? 0) === 0) this.finish(id);
  }

  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    this.sources.clear();
    this.nextStart = 0;
    for (const id of this.pending.keys()) this.onFinished(id);
    this.pending.clear();
    this.ending.clear();
  }

  chime(kind: Chime): void {
    void this.ctx.resume();
    const notes: Record<Chime, [number, number][]> = {
      listen: [
        [660, 0],
        [880, 0.09],
      ],
      done: [
        [880, 0],
        [660, 0.09],
      ],
      error: [
        [300, 0],
        [220, 0.12],
      ],
    };
    const t0 = this.ctx.currentTime + 0.01;
    for (const [freq, offset] of notes[kind]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + offset);
      gain.gain.linearRampToValueAtTime(0.12, t0 + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.09);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.1);
    }
  }

  private finish(id: string): void {
    this.pending.delete(id);
    this.ending.delete(id);
    this.onFinished(id);
  }
}
