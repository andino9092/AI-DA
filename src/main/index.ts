import { app, globalShortcut, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { SettingsStore } from './settings/store';
import { SecretVault } from './secrets/vault';
import { TrayController } from './app/tray';
import { openSettingsWindow } from './app/settings-window';
import { PaletteController } from './app/palette-window';
import { applyLaunchAtLogin } from './app/login-item';
import { paths } from './app/paths';
import { registerIpc } from './ipc';
import { PrivacyGuard } from './privacy/guard';
import { SensitiveValueStore } from './privacy/sensitive-values';
import { PowerShellWindowsBridge } from './native/win-host';
import { AppIndex } from './tools/apps/app-index';
import { appTools } from './tools/apps/tools';
import { audioTools } from './tools/system/audio';
import { windowTools } from './tools/windows/tools';
import { timeTools } from './tools/info/time';
import { ToolRegistry } from './tools/registry';
import { JsonlLog } from './safety/action-log';
import { ToolExecutor } from './safety/executor';
import { ConfirmBroker } from './safety/confirm-broker';
import { QuotaTracker } from './router/quota';
import { LlmRouter } from './router/router';
import { createProviderSource } from './providers/llm/factory';
import { Assistant } from './agent/assistant';

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

/** "Control+Alt+A" → "Ctrl+Alt+A" for menus. */
function displayAccelerator(accelerator: string): string {
  return accelerator.replace(/Control|CommandOrControl|CmdOrCtrl/g, 'Ctrl');
}

function start(): void {
  const settings = new SettingsStore(paths.settingsFile());
  const vault = new SecretVault(paths.vaultFile(), safeStorage);
  const sensitive = new SensitiveValueStore(paths.sensitiveValuesFile(), safeStorage);

  // Privacy first: everything that leaves the PC goes through this guard.
  const guard = new PrivacyGuard(() => ({
    maskContactInfo: settings.get().privacy.maskContactInfo,
    customValues: sensitive.values(),
  }));

  // Windows control (compiles its helper in the background, ~2–3 s).
  const win = new PowerShellWindowsBridge(paths.resources('native', 'host.ps1'));
  win.warmUp();
  const apps = new AppIndex(win);
  void apps.refresh().catch(() => {});

  const registry = new ToolRegistry().register(
    ...audioTools(win),
    ...appTools(win, apps, {
      launchApp: (appId) => {
        spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      },
      openUrl: (url) => shell.openExternal(url),
    }),
    ...windowTools(win),
    ...timeTools(),
  );

  const actionLog = new JsonlLog(paths.logsDir(), 'actions');
  const outboundLog = new JsonlLog(paths.logsDir(), 'outbound');
  const palette = new PaletteController(() => win.foregroundWindow());
  const confirmBroker = new ConfirmBroker(
    (event) => {
      palette.send(event);
      if (event.type === 'confirm') palette.show();
    },
    () => palette.hold(),
  );
  const executor = new ToolExecutor(registry, guard, confirmBroker.request, actionLog);
  const quota = new QuotaTracker(paths.quotaFile());
  const providers = createProviderSource(() => settings.get(), vault);
  const router = new LlmRouter(providers, quota, outboundLog);
  const assistant = new Assistant({
    guard,
    registry,
    executor,
    router,
    log: actionLog,
    emit: (event) => palette.send(event),
  });

  let shortcutRegistered = false;
  const registerShortcut = (accelerator: string) => {
    globalShortcut.unregisterAll();
    try {
      shortcutRegistered = globalShortcut.register(accelerator, () => void palette.toggle());
    } catch {
      shortcutRegistered = false;
    }
  };
  registerShortcut(settings.get().shortcuts.palette);

  const initial = settings.get();
  applyLaunchAtLogin(initial.launchAtLogin);

  let running = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const tray = new TrayController(
    {
      openSettings: () => openSettingsWindow(),
      openPalette: () => void palette.toggle(),
      setMicrophoneMuted: (muted) => settings.update({ microphoneMuted: muted }),
      setLaunchAtLogin: (enabled) => settings.update({ launchAtLogin: enabled }),
      quit: () => app.quit(),
    },
    {
      state: initial.microphoneMuted ? 'muted' : 'idle',
      microphoneMuted: initial.microphoneMuted,
      launchAtLogin: initial.launchAtLogin,
      paletteShortcut: shortcutRegistered ? displayAccelerator(initial.shortcuts.palette) : null,
    },
  );

  const idleState = () => (settings.get().microphoneMuted ? 'muted' : 'idle');

  registerIpc({
    settings,
    vault,
    sensitive,
    logsDir: paths.logsDir(),
    appInfo: () => ({
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      defaultModelsDir: paths.defaultModelsDir(),
      paletteShortcut: {
        accelerator: displayAccelerator(settings.get().shortcuts.palette),
        registered: shortcutRegistered,
      },
    }),
    usage: () => {
      const { llm } = settings.get();
      return (['gemini', 'groq'] as const).map((id) =>
        quota.usage(id, llm[id].dailyLimit, vault.get(id) !== null),
      );
    },
    palette: {
      // Commands run one at a time, in the order they were typed.
      submit: (text) => {
        const task = queue.then(async () => {
          running++;
          tray.update({ state: 'thinking' });
          try {
            await assistant.handle(text, {
              source: 'palette',
              activeWindow: palette.activeWindowHandle,
            });
          } finally {
            running--;
            if (running === 0) tray.update({ state: idleState() });
          }
        });
        queue = task.catch(() => {});
        return task;
      },
      confirm: (id, approved) => confirmBroker.resolve(id, approved),
      hide: () => palette.hide(),
    },
  });

  settings.on('changed', (next, previous) => {
    if (next.launchAtLogin !== previous.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    if (next.shortcuts.palette !== previous.shortcuts.palette)
      registerShortcut(next.shortcuts.palette);
    tray.update({
      state: running > 0 ? 'thinking' : next.microphoneMuted ? 'muted' : 'idle',
      microphoneMuted: next.microphoneMuted,
      launchAtLogin: next.launchAtLogin,
      paletteShortcut: shortcutRegistered ? displayAccelerator(next.shortcuts.palette) : null,
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    confirmBroker.cancelAll();
    win.dispose();
    tray.destroy();
  });

  // First run: open settings so the user can add keys. Launch-at-login starts stay silent.
  const startedHidden = process.argv.includes('--hidden');
  if (!initial.firstRunComplete && !startedHidden) openSettingsWindow();
}
