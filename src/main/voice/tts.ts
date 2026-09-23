import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import type { TtsRequest, TtsResponse } from './tts-protocol';

interface Job {
  onChunk: (samples: Float32Array, sampleRate: number) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

type Chunk = { samples: Float32Array; sampleRate: number };

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

/** Owns the Kokoro utility process: loads the model once, then synthesizes replies on demand. */
export class TtsService {
  private readonly cache = new Map<string, Chunk[]>();
  private proc: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly workerPath: string,
    private readonly modelsDir: () => string,
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const proc = utilityProcess.fork(this.workerPath, [], {
      serviceName: 'AI-DA voice',
      stdio: 'ignore',
    });
    this.proc = proc;
    this.ready = new Promise<void>((resolve, reject) => {
      proc.on('message', (message: TtsResponse) => {
        if (message.type === 'ready') resolve();
        else if (message.type === 'error' && !message.id) reject(new Error(message.message));
        else this.route(message);
      });
      proc.on('exit', () => {
        reject(new Error('Voice engine stopped.'));
        for (const job of this.jobs.values()) job.reject(new Error('Voice engine stopped.'));
        this.jobs.clear();
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
      });
    });
    this.ready.catch(() => {});
    this.post({ type: 'init', modelsDir: this.modelsDir() });
    return this.ready;
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
  }

  private remember(key: string, chunks: Chunk[]): void {
    this.cache.set(key, chunks);
    if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
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
    this.proc?.postMessage(message);
  }
}
