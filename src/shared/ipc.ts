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
  appInfo: 'app:info',
  chooseFolder: 'dialog:choose-folder',
  openExternal: 'shell:open-external',
} as const;

export interface AppInfo {
  version: string;
  isPackaged: boolean;
  defaultModelsDir: string;
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
  app: {
    info(): Promise<AppInfo>;
    chooseFolder(defaultPath?: string): Promise<string | null>;
    openExternal(url: string): Promise<void>;
  };
}
