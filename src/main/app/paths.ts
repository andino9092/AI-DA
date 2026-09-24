import { app } from 'electron';
import { join } from 'node:path';

export const paths = {
  /** Bundled static files (icons, native helper). Packaged builds copy them next to app.asar. */
  resources: (...parts: string[]) =>
    app.isPackaged
      ? join(process.resourcesPath, 'resources', ...parts)
      : join(app.getAppPath(), 'resources', ...parts),
  settingsFile: () => join(app.getPath('userData'), 'settings.json'),
  vaultFile: () => join(app.getPath('userData'), 'vault.json'),
  sensitiveValuesFile: () => join(app.getPath('userData'), 'sensitive-values.json'),
  quotaFile: () => join(app.getPath('userData'), 'quota.json'),
  duckedFile: () => join(app.getPath('userData'), 'ducked.json'),
  logsDir: () => join(app.getPath('userData'), 'logs'),
  defaultModelsDir: () => join(app.getPath('userData'), 'models'),
};
