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

export interface AppAudio {
  /** Process name, e.g. "Spotify". */
  process: string;
  level: number;
  muted: boolean;
}

export interface AudioDevice {
  id: string;
  name: string;
  default: boolean;
}

/** The app has no audio session (it hasn't played sound since it started). */
export class NoAppAudioError extends Error {
  constructor(readonly process: string) {
    super(`${process} isn't playing any sound right now.`);
  }
}

export type MediaAction = 'play_pause' | 'next' | 'previous' | 'stop';
export type MediaCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop';

export interface MediaSession {
  /** Windows' id for the app, e.g. "Spotify.exe" or a Store app id. */
  appId: string;
  status: string;
  title: string;
  artist: string;
  /** The session Windows shows in the volume flyout. */
  current: boolean;
}

export type WindowAction =
  | 'focus'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'snap_left'
  | 'snap_right'
  | 'next_monitor';

export interface UiElement {
  /** Valid until the next snapshot. */
  id: number;
  role: string;
  name: string;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Field contents (never for password fields). */
  value?: string;
  password?: boolean;
  focused?: boolean;
}

export interface UiSnapshot {
  window: { title: string; process: string };
  elements: UiElement[];
  truncated: boolean;
}

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

export interface HotkeyBinding {
  name: string;
  /** Windows virtual-key code of the main key. */
  vk: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
}

/** No app has a media session (nothing has played since it opened), or the named one doesn't. */
export class NoMediaSessionError extends Error {
  constructor(readonly app: string | null) {
    super(app ? `${app} isn't playing anything.` : 'Nothing is playing media right now.');
  }
}

/** A UI element id from an older snapshot: look at the window again. */
export class StaleElementError extends Error {}

/** Everything AI-DA asks of Windows, implemented by the aida-win.exe helper. */
export interface WindowsBridge {
  getVolume(): Promise<VolumeState>;
  setVolume(level: number): Promise<VolumeState>;
  setMuted(muted: boolean): Promise<VolumeState>;
  /** Apps with an audio session on the default output, with their own volume. */
  appAudio(): Promise<AppAudio[]>;
  setAppAudio(process: string, change: { level?: number; muted?: boolean }): Promise<AppAudio>;
  audioDevices(): Promise<AudioDevice[]>;
  setDefaultAudioDevice(id: string): Promise<void>;
  mediaKey(action: MediaAction): Promise<void>;
  mediaSessions(): Promise<MediaSession[]>;
  mediaControl(action: MediaCommand, app?: string): Promise<MediaSession & { accepted: boolean }>;
  listWindows(): Promise<WindowInfo[]>;
  foregroundWindow(): Promise<number>;
  windowInfo(handle: number): Promise<WindowInfo>;
  windowAction(handle: number, action: WindowAction): Promise<boolean>;
  listStartApps(): Promise<StartApp[]>;
  uiSnapshot(handle: number, max?: number): Promise<UiSnapshot>;
  uiClick(id: number): Promise<{ method: string }>;
  uiFocus(id: number): Promise<void>;
  /** What has keyboard focus right now (role, name), without reading the whole window. */
  focusedElement(): Promise<{ role: string; name: string; password: boolean }>;
  uiScroll(handle: number, direction: 'up' | 'down', amount: number): Promise<void>;
  typeText(text: string): Promise<void>;
  sendKeys(keys: string): Promise<void>;
  clickAt(x: number, y: number, double?: boolean): Promise<void>;
  releaseModifiers(): Promise<void>;
  ocrWindow(handle: number): Promise<OcrLine[]>;
  /** Watches these key combinations and reports presses and releases (for hold-to-talk). */
  setHotkeys(bindings: HotkeyBinding[]): Promise<void>;
  onHotkey(listener: (name: string, down: boolean) => void): () => void;
}

const responseSchema = z.object({
  id: z.number().nullable(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
const hotkeyEventSchema = z.object({
  event: z.literal('hotkey'),
  name: z.string(),
  down: z.boolean(),
});

const volumeSchema = z.object({ level: z.number(), muted: z.boolean() });
const windowSchema = z.object({
  handle: z.number(),
  title: z.string(),
  process: z.string(),
  pid: z.number(),
  minimized: z.boolean(),
});
const appAudioSchema = z.object({ process: z.string(), level: z.number(), muted: z.boolean() });
const audioDeviceSchema = z.object({ id: z.string(), name: z.string(), default: z.boolean() });
const appSchema = z.object({ name: z.string(), appId: z.string() });
const mediaSessionSchema = z.object({
  appId: z.string(),
  status: z.string(),
  title: z.string(),
  artist: z.string(),
  current: z.boolean(),
});
const uiSnapshotSchema = z.object({
  window: z.object({ title: z.string(), process: z.string() }),
  elements: z.array(
    z.object({
      id: z.number(),
      role: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      value: z.string().optional(),
      password: z.boolean().optional(),
      focused: z.boolean().optional(),
    }),
  ),
  truncated: z.boolean(),
});
const ocrSchema = z.object({
  lines: z.array(
    z.object({
      text: z.string(),
      words: z.array(
        z.object({ text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      ),
    }),
  ),
});

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to aida-win.exe, a small precompiled helper (native/aida-win) that starts in about 0.1 s.
 * One JSON line per request and response. The helper is restarted on the next call if it exits.
 */
export class SidecarWindowsBridge implements WindowsBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly hotkeyListeners = new Set<(name: string, down: boolean) => void>();
  private hotkeys: HotkeyBinding[] = [];
  private nextId = 1;

  constructor(private readonly exePath: string) {}

  warmUp(): void {
    void this.ensureStarted().catch(() => {});
  }

  dispose(): void {
    this.proc?.stdin.end();
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

  async appAudio() {
    return z.array(appAudioSchema).parse(await this.call('audio.apps'));
  }

  async setAppAudio(process: string, change: { level?: number; muted?: boolean }) {
    try {
      return appAudioSchema.parse(
        await this.call('audio.app.set', {
          process,
          level: change.level === undefined ? null : Math.round(change.level),
          muted: change.muted ?? null,
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NO_AUDIO:'))
        throw new NoAppAudioError(process);
      throw err;
    }
  }

  async audioDevices() {
    return z.array(audioDeviceSchema).parse(await this.call('audio.devices'));
  }

  async setDefaultAudioDevice(id: string) {
    await this.call('audio.device.set', { id });
  }

  async mediaKey(action: MediaAction) {
    await this.call('media.key', { action });
  }

  async mediaSessions() {
    return z.array(mediaSessionSchema).parse(await this.call('media.sessions'));
  }

  async mediaControl(action: MediaCommand, app?: string) {
    try {
      return mediaSessionSchema
        .extend({ accepted: z.boolean() })
        .parse(await this.call('media.control', { action, app: app ?? null }));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NO_SESSION'))
        throw new NoMediaSessionError(app ?? null);
      throw err;
    }
  }

  async listWindows() {
    const own = process.pid;
    return z
      .array(windowSchema)
      .parse(await this.call('windows.list'))
      .filter((w) => w.pid !== own);
  }

  async foregroundWindow() {
    return windowSchema.parse(await this.call('windows.foreground')).handle;
  }

  async windowInfo(handle: number) {
    return windowSchema.parse(await this.call('windows.info', { handle }));
  }

  async windowAction(handle: number, action: WindowAction) {
    return z.boolean().parse(await this.call('windows.act', { handle, action }));
  }

  async listStartApps() {
    return z.array(appSchema).parse(await this.call('apps.list', undefined, 20_000));
  }

  async uiSnapshot(handle: number, max = 250) {
    return uiSnapshotSchema.parse(await this.call('ui.snapshot', { handle, max }, 15_000));
  }

  async uiClick(id: number) {
    return z.object({ method: z.string() }).parse(await this.call('ui.click', { id }));
  }

  async uiFocus(id: number) {
    await this.call('ui.focus', { id });
  }

  async focusedElement() {
    return z
      .object({ role: z.string(), name: z.string(), password: z.boolean().default(false) })
      .parse(await this.call('ui.focused'));
  }

  async uiScroll(handle: number, direction: 'up' | 'down', amount: number) {
    await this.call('ui.scroll', { handle, direction, amount });
  }

  async typeText(text: string) {
    await this.call('input.type', { text }, 30_000);
  }

  async sendKeys(keys: string) {
    await this.call('input.keys', { keys });
  }

  async clickAt(x: number, y: number, double = false) {
    await this.call('input.click', { x: Math.round(x), y: Math.round(y), double });
  }

  async releaseModifiers() {
    await this.call('input.release');
  }

  async ocrWindow(handle: number) {
    return ocrSchema.parse(await this.call('ocr.window', { handle }, 20_000)).lines;
  }

  async setHotkeys(bindings: HotkeyBinding[]) {
    this.hotkeys = bindings;
    await this.call('hotkeys.set', { bindings });
  }

  onHotkey(listener: (name: string, down: boolean) => void) {
    this.hotkeyListeners.add(listener);
    return () => this.hotkeyListeners.delete(listener);
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;

    const proc = spawn(this.exePath, [], { windowsHide: true });
    this.proc = proc;

    this.ready = new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(
        () => reject(new Error('Windows helper did not start in time.')),
        10_000,
      );
      const lines = createInterface({ input: proc.stdout });
      lines.on('line', (line) => {
        if (line.includes('"ready":true')) {
          clearTimeout(startTimer);
          resolve();
          // A restarted helper forgets its shortcuts.
          if (this.hotkeys.length > 0)
            proc.stdin.write(
              `${JSON.stringify({ id: null, cmd: 'hotkeys.set', args: { bindings: this.hotkeys } })}\n`,
            );
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
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const hotkey = hotkeyEventSchema.safeParse(message);
    if (hotkey.success) {
      for (const listener of this.hotkeyListeners) listener(hotkey.data.name, hotkey.data.down);
      return;
    }
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success || parsed.data.id === null) return;
    const pending = this.pending.get(parsed.data.id);
    if (!pending) return;
    this.pending.delete(parsed.data.id);
    clearTimeout(pending.timer);
    if (parsed.data.ok) pending.resolve(parsed.data.result);
    else {
      const error = parsed.data.error ?? 'Windows helper failed.';
      pending.reject(
        error.startsWith('STALE: ')
          ? new StaleElementError(error.slice('STALE: '.length))
          : new Error(error),
      );
    }
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
