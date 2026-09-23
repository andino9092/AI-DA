import { app, globalShortcut, safeStorage, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import type { AssistantState } from '@shared/assistant';
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
import { ModelManager } from './models/model-manager';
import { VoiceService } from './voice/voice-service';

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
  const models = new ModelManager(() => settings.get().modelsDir ?? paths.defaultModelsDir());

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

  // Tray state: voice activity wins, then typed commands, then idle/muted.
  let voiceState: AssistantState | null = null;
  let running = 0;
  const trayState = (): AssistantState =>
    voiceState ?? (running > 0 ? 'thinking' : settings.get().microphoneMuted ? 'muted' : 'idle');

  // Commands run one at a time, in the order they were given (typed or spoken).
  let queue: Promise<unknown> = Promise.resolve();
  const runCommand = (text: string, source: 'palette' | 'voice', activeWindow: number | null) => {
    const task = queue.then(async () => {
      running++;
      tray.update({ state: trayState() });
      try {
        return await assistant.handle(text, { source, activeWindow });
      } finally {
        running--;
        tray.update({ state: trayState() });
      }
    });
    queue = task.catch(() => {});
    return task;
  };

  const voice = new VoiceService({
    settings: () => settings.get(),
    models,
    handleCommand: (text, activeWindow) => runCommand(text, 'voice', activeWindow),
    foregroundWindow: () => win.foregroundWindow(),
    setState: (state) => {
      voiceState = state;
      tray.update({ state: trayState() });
    },
  });

  // Only the hidden audio window may use the microphone.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' && contents.id === voice.audio.webContentsId);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    if (permission !== 'media') return false;
    const url = contents?.getURL() ?? '';
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    return url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl));
  });

  const shortcutStatus = { palette: false, pushToTalk: false };
  const registerShortcuts = () => {
    globalShortcut.unregisterAll();
    const { palette: paletteKey, pushToTalk } = settings.get().shortcuts;
    const register = (accelerator: string, fn: () => void) => {
      try {
        return globalShortcut.register(accelerator, fn);
      } catch {
        return false;
      }
    };
    shortcutStatus.palette = register(paletteKey, () => void palette.toggle());
    shortcutStatus.pushToTalk = register(pushToTalk, () => voice.pushToTalk());
  };
  registerShortcuts();

  const initial = settings.get();
  applyLaunchAtLogin(initial.launchAtLogin);

  const tray = new TrayController(
    {
      openSettings: () => openSettingsWindow(),
      openPalette: () => void palette.toggle(),
      setMicrophoneMuted: (muted) => settings.update({ microphoneMuted: muted }),
      setLaunchAtLogin: (enabled) => settings.update({ launchAtLogin: enabled }),
      quit: () => app.quit(),
    },
    {
      state: trayState(),
      microphoneMuted: initial.microphoneMuted,
      launchAtLogin: initial.launchAtLogin,
      paletteShortcut: shortcutStatus.palette
        ? displayAccelerator(initial.shortcuts.palette)
        : null,
    },
  );

  registerIpc({
    settings,
    vault,
    sensitive,
    logsDir: paths.logsDir(),
    appInfo: () => {
      const { shortcuts } = settings.get();
      return {
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        defaultModelsDir: paths.defaultModelsDir(),
        paletteShortcut: {
          accelerator: shortcuts.palette,
          registered: shortcutStatus.palette,
        },
        pushToTalkShortcut: {
          accelerator: shortcuts.pushToTalk,
          registered: shortcutStatus.pushToTalk,
        },
      };
    },
    usage: () => {
      const { llm } = settings.get();
      return (['gemini', 'groq'] as const).map((id) =>
        quota.usage(id, llm[id].dailyLimit, vault.get(id) !== null),
      );
    },
    palette: {
      submit: async (text) => {
        await runCommand(text, 'palette', palette.activeWindowHandle);
      },
      confirm: (id, approved) => confirmBroker.resolve(id, approved),
      hide: () => palette.hide(),
    },
    models: {
      status: () => models.status(),
      install: async () => {
        await models.installAll();
        voice.start();
      },
      onChanged: (listener) => models.on('changed', listener),
    },
    voice: {
      vadModel: () => voice.vadModel(),
      isAudioWindow: (id) => id === voice.audio.webContentsId,
      test: () => voice.test(),
    },
  });

  settings.on('changed', (next, previous) => {
    if (next.launchAtLogin !== previous.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    if (JSON.stringify(next.shortcuts) !== JSON.stringify(previous.shortcuts)) registerShortcuts();
    voice.refresh();
    tray.update({
      state: trayState(),
      microphoneMuted: next.microphoneMuted,
      launchAtLogin: next.launchAtLogin,
      paletteShortcut: shortcutStatus.palette ? displayAccelerator(next.shortcuts.palette) : null,
    });
  });

  voice.start();

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    confirmBroker.cancelAll();
    models.cancelAll();
    voice.dispose();
    win.dispose();
    tray.destroy();
  });

  // First run: open settings so the user can add keys. Launch-at-login starts stay silent.
  const startedHidden = process.argv.includes('--hidden');
  if (!initial.firstRunComplete && !startedHidden) openSettingsWindow();
}
