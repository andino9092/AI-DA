import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { encodeWav } from './wav';
import { cleanTranscript } from './wake-phrase';

export interface SpeechToText {
  transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string>;
}

export const STT_SAMPLE_RATE = 16_000;
const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port')),
      );
    });
  });
}

export interface WhisperServerOptions {
  exePath: string;
  modelPath: string;
  language: string;
  /** Biases spelling of words Whisper hasn't seen much, like the assistant's name. */
  prompt: string;
}

/**
 * Runs whisper.cpp's server on 127.0.0.1 with the model loaded once and kept warm on the GPU.
 * Audio never leaves the PC. The server is restarted automatically if it crashes.
 */
export class WhisperServer implements SpeechToText {
  private proc: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: WhisperServerOptions) {}

  start(): Promise<void> {
    this.stopped = false;
    this.starting ??= this.launch().catch((err: unknown) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
    this.baseUrl = null;
    this.starting = null;
  }

  async transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    await this.start();
    const form = new FormData();
    form.append(
      'file',
      new Blob([encodeWav(samples, STT_SAMPLE_RATE)], { type: 'audio/wav' }),
      'speech.wav',
    );
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Speech recognition failed (${response.status}).`);
    const body = (await response.json()) as { text?: string; error?: string };
    if (body.error) throw new Error(`Speech recognition failed: ${body.error}`);
    return cleanTranscript(body.text ?? '');
  }

  private async launch(): Promise<void> {
    const port = await freePort();
    const { exePath, modelPath, language, prompt } = this.options;
    // whisper.cpp finds its GPU backend DLLs next to the executable.
    const proc = spawn(
      exePath,
      [
        '-m',
        modelPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '-l',
        language,
        '-nt',
        '--prompt',
        prompt,
      ],
      { cwd: dirname(exePath), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.proc = proc;
    let log = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    });
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.baseUrl = null;
      this.starting = null;
      if (!this.stopped) setTimeout(() => void this.start().catch(() => {}), 2000);
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new Error(`Speech recognition engine exited: ${log.slice(-300)}`);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          this.baseUrl = url;
          if (/no GPU found/.test(log))
            console.warn('[AI-DA] whisper is running on the CPU; it will be slow.');
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    proc.kill();
    throw new Error('Speech recognition engine did not start in time.');
  }
}
