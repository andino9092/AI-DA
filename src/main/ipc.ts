import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, type AppInfo, type SaveSecretResult } from '@shared/ipc';
import { settingsPatchSchema } from '@shared/settings';
import { secretNameSchema } from './secrets/schemas';
import type { SettingsStore } from './settings/store';
import type { SecretVault } from './secrets/vault';
import { isAllowedExternalUrl } from './app/external-links';

interface Deps {
  settings: SettingsStore;
  vault: SecretVault;
  appInfo: () => AppInfo;
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

export function registerIpc({ settings, vault, appInfo }: Deps): void {
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
      const message =
        err instanceof z.ZodError
          ? (err.issues[0]?.message ?? 'Invalid key.')
          : err instanceof Error
            ? err.message
            : 'Could not save the key.';
      return { ok: false, error: message };
    }
  });
  handle(IPC.secretsRemove, (_e, name) => {
    vault.remove(secretNameSchema.parse(name));
    return vault.snapshot();
  });

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
}
