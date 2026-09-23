import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import type { TtsRequest, TtsResponse } from './tts-protocol';

interface Job {
  onChunk: (samples: Float32Array, sampleRate: number) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Owns the Kokoro utility process: loads the model once, then synthesizes replies on demand. */
export class TtsService {
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
    await this.start();
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.jobs.set(id, { onChunk, resolve, reject });
      signal?.addEventListener('abort', () => this.post({ type: 'cancel', id }), { once: true });
      this.post({ type: 'speak', id, text, voice: options.voice, speed: options.speed });
    });
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
