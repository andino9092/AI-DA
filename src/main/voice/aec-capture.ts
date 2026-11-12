import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** 16 kHz mono frames, the size the speech detector works on (32 ms). */
export const FRAME_SAMPLES = 512;
/** Frames sent to the audio window at a time (64 ms), to keep messages few. */
const FRAMES_PER_BATCH = 2;
/** If the helper stops this soon after starting, it's broken here: use the browser mic. */
const STARTUP_GRACE_MS = 5000;
/** The helper says "started" once the echo canceller runs; an older helper never does. */
const START_TIMEOUT_MS = 4000;

export type Spawn = (exe: string, args: string[]) => ChildProcessWithoutNullStreams;

/** Turns raw 16-bit little-endian PCM (arriving in any chunk sizes) into float frames. */
export class PcmFramer {
  private carry = Buffer.alloc(0);
  private pending: Float32Array[] = [];

  constructor(private readonly onBatch: (samples: Float32Array) => void) {}

  push(chunk: Buffer): void {
    const bytes = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frameBytes = FRAME_SAMPLES * 2;
    let offset = 0;
    for (; offset + frameBytes <= bytes.length; offset += frameBytes) {
      const frame = new Float32Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) frame[i] = bytes.readInt16LE(offset + i * 2) / 32768;
      this.pending.push(frame);
      if (this.pending.length === FRAMES_PER_BATCH) {
        const batch = new Float32Array(FRAME_SAMPLES * FRAMES_PER_BATCH);
        this.pending.forEach((f, i) => batch.set(f, i * FRAME_SAMPLES));
        this.pending = [];
        this.onBatch(batch);
      }
    }
    this.carry = Buffer.from(bytes.subarray(offset));
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
    this.pending = [];
  }
}

export interface AecCaptureEvents {
  /** Echo-cancelled microphone audio, in whole frames. */
  onAudio(samples: Float32Array): void;
  /** It can't run on this PC (or stopped): the caller switches to the browser microphone. */
  onFailed(reason: string): void;
  onStarted?(): void;
}

/**
 * Runs the helper's echo-cancelling capture (Windows' Voice Capture DSP; see native Aec.cs):
 * the microphone minus whatever the speakers play, so "Hey Aida" is heard over music and games.
 * One process while the mic is on; stopped when it's off.
 */
export class AecCapture {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private mic: string | null = null;
  private started = false;
  private readonly framer: PcmFramer;

  constructor(
    private readonly exe: string,
    private readonly events: AecCaptureEvents,
    private readonly spawnProcess: Spawn = (exe, args) =>
      spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    private readonly now: () => number = Date.now,
    private readonly startTimeoutMs = START_TIMEOUT_MS,
  ) {
    this.framer = new PcmFramer((samples) => this.events.onAudio(samples));
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** Starts (or restarts, for a different microphone). */
  start(micName: string | null): void {
    if (this.proc && this.mic === micName) return;
    this.stop();
    this.mic = micName;
    const args = ['aec-capture', ...(micName ? ['--mic', micName] : [])];
    const proc = this.spawnProcess(this.exe, args);
    const startedAt = this.now();
    this.proc = proc;
    this.framer.reset();
    let stderr = '';
    this.started = false;
    const timer = setTimeout(() => {
      if (!this.started) this.failed(proc, 'no answer from the echo canceller');
    }, this.startTimeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (chunk: Buffer) => {
      // Nothing counts as audio until the helper said it started.
      if (this.proc === proc && this.started) this.framer.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      let newline: number;
      while ((newline = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, newline).trim();
        stderr = stderr.slice(newline + 1);
        this.status(proc, line);
      }
    });
    proc.on('error', (err) => this.failed(proc, err.message));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      const quick = this.now() - startedAt < STARTUP_GRACE_MS;
      this.failed(proc, quick ? `stopped right away (code ${code})` : `stopped (code ${code})`);
    });
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.mic = null;
    if (!proc) return;
    // Closing stdin tells it to exit; kill in case it's stuck.
    proc.stdin.end();
    setTimeout(() => proc.kill(), 1000).unref?.();
  }

  private status(proc: ChildProcessWithoutNullStreams, line: string): void {
    if (!line || this.proc !== proc) return;
    let message: { event?: string; message?: string };
    try {
      message = JSON.parse(line) as { event?: string; message?: string };
    } catch {
      return;
    }
    if (message.event === 'started') {
      this.started = true;
      this.events.onStarted?.();
    } else if (message.event === 'error') this.failed(proc, message.message ?? 'unknown error');
  }

  private failed(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.proc !== proc) return;
    this.proc = null;
    proc.kill();
    this.events.onFailed(reason);
  }
}
