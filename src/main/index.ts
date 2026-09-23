import { app, safeStorage } from 'electron';
import { SettingsStore } from './settings/store';
import { SecretVault } from './secrets/vault';
import { TrayController } from './app/tray';
import { openSettingsWindow } from './app/settings-window';
import { applyLaunchAtLogin } from './app/login-item';
import { paths } from './app/paths';
import { registerIpc } from './ipc';

// One AI-DA per user. A second launch just brings up settings in the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
  app.setAppUserModelId('com.andino.aida');

  // A tray app has no main window: closing settings must not quit.
  app.on('window-all-closed', () => {});

  void app.whenReady().then(start);
}

function start(): void {
  const settings = new SettingsStore(paths.settingsFile());
  const vault = new SecretVault(paths.vaultFile(), safeStorage);

  registerIpc({
    settings,
    vault,
    appInfo: () => ({
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      defaultModelsDir: paths.defaultModelsDir(),
    }),
  });

  const initial = settings.get();
  applyLaunchAtLogin(initial.launchAtLogin);

  const tray = new TrayController(
    {
      openSettings: () => openSettingsWindow(),
      setMicrophoneMuted: (muted) => settings.update({ microphoneMuted: muted }),
      setLaunchAtLogin: (enabled) => settings.update({ launchAtLogin: enabled }),
      quit: () => app.quit(),
    },
    {
      state: initial.microphoneMuted ? 'muted' : 'idle',
      microphoneMuted: initial.microphoneMuted,
      launchAtLogin: initial.launchAtLogin,
    },
  );

  settings.on('changed', (next, previous) => {
    if (next.launchAtLogin !== previous.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    tray.update({
      state: next.microphoneMuted ? 'muted' : 'idle',
      microphoneMuted: next.microphoneMuted,
      launchAtLogin: next.launchAtLogin,
    });
  });

  app.on('before-quit', () => tray.destroy());

  // First run: open settings so the user can add keys. Launch-at-login starts stay silent.
  const startedHidden = process.argv.includes('--hidden');
  if (!initial.firstRunComplete && !startedHidden) openSettingsWindow();
}
