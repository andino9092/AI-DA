import { randomUUID } from 'node:crypto';
import type { TtsRequest, TtsResponse } from '@shared/tts-protocol';

interface Job {
  onChunk: (samples: Float32Array, sampleRate: number) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

type Chunk = { samples: Float32Array; sampleRate: number };

/** A running voice engine: messages in, messages out, and a way to stop it. */
export interface TtsTransport {
  post(message: TtsRequest): void;
  /** Called once with the handlers; onExit when the engine dies (crash, page reload). */
  listen(onMessage: (message: TtsResponse) => void, onExit: () => void): void;
  stop(): void;
}

export interface TtsEngine {
  /** "gpu" (WebGPU in the audio window) or "cpu" (utility process). */
  name: string;
  create(): TtsTransport;
  /** Loading includes compiling for the graphics card, which can take a few seconds. */
  initTimeoutMs: number;
}

/** Short replies ("Paused.", "Done.") come back often; their audio is kept to play instantly. */
const CACHE_MAX_CHARS = 60;
const CACHE_ENTRIES = 64;
export const COMMON_PHRASES = [
  'Okay.',
  'Done.',
  'Paused.',
  'Stopped.',
  "Okay, I won't do that.",
  "Sorry, I didn't catch that.",
];
const GPU_WARMUP = [
  'Opening Discord.',
  'Timer set for 10 minutes.',
  'Volume set to 40 percent.',
  "It's 18 degrees and partly cloudy.",
  'Here is what I found on your screen, starting with the first button.',
];

/**
 * Speaks replies with the first voice engine that starts (the graphics card, then the CPU), and
 * falls back for the rest of the session if an engine fails to load. Audio comes back sentence by
 * sentence so playback can start early.
 */
export class TtsService {
  private readonly cache = new Map<string, Chunk[]>();
  private transport: TtsTransport | null = null;
  private ready: Promise<void> | null = null;
  private readonly jobs = new Map<string, Job>();
  /** Engines that failed to load; not tried again this session. */
  private readonly failed = new Set<string>();
  private active: string | null = null;

  constructor(
    private readonly engines: TtsEngine[],
    private readonly modelsDir: () => string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Which engine is speaking ("gpu" or "cpu"), once one has started. */
  get engine(): string | null {
    return this.active;
  }

  start(): Promise<void> {
    this.ready ??= this.startFirstWorking();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private async startFirstWorking(): Promise<void> {
    let lastError: Error = new Error('No voice engine is available.');
    for (const engine of this.engines) {
      if (this.failed.has(engine.name)) continue;
      try {
        await this.startEngine(engine);
        this.active = engine.name;
        this.log(`voice engine: ${engine.name}`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.failed.add(engine.name);
        this.log(`voice engine ${engine.name} unavailable: ${lastError.message}`);
      }
    }
    throw lastError;
  }

  private startEngine(engine: TtsEngine): Promise<void> {
    const transport = engine.create();
    this.transport = transport;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        fail(new Error(`${engine.name} voice took too long to load.`));
      }, engine.initTimeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (this.transport === transport) {
          this.transport = null;
          this.active = null;
        }
        transport.stop();
        for (const job of this.jobs.values()) job.reject(error);
        this.jobs.clear();
        if (started) this.ready = null;
        else reject(error);
      };
      transport.listen(
        (message) => {
          if (message.type === 'ready') {
            started = true;
            clearTimeout(timer);
            resolve();
          } else if (message.type === 'error' && !message.id) {
            fail(new Error(message.message));
          } else this.route(message);
        },
        () => fail(new Error('Voice engine stopped.')),
      );
      transport.post({ type: 'init', modelsDir: this.modelsDir() });
    });
  }

  /** Streams audio sentence by sentence; resolves when everything was synthesized or cancelled. */
  async speak(
    text: string,
    options: { voice: string; speed: number },
    onChunk: Job['onChunk'],
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${options.voice}|${options.speed}|${text.trim()}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh its place in the LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      for (const c of cached) onChunk(c.samples, c.sampleRate);
      return;
    }
    await this.start();
    const id = randomUUID();
    const cacheable = text.trim().length <= CACHE_MAX_CHARS;
    const collected: Chunk[] = [];
    return new Promise<void>((resolve, reject) => {
      this.jobs.set(id, {
        onChunk: (samples, sampleRate) => {
          if (cacheable) collected.push({ samples, sampleRate });
          onChunk(samples, sampleRate);
        },
        resolve: () => {
          if (cacheable && !signal?.aborted && collected.length > 0) this.remember(key, collected);
          resolve();
        },
        reject,
      });
      signal?.addEventListener('abort', () => this.post({ type: 'cancel', id }), { once: true });
      this.post({ type: 'speak', id, text, voice: options.voice, speed: options.speed });
    });
  }

  /** Synthesizes common replies in the background so the first "Paused." is instant too. */
  async prewarm(options: { voice: string; speed: number }): Promise<void> {
    for (const phrase of COMMON_PHRASES) await this.speak(phrase, options, () => {});
    // The graphics card compiles its programs for each new sentence length the first time; a
    // spread of lengths at startup makes the first real replies faster.
    if (this.active === 'gpu')
      for (const phrase of GPU_WARMUP) await this.speak(phrase, options, () => {});
  }

  private remember(key: string, chunks: Chunk[]): void {
    this.cache.set(key, chunks);
    if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  stop(): void {
    this.transport?.stop();
    this.transport = null;
    this.ready = null;
    this.active = null;
  }

  private route(message: TtsResponse): void {
    if (!('id' in message) || !message.id) return;
    const job = this.jobs.get(message.id);
    if (!job) return;
    if (message.type === 'chunk') job.onChunk(message.samples, message.sampleRate);
    else if (message.type === 'done') {
      this.jobs.delete(message.id);
      job.resolve();
    } else if (message.type === 'error') {
      this.jobs.delete(message.id);
      job.reject(new Error(message.message));
    }
  }

  private post(message: TtsRequest): void {
    this.transport?.post(message);
  }
}
