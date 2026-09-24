import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import { IPC, type AppInfo, type FindPlaceResult, type SaveSecretResult } from '@shared/ipc';
import type { SpotifyConnectResult, SpotifyStatus } from '@shared/spotify';
import type { MemorySnapshot } from '@shared/memory';
import type { KeyTestResult, ProviderUsage } from '@shared/llm';
import type { AddSensitiveValueResult } from '@shared/privacy';
import type { ModelStatus } from '@shared/models';
import { settingsPatchSchema } from '@shared/settings';
import type { SettingsStore } from './settings/store';
import type { SecretVault } from './secrets/vault';
import { secretNameSchema } from './secrets/schemas';
import type { SensitiveValueStore } from './privacy/sensitive-values';
import { isAllowedExternalUrl } from './app/external-links';

interface Deps {
  settings: SettingsStore;
  vault: SecretVault;
  sensitive: SensitiveValueStore;
  appInfo: () => AppInfo;
  usage: () => ProviderUsage[];
  testKey: (provider: 'gemini' | 'groq') => Promise<KeyTestResult>;
  logsDir: string;
  palette: {
    submit(text: string): Promise<void>;
    confirm(confirmId: string, approved: boolean): void;
    hide(): void;
  };
  models: {
    status(): ModelStatus[];
    install(): Promise<void>;
    onChanged(listener: (status: ModelStatus[]) => void): void;
  };
  weather: {
    findPlace(city: string): Promise<FindPlaceResult>;
  };
  memory: {
    list(): MemorySnapshot;
    remove(ids: string[]): MemorySnapshot;
    clear(): MemorySnapshot;
    onChanged(listener: (snapshot: MemorySnapshot) => void): void;
  };
  spotify: {
    status(): Promise<SpotifyStatus>;
    connect(): Promise<SpotifyConnectResult>;
    disconnect(): Promise<SpotifyStatus>;
  };
  voice: {
    vadModel(): Promise<Uint8Array>;
    isAudioWindow(webContentsId: number): boolean;
    test(): Promise<{ ok: boolean; error?: string }>;
    setMonitor(target: WebContents | null): void;
  };
}

/** Only our own pages (the dev server or bundled files) may call into the main process. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  if (!url) return false;
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl && url.startsWith(devUrl)) return true;
  return url.startsWith('file://');
}

function handle<T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => T,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event))
      throw new Error(`Blocked IPC call to ${channel} from untrusted sender`);
    return fn(event, ...args);
  });
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  return err instanceof Error ? err.message : fallback;
}

export function registerIpc({
  settings,
  vault,
  sensitive,
  appInfo,
  usage,
  testKey,
  logsDir,
  palette,
  models,
  weather,
  memory,
  spotify,
  voice,
}: Deps): void {
  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsUpdate, (_e, patch) => settings.update(settingsPatchSchema.parse(patch)));

  settings.on('changed', (next) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.settingsChanged, next);
    }
  });

  handle(IPC.secretsList, () => vault.snapshot());
  handle(IPC.secretsSet, (_e, name, value): SaveSecretResult => {
    const secretName = secretNameSchema.parse(name);
    try {
      vault.set(secretName, z.string().parse(value));
      return { ok: true, snapshot: vault.snapshot() };
    } catch (err) {
      return { ok: false, error: errorMessage(err, 'Could not save the key.') };
    }
  });
  handle(IPC.secretsRemove, (_e, name) => {
    vault.remove(secretNameSchema.parse(name));
    return vault.snapshot();
  });

  handle(IPC.privacyList, () => sensitive.list());
  handle(IPC.privacyAdd, (_e, label, value): AddSensitiveValueResult => {
    try {
      return {
        ok: true,
        items: sensitive.add({ label: z.string().parse(label), value: z.string().parse(value) }),
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err, 'Could not save that value.') };
    }
  });
  handle(IPC.privacyRemove, (_e, id) => sensitive.remove(z.string().parse(id)));

  handle(IPC.llmUsage, () => usage());
  handle(IPC.llmTest, (_e, provider) => testKey(secretNameSchema.parse(provider)));

  handle(IPC.appInfo, () => appInfo());
  handle(IPC.chooseFolder, async (event, defaultPath) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: 'Choose models folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: z.string().optional().parse(defaultPath),
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(IPC.openExternal, async (_e, url) => {
    const target = z.string().parse(url);
    if (isAllowedExternalUrl(target)) await shell.openExternal(target);
  });
  handle(IPC.openLogs, async () => {
    await shell.openPath(logsDir);
  });

  handle(IPC.paletteSubmit, (_e, text) => palette.submit(z.string().max(2000).parse(text)));
  handle(IPC.paletteConfirm, (_e, id, approved) =>
    palette.confirm(z.string().parse(id), z.boolean().parse(approved)),
  );
  handle(IPC.paletteHide, () => palette.hide());

  handle(IPC.modelsStatus, () => models.status());
  handle(IPC.modelsInstall, () => models.install());
  models.onChanged((status) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(IPC.modelsChanged, status);
  });

  handle(IPC.weatherFindPlace, (_e, city) =>
    weather.findPlace(z.string().min(1).max(100).parse(city)),
  );
  handle(IPC.memoryList, () => memory.list());
  handle(IPC.memoryRemove, (_e, ids) => memory.remove(z.array(z.string()).max(200).parse(ids)));
  handle(IPC.memoryClear, () => memory.clear());
  memory.onChanged((snapshot) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(IPC.memoryChanged, snapshot);
  });
  handle(IPC.spotifyStatus, () => spotify.status());
  handle(IPC.spotifyConnect, () => spotify.connect());
  handle(IPC.spotifyDisconnect, () => spotify.disconnect());

  handle(IPC.voiceVadModel, (event) => {
    if (!voice.isAudioWindow(event.sender.id))
      throw new Error('Only the audio window loads the voice detector.');
    return voice.vadModel();
  });
  handle(IPC.voiceTest, () => voice.test());
  handle(IPC.voiceMonitor, (event, enabled) =>
    voice.setMonitor(z.boolean().parse(enabled) ? event.sender : null),
  );
}
