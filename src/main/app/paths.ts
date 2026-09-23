import { app } from 'electron';
import { join } from 'node:path';

export const paths = {
  /** Bundled static files (icons). Packaged builds copy them next to app.asar. */
  resources: (...parts: string[]) =>
    app.isPackaged
      ? join(process.resourcesPath, 'resources', ...parts)
      : join(app.getAppPath(), 'resources', ...parts),
  settingsFile: () => join(app.getPath('userData'), 'settings.json'),
  vaultFile: () => join(app.getPath('userData'), 'vault.json'),
  defaultModelsDir: () => join(app.getPath('userData'), 'models'),
};
