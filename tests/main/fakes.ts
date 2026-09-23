import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NoMediaSessionError,
  type HotkeyBinding,
  type MediaAction,
  type MediaCommand,
  type MediaSession,
  type OcrLine,
  type UiElement,
  type UiSnapshot,
  type StartApp,
  type VolumeState,
  type WindowAction,
  type WindowInfo,
  type WindowsBridge,
} from '../../src/main/native/win-host';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderId,
} from '../../src/main/providers/llm/types';

export function tempDir(prefix = 'aida-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** In-memory Windows: records what AI-DA did instead of touching the real PC. */
export class FakeWindows implements WindowsBridge {
  volume: VolumeState = { level: 50, muted: false };
  media: MediaAction[] = [];
  actions: { handle: number; action: WindowAction }[] = [];
  windows: WindowInfo[] = [
    { handle: 1, title: 'Spotify Premium', process: 'Spotify', pid: 10, minimized: false },
    { handle: 2, title: 'GitHub - Google Chrome', process: 'chrome', pid: 11, minimized: false },
    { handle: 3, title: '#general - Discord', process: 'Discord', pid: 12, minimized: false },
  ];
  apps: StartApp[] = [
    { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
    { name: 'Google Chrome', appId: 'Chrome' },
    { name: 'Discord', appId: 'com.squirrel.Discord.Discord' },
    { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
    { name: 'Uninstall Discord', appId: 'uninstall' },
  ];

  async getVolume() {
    return { ...this.volume };
  }
  async setVolume(level: number) {
    this.volume.level = Math.max(0, Math.min(100, level));
    return { ...this.volume };
  }
  async setMuted(muted: boolean) {
    this.volume.muted = muted;
    return { ...this.volume };
  }
  async mediaKey(action: MediaAction) {
    this.media.push(action);
  }
  async listWindows() {
    return this.windows.map((w) => ({ ...w }));
  }
  async foregroundWindow() {
    return this.foreground;
  }
  async windowAction(handle: number, action: WindowAction) {
    this.actions.push({ handle, action });
    return true;
  }
  async listStartApps() {
    return this.apps;
  }

  sessions: MediaSession[] = [
    { appId: 'Spotify.exe', status: 'playing', title: 'Song A', artist: 'Band', current: true },
  ];
  mediaCommands: { action: MediaCommand; app?: string }[] = [];
  async mediaSessions() {
    return this.sessions.map((s) => ({ ...s }));
  }
  async mediaControl(action: MediaCommand, app?: string) {
    this.mediaCommands.push({ action, app });
    const session = app
      ? this.sessions.find((s) => s.appId.toLowerCase().includes(app))
      : this.sessions[0];
    if (!session) throw new NoMediaSessionError(app ?? null);
    if (action === 'pause') session.status = 'paused';
    if (action === 'play') session.status = 'playing';
    if (action === 'next') session.title = 'Song B';
    return { ...session, accepted: true };
  }

  foreground = 2;
  async windowInfo(handle: number) {
    const w = this.windows.find((x) => x.handle === handle);
    if (!w) throw new Error('That window no longer exists.');
    return { ...w };
  }

  /** Controls per window handle, as UI Automation would report them. */
  ui = new Map<number, UiElement[]>();
  ocr = new Map<number, OcrLine[]>();
  snapshots: number[] = [];
  clicked: number[] = [];
  clickedAt: { x: number; y: number }[] = [];
  focusedElements: number[] = [];
  typed: string[] = [];
  keys: string[] = [];
  scrolled: { handle: number; direction: string; amount: number }[] = [];
  ocrReads: number[] = [];
  async uiSnapshot(handle: number): Promise<UiSnapshot> {
    this.snapshots.push(handle);
    const w = await this.windowInfo(handle);
    return {
      window: { title: w.title, process: w.process },
      elements: this.ui.get(handle) ?? [],
      truncated: false,
    };
  }
  async uiClick(id: number) {
    this.clicked.push(id);
    return { method: 'invoke' };
  }
  async uiFocus(id: number) {
    this.focusedElements.push(id);
  }
  async uiScroll(handle: number, direction: 'up' | 'down', amount: number) {
    this.scrolled.push({ handle, direction, amount });
  }
  async typeText(text: string) {
    this.typed.push(text);
  }
  async sendKeys(keys: string) {
    this.keys.push(keys);
  }
  async clickAt(x: number, y: number) {
    this.clickedAt.push({ x, y });
  }
  async releaseModifiers() {}
  async ocrWindow(handle: number) {
    this.ocrReads.push(handle);
    return this.ocr.get(handle) ?? [];
  }
  hotkeys: HotkeyBinding[] = [];
  private hotkeyListener: ((name: string, down: boolean) => void) | null = null;
  async setHotkeys(bindings: HotkeyBinding[]) {
    this.hotkeys = bindings;
  }
  onHotkey(listener: (name: string, down: boolean) => void) {
    this.hotkeyListener = listener;
    return () => {
      this.hotkeyListener = null;
    };
  }
  pressHotkey(name: string, down: boolean) {
    this.hotkeyListener?.(name, down);
  }
}

/** A UI Automation element for tests. */
export function el(
  id: number,
  role: string,
  name: string,
  extra: Partial<UiElement> = {},
): UiElement {
  return { id, role, name, enabled: true, x: id * 10, y: 0, w: 10, h: 10, ...extra };
}

type Script = LlmResponse | Error | ((request: LlmRequest) => LlmResponse);

/** A provider that replays scripted responses and records every request it was sent. */
export class FakeProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly script: Script[],
    readonly model = `${id}-test`,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Deep copy so later mutation of the conversation doesn't rewrite history.
    this.requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
    const next = this.script.shift();
    if (!next) return { text: 'Done.', toolCalls: [] };
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request) : next;
  }
}
