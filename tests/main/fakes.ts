import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  MediaAction,
  StartApp,
  VolumeState,
  WindowAction,
  WindowInfo,
  WindowsBridge,
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
    return 2;
  }
  async windowAction(handle: number, action: WindowAction) {
    this.actions.push({ handle, action });
    return true;
  }
  async listStartApps() {
    return this.apps;
  }
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
