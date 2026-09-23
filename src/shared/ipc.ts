import type { AssistantEvent } from './assistant';
import type { ModelStatus } from './models';
import type { AudioCommand, AudioEvent, MonitorEvent, OverlayState, Utterance } from './voice';
import type { ProviderUsage } from './llm';
import type { AddSensitiveValueResult, SensitiveValueSummary } from './privacy';
import type { Settings, SettingsPatch } from './settings';
import type { SecretName, SecretsSnapshot } from './secrets';

/** Every IPC channel lives here so main and preload can never drift apart. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChanged: 'settings:changed',
  secretsList: 'secrets:list',
  secretsSet: 'secrets:set',
  secretsRemove: 'secrets:remove',
  privacyList: 'privacy:list',
  privacyAdd: 'privacy:add',
  privacyRemove: 'privacy:remove',
  llmUsage: 'llm:usage',
  appInfo: 'app:info',
  chooseFolder: 'dialog:choose-folder',
  openExternal: 'shell:open-external',
  openLogs: 'shell:open-logs',
  paletteSubmit: 'palette:submit',
  paletteConfirm: 'palette:confirm',
  paletteHide: 'palette:hide',
  paletteShown: 'palette:shown',
  assistantEvent: 'assistant:event',
  voiceCommand: 'voice:command',
  voiceEvent: 'voice:event',
  voiceUtterance: 'voice:utterance',
  voiceVadModel: 'voice:vad-model',
  voiceTest: 'voice:test',
  voiceMonitor: 'voice:monitor',
  voiceMonitorEvent: 'voice:monitor-event',
  overlayState: 'overlay:state',
  modelsStatus: 'models:status',
  modelsInstall: 'models:install',
  modelsChanged: 'models:changed',
} as const;

export interface AppInfo {
  version: string;
  isPackaged: boolean;
  defaultModelsDir: string;
  /** Whether the command-box shortcut was registered (another app may own it). */
  paletteShortcut: { accelerator: string; registered: boolean };
  pushToTalkShortcut: { accelerator: string; registered: boolean };
}

export type SaveSecretResult =
  { ok: true; snapshot: SecretsSnapshot } | { ok: false; error: string };

/** The API exposed to renderers as `window.aida`. */
export interface AidaApi {
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<Settings>;
    onChanged(listener: (settings: Settings) => void): () => void;
  };
  secrets: {
    list(): Promise<SecretsSnapshot>;
    set(name: SecretName, value: string): Promise<SaveSecretResult>;
    remove(name: SecretName): Promise<SecretsSnapshot>;
  };
  privacy: {
    list(): Promise<SensitiveValueSummary[]>;
    add(label: string, value: string): Promise<AddSensitiveValueResult>;
    remove(id: string): Promise<SensitiveValueSummary[]>;
  };
  llm: {
    usage(): Promise<ProviderUsage[]>;
  };
  app: {
    info(): Promise<AppInfo>;
    chooseFolder(defaultPath?: string): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    openLogs(): Promise<void>;
  };
  models: {
    status(): Promise<ModelStatus[]>;
    install(): Promise<void>;
    onChanged(listener: (status: ModelStatus[]) => void): () => void;
  };
  voice: {
    /** Hidden audio window: commands from the main process. */
    onCommand(listener: (command: AudioCommand) => void): () => void;
    sendEvent(event: AudioEvent): void;
    sendUtterance(utterance: Utterance): void;
    getVadModel(): Promise<Uint8Array>;
    /** Overlay window. */
    onOverlay(listener: (state: OverlayState) => void): () => void;
    /** Settings: speak a sample sentence with the current voice. */
    test(): Promise<{ ok: boolean; error?: string }>;
    /** Settings → Mic check: turn live reporting on or off for this window. */
    monitor(enabled: boolean): Promise<void>;
    onMonitor(listener: (event: MonitorEvent) => void): () => void;
  };
  palette: {
    submit(text: string): Promise<void>;
    confirm(confirmId: string, approved: boolean): Promise<void>;
    hide(): Promise<void>;
    onEvent(listener: (event: AssistantEvent) => void): () => void;
    onShown(listener: () => void): () => void;
  };
}
