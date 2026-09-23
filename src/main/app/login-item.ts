import { app } from 'electron';

/**
 * Registers AI-DA to start with Windows. Only packaged builds touch the registry; in dev the
 * executable is electron.exe, and registering it would leave a broken startup entry behind.
 */
export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}
