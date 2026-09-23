import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export interface WindowInfo {
  handle: number;
  title: string;
  process: string;
  pid: number;
  minimized: boolean;
}

export interface StartApp {
  name: string;
  appId: string;
}

export interface VolumeState {
  level: number;
  muted: boolean;
}

export type MediaAction = 'play_pause' | 'next' | 'previous' | 'stop';
export type WindowAction =
  | 'focus'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'snap_left'
  | 'snap_right'
  | 'next_monitor';

/** Everything AI-DA asks of Windows. Phase 3's .NET sidecar implements the same interface. */
export interface WindowsBridge {
  getVolume(): Promise<VolumeState>;
  setVolume(level: number): Promise<VolumeState>;
  setMuted(muted: boolean): Promise<VolumeState>;
  mediaKey(action: MediaAction): Promise<void>;
  listWindows(): Promise<WindowInfo[]>;
  foregroundWindow(): Promise<number>;
  windowAction(handle: number, action: WindowAction): Promise<boolean>;
  listStartApps(): Promise<StartApp[]>;
}

const responseSchema = z.object({
  id: z.number().nullable(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const volumeSchema = z.object({ level: z.number(), muted: z.boolean() });
const windowSchema = z
  .object({
    Handle: z.number(),
    Title: z.string(),
    Process: z.string(),
    Pid: z.number(),
    Minimized: z.boolean(),
  })
  .transform((w) => ({
    handle: w.Handle,
    title: w.Title,
    process: w.Process,
    pid: w.Pid,
    minimized: w.Minimized,
  }));
const appSchema = z.object({ name: z.string(), appId: z.string() });

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to a long-lived Windows PowerShell process that compiled `AidaWin.cs` once at startup
 * (~2–3 s), so each call afterwards takes only a few milliseconds.
 */
export class PowerShellWindowsBridge implements WindowsBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly hostScriptPath: string) {}

  /** Starts the helper in the background so the first command doesn't pay the compile cost. */
  warmUp(): void {
    void this.ensureStarted().catch(() => {});
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }

  async getVolume() {
    return volumeSchema.parse(await this.call('volume.get'));
  }

  async setVolume(level: number) {
    return volumeSchema.parse(await this.call('volume.set', { level: Math.round(level) }));
  }

  async setMuted(muted: boolean) {
    return volumeSchema.parse(await this.call('mute.set', { muted }));
  }

  async mediaKey(action: MediaAction) {
    await this.call('media.key', { action });
  }

  async listWindows() {
    const own = process.pid;
    return z
      .array(windowSchema)
      .parse(await this.call('windows.list'))
      .filter((w) => w.pid !== own);
  }

  async foregroundWindow() {
    return z.number().parse(await this.call('windows.foreground'));
  }

  async windowAction(handle: number, action: WindowAction) {
    return z.boolean().parse(await this.call('windows.act', { handle, action }));
  }

  async listStartApps() {
    return z.array(appSchema).parse(await this.call('apps.list', undefined, 20_000));
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;

    const proc = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.hostScriptPath,
      ],
      { windowsHide: true },
    );
    this.proc = proc;

    this.ready = new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(
        () => reject(new Error('Windows helper did not start in time.')),
        30_000,
      );
      const lines = createInterface({ input: proc.stdout });
      lines.on('line', (line) => {
        if (line.includes('"ready":true')) {
          clearTimeout(startTimer);
          resolve();
          return;
        }
        this.handleLine(line);
      });
      proc.on('error', (err) => {
        clearTimeout(startTimer);
        reject(err);
      });
      proc.on('exit', () => {
        clearTimeout(startTimer);
        reject(new Error('Windows helper exited during startup.'));
        this.failAll(new Error('Windows helper stopped unexpectedly.'));
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
      });
    });
    return this.ready;
  }

  private handleLine(line: string): void {
    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(line));
    } catch {
      return;
    }
    if (parsed.id === null) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.ok) pending.resolve(parsed.result);
    else pending.reject(new Error(cleanError(parsed.error)));
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async call(
    cmd: string,
    args?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    await this.ensureStarted();
    const proc = this.proc;
    if (!proc) throw new Error('Windows helper is not running.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows helper timed out on ${cmd}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, cmd, args: args ?? {} })}\n`);
    });
  }
}

/** PowerShell wraps .NET exceptions as `Exception calling "Act" with "2" argument(s): "..."`. */
function cleanError(message: string | undefined): string {
  if (!message) return 'Windows helper failed.';
  const inner = /argument\(s\): "(.*)"$/.exec(message);
  return inner?.[1] ?? message;
}
