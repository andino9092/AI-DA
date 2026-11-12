import { app, globalShortcut, net, Notification, safeStorage, session, shell } from 'electron';
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
import { SidecarWindowsBridge } from './native/win-host';
import { acceleratorToBinding } from './app/hotkeys';
import { Updater, type UpdateState } from './app/updater';
import { Connectivity } from './app/connectivity';
import { AppIndex } from './tools/apps/app-index';
import { appTools } from './tools/apps/tools';
import { launchKind } from './tools/apps/launch';
import { findSteamPath, steamGames } from './tools/apps/steam';
import { audioTools } from './tools/system/audio';
import { mediaTools } from './tools/media/tools';
import { uiTools } from './tools/ui/tools';
import { windowTools } from './tools/windows/tools';
import { timeTools } from './tools/info/time';
import { TimerService, timerMessage, timerTools } from './tools/info/timers';
import { ToolRegistry } from './tools/registry';
import { JsonlLog } from './safety/action-log';
import { ToolExecutor } from './safety/executor';
import { ConfirmBroker } from './safety/confirm-broker';
import { QuotaTracker } from './router/quota';
import { LlmRouter, testProvider } from './router/router';
import { buildProvider, createProviderSource, providerSlots } from './providers/llm/factory';
import { Assistant } from './agent/assistant';
import { ModelManager } from './models/model-manager';
import { VoiceService } from './voice/voice-service';
import { Ducker } from './voice/ducker';
import { join, parse as parsePath } from 'node:path';
import { fileTools } from './tools/files/tools';
import { registerModelScheme, serveModels } from './app/model-protocol';
import { VoiceprintStore } from './voice/speaker-id';
import { hostname } from 'node:os';
import { WeatherClient, weatherTools, type TemperatureUnit } from './tools/info/weather';
import { unitTools } from './tools/info/units';
import { SpotifyClient } from './spotify/client';
import { spotifyTools } from './tools/media/spotify';
import { MemoryStore, memoryTools } from './memory/memory';
import { routineTools } from './agent/routines';
import { detectSensitive } from './privacy/detectors';
import type { Routine } from '@shared/settings';
import { GOOGLE_CLIENT_ID, type NotificationsSnapshot } from '@shared/notifications';
import { GoogleClient } from './google/client';
import { GmailWatcher } from './notifications/gmail';
import { CalendarWatcher } from './notifications/calendar';
import { NotificationCenter } from './notifications/center';
import { NotificationService } from './notifications/service';
import { notificationTools } from './tools/info/notifications';

// One AI-DA per user. A second launch just brings up settings in the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
  registerModelScheme();
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
  // Local model files for the graphics-card voice engine (nothing else is served).
  serveModels(() => models.path(''));

  // Privacy first: everything that leaves the PC goes through this guard.
  const guard = new PrivacyGuard(() => ({
    maskContactInfo: settings.get().privacy.maskContactInfo,
    customValues: sensitive.values(),
  }));

  // Windows control through the small precompiled helper (starts in ~0.1 s).
  const win = new SidecarWindowsBridge(paths.resources('native', 'aida-win.exe'));
  win.warmUp();
  const sensitiveApps = () => settings.get().privacy.sensitiveApps;
  const apps = new AppIndex(win, [async () => steamGames(await findSteamPath())]);
  void apps.refresh().catch(() => {});

  // Timers and reminders: announced out loud and as a Windows notification.
  const timers = new TimerService(paths.timersFile(), (timer, late) => {
    const text = timerMessage(timer, late);
    voice.announce(text);
    if (Notification.isSupported()) new Notification({ title: 'AI-DA', body: text }).show();
  });

  const launcher = {
    launchApp: (appId: string) => {
      // Steam and other game launchers register links (steam://rungameid/730), not app ids.
      if (launchKind(appId) === 'link') {
        void shell.openExternal(appId);
        return;
      }
      spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    },
    openUrl: (url: string) => shell.openExternal(url),
  };

  // Weather (Open-Meteo, no key) and Spotify (the user's own developer app, PKCE sign-in).
  const weather = new WeatherClient();
  const temperatureUnit = (): TemperatureUnit => {
    const { unit } = settings.get().weather;
    if (unit !== 'auto') return unit;
    return ['US', 'LR', 'MM', 'BS', 'KY', 'PW', 'FM', 'MH'].includes(app.getLocaleCountryCode())
      ? 'fahrenheit'
      : 'celsius';
  };
  const spotify = new SpotifyClient({
    clientId: () => settings.get().spotify.clientId,
    loadRefreshToken: () => vault.get('spotify'),
    saveRefreshToken: (token) => (token ? vault.set('spotify', token) : vault.remove('spotify')),
    openBrowser: (url) => shell.openExternal(url),
  });

  // Notifications: the user's own Google sign-in app, read-only. Gmail gives only headers (sender,
  // subject), never message text. Read out locally at a good moment; nothing goes to the AI unless
  // the user asks about it.
  const google = new GoogleClient({
    clientId: () => settings.get().google.clientId,
    clientSecret: () => vault.get('google-client-secret'),
    loadRefreshToken: () => vault.get('google'),
    saveRefreshToken: (token) => (token ? vault.set('google', token) : vault.remove('google')),
    openBrowser: (url) => shell.openExternal(url),
  });
  const gmail = new GmailWatcher({
    google,
    filter: () => {
      const filter = settings.get().notifications.gmail;
      return filter === 'off' ? 'primary' : filter;
    },
    // Subjects with card numbers, IDs or the user's own sensitive values aren't read out.
    isSensitive: (text) =>
      detectSensitive(text, { maskContactInfo: false, customValues: sensitive.values() }).length >
      0,
  });
  const calendar = new CalendarWatcher({ google });
  const notificationListeners = new Set<() => void>();
  const notificationsChanged = () => {
    for (const listener of notificationListeners) listener();
  };
  // AI-DA's own microphone use (its audio window and echo canceller) isn't a call.
  const ownMicApps = [process.execPath, paths.resources('native', 'aida-win.exe')].map((p) =>
    p.replace(/\\/g, '#').toLowerCase(),
  );
  const center = new NotificationCenter({
    enabled: () => settings.get().notifications.enabled,
    holdWhenBusy: () => settings.get().notifications.holdWhenBusy,
    presence: () => win.presence(),
    voice: {
      get free() {
        return voice.free;
      },
      get canTalk() {
        return voice.canTalk;
      },
      notify: (text) => voice.notify(text),
    },
    show: (text) => {
      if (Notification.isSupported()) new Notification({ title: 'AI-DA', body: text }).show();
    },
    isOwnMicApp: (app) => ownMicApps.includes(app.toLowerCase()),
    changed: notificationsChanged,
  });
  const notifications = new NotificationService({
    google,
    gmail,
    calendar,
    center,
    settings: () => settings.get().notifications,
    granted: () => google.grantedScopes,
    changed: notificationsChanged,
  });
  const notificationsSnapshot = async (): Promise<NotificationsSnapshot> => ({
    google: await google.status(),
    ...notifications.snapshotParts(),
  });

  // What the user asked Aida to remember. Anything the Privacy Guard would mask is refused.
  const memory = new MemoryStore(
    paths.memoryFile(),
    (text) =>
      detectSensitive(text, { maskContactInfo: true, customValues: sensitive.values() }).length > 0,
  );
  const routines = {
    list: () => settings.get().routines,
    save: (next: Routine[]) => void settings.update({ routines: next }),
  };

  const registry = new ToolRegistry().register(
    ...audioTools(win),
    ...mediaTools({ win, appName: (id) => apps.nameForAppId(id) }),
    ...appTools(win, apps, launcher),
    ...windowTools(win, sensitiveApps),
    ...uiTools({ win, sensitiveApps }),
    ...timeTools(),
    ...timerTools(timers),
    ...weatherTools({
      client: weather,
      home: () => settings.get().weather.place,
      unit: temperatureUnit,
    }),
    ...unitTools(),
    ...memoryTools(memory),
    ...routineTools(routines),
    ...spotifyTools({
      spotify,
      hostname: hostname(),
      openSpotify: async () => {
        const found = await apps.best('spotify');
        if (!found || !/^spotify\b/i.test(found.name)) return false;
        launcher.launchApp(found.appId);
        return true;
      },
    }),
    ...notificationTools({
      center,
      gmail,
      calendar,
      google: () => {
        const granted = google.grantedScopes;
        return {
          connected: google.connected(),
          gmail: granted?.gmail !== false,
          calendar: granted?.calendar !== false,
        };
      },
    }),
    ...fileTools({
      knownFolders: Object.fromEntries(
        (['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos', 'home'] as const).map(
          (name) => [name, app.getPath(name)],
        ),
      ),
      searchRoots: [app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads')],
      recentDir: join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent'),
      readShortcut: (path) => {
        try {
          return shell.readShortcutLink(path).target || null;
        } catch {
          return null;
        }
      },
      openPath: (path) => shell.openPath(path),
    }),
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
    (summary): Promise<boolean> | null => voice.confirm(summary),
  );
  const executor = new ToolExecutor(registry, guard, confirmBroker.request, actionLog);
  const quota = new QuotaTracker(paths.quotaFile());
  const providers = createProviderSource(() => settings.get(), vault);
  // Offline indicator: no network, or the AI providers stopped answering.
  const connectivity = new Connectivity(
    () => net.isOnline(),
    () => tray.update({ state: trayState() }),
  );
  const router = new LlmRouter(providers, quota, outboundLog, {
    reached: () => connectivity.providerReached(),
    unreachable: () => connectivity.providerUnreachable(),
  });
  const assistant = new Assistant({
    guard,
    registry,
    executor,
    router,
    log: actionLog,
    emit: (event) => palette.send(event),
    hasNetwork: () => connectivity.hasNetwork,
    routines: routines.list,
    memory,
  });

  // Tray state: voice activity wins, then typed commands, then idle/muted.
  let voiceState: AssistantState | null = null;
  let running = 0;
  const trayState = (): AssistantState =>
    voiceState ??
    (running > 0
      ? 'thinking'
      : settings.get().microphoneMuted
        ? 'muted'
        : connectivity.online
          ? 'idle'
          : 'offline');

  // Commands run one at a time, in the order they were given (typed or spoken).
  let queue: Promise<unknown> = Promise.resolve();
  let current: AbortController | null = null;
  let generation = 0;
  const runCommand = (
    text: string,
    source: 'palette' | 'voice',
    activeWindow: number | null,
  ): Promise<string> => {
    const queuedIn = generation;
    const task = queue.then(async () => {
      // The panic key also drops commands that were still waiting their turn.
      if (queuedIn !== generation) return 'Cancelled.';
      const abort = new AbortController();
      current = abort;
      running++;
      tray.update({ state: trayState() });
      try {
        return await assistant.handle(text, { source, activeWindow, signal: abort.signal });
      } finally {
        if (current === abort) current = null;
        running--;
        tray.update({ state: trayState() });
      }
    });
    queue = task.catch(() => {});
    return task;
  };

  /** Panic key: stop the running command, anything queued, speech and pending questions. */
  const panic = () => {
    generation++;
    current?.abort();
    confirmBroker.cancelAll();
    voice.panic();
    void win.releaseModifiers().catch(() => {});
    actionLog.write({ type: 'panic' });
  };

  // Turns other apps down while Aida listens or talks (Settings → Voice).
  const ducker = new Ducker(win, {
    enabled: () => settings.get().voice.duckOthers,
    ownProcess: parsePath(process.execPath).name,
    stateFile: paths.duckedFile(),
  });
  void ducker.recover();

  const voice = new VoiceService({
    helperExe: paths.resources('native', 'aida-win.exe'),
    voiceprints: new VoiceprintStore(paths.voiceprintFile(), safeStorage),
    duck: (on) => void ducker.set(on),
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

  const shortcutStatus = { palette: false, pushToTalk: false, panic: false };
  const registerShortcuts = () => {
    globalShortcut.unregisterAll();
    const { palette: paletteKey, pushToTalk, panic: panicKey } = settings.get().shortcuts;
    const register = (accelerator: string, fn: () => void) => {
      try {
        return globalShortcut.register(accelerator, fn);
      } catch {
        return false;
      }
    };
    shortcutStatus.palette = register(paletteKey, () => void palette.toggle());
    shortcutStatus.panic = register(panicKey, panic);
    // Push-to-talk goes through the helper's keyboard hook so holding the key works; a plain
    // shortcut (press, then speak) is the fallback.
    const binding = acceleratorToBinding('ptt', pushToTalk);
    shortcutStatus.pushToTalk = binding !== null;
    const fallback = () => {
      shortcutStatus.pushToTalk = register(pushToTalk, () => voice.pushToTalk());
    };
    if (binding)
      win.setHotkeys([binding]).catch((err: unknown) => {
        console.error('[AI-DA] keyboard hook:', err);
        fallback();
      });
    else {
      void win.setHotkeys([]).catch(() => {});
      fallback();
    }
  };
  win.onHotkey((name, down) => {
    if (name !== 'ptt') return;
    if (down) voice.pushToTalkDown();
    else voice.pushToTalkUp();
  });
  registerShortcuts();

  const initial = settings.get();
  applyLaunchAtLogin(initial.launchAtLogin);

  const tray = new TrayController(
    {
      openSettings: () => openSettingsWindow(),
      openPalette: () => void palette.toggle(),
      setMicrophoneMuted: (muted) => settings.update({ microphoneMuted: muted }),
      setLaunchAtLogin: (enabled) => settings.update({ launchAtLogin: enabled }),
      checkForUpdates: () => void updater.check(),
      installUpdate: () => updater.installNow(),
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

  const updateMenu = (state: UpdateState) => {
    switch (state.status) {
      case 'checking':
        return { label: 'Checking for updates…', action: null };
      case 'downloading':
        return { label: `Downloading update ${state.version}…`, action: null };
      case 'ready':
        return { label: `Restart to update to ${state.version}`, action: 'install' as const };
      default:
        return { label: 'Check for updates', action: 'check' as const };
    }
  };
  const updater = new Updater(
    () => settings.get().autoUpdate,
    (state) => tray.update({ update: updateMenu(state) }),
  );
  if (updater.supported) {
    tray.update({ update: updateMenu({ status: 'idle' }) });
    updater.start();
  }

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
        panicShortcut: {
          accelerator: shortcuts.panic,
          registered: shortcutStatus.panic,
        },
      };
    },
    testKey: async (id) => {
      const key = vault.get(id);
      if (!key) return { ok: false, message: 'No key saved yet.' };
      const request = {
        system: PrivacyGuard.constant('Reply with the single word OK.'),
        messages: [{ role: 'user' as const, text: PrivacyGuard.constant('Say OK.') }],
        tools: [],
      };
      // Every model this key is used with (Gemini's main and backup models).
      const slots = providerSlots(settings.get().llm).filter((s) => s.id === id);
      const results = [];
      for (const { model, label } of slots) {
        const result = await testProvider(buildProvider(id, key, model), request, outboundLog);
        results.push({ ...result, label });
      }
      if (results.length === 1) return results[0]!;
      return {
        ok: results[0]!.ok,
        message: results.map((r) => `${r.label}: ${r.message}`).join(' '),
      };
    },
    usage: () =>
      providerSlots(settings.get().llm).map(({ slot, id, label, model, dailyLimit }) =>
        quota.usage(slot, { label, model, limit: dailyLimit, configured: vault.get(id) !== null }),
      ),
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
    weather: {
      findPlace: async (city) => {
        try {
          const place = await weather.geocode(city);
          if (!place) return { ok: false, error: `No place called “${city}” was found.` };
          settings.update({ weather: { ...settings.get().weather, place } });
          return { ok: true, name: place.name };
        } catch {
          return { ok: false, error: "Couldn't reach the weather service. Check your connection." };
        }
      },
    },
    memory: {
      list: () => memory.snapshot(),
      remove: (ids) => {
        memory.remove(ids);
        return memory.snapshot();
      },
      clear: () => {
        memory.clear();
        return memory.snapshot();
      },
      onChanged: (listener) => memory.onChanged(listener),
    },
    spotify: {
      status: () => spotify.status(),
      connect: () => spotify.connect(),
      disconnect: async () => {
        spotify.disconnect();
        return spotify.status();
      },
    },
    notifications: {
      snapshot: notificationsSnapshot,
      setGoogleClient: async (clientId, clientSecret) => {
        if (!GOOGLE_CLIENT_ID.test(clientId))
          return {
            ok: false,
            error:
              'A Client ID ends in .apps.googleusercontent.com. Copy it from the client’s page.',
          };
        if (clientSecret.length < 10 || /\s/.test(clientSecret))
          return {
            ok: false,
            error:
              'That doesn’t look like a Client secret. Copy it from the same page (it usually starts with GOCSPX-).',
          };
        // A different sign-in app means signing in again.
        await google.disconnect();
        vault.set('google-client-secret', clientSecret);
        settings.update({ google: { clientId } });
        return { ok: true, snapshot: await notificationsSnapshot() };
      },
      clearGoogleClient: async () => {
        await google.disconnect();
        vault.remove('google-client-secret');
        settings.update({ google: { clientId: null } });
        center.clear();
        notifications.reset();
        return notificationsSnapshot();
      },
      connect: async () => {
        const result = await google.connect();
        if (result.ok) notifications.reset();
        return result;
      },
      disconnect: async () => {
        await google.disconnect();
        center.clear();
        notifications.reset();
        return notificationsSnapshot();
      },
      test: async () => {
        const now = Date.now();
        center.add([
          {
            id: `system:test:${now}`,
            source: 'system',
            at: now,
            title: 'This is how notifications sound',
            detail: '',
            state: 'pending',
          },
        ]);
        void center.tick();
        return notificationsSnapshot();
      },
      unmute: () => {
        center.mute(null);
        return notificationsSnapshot();
      },
      onChanged: (listener) => notificationListeners.add(listener),
    },
    voice: {
      vadModel: () => voice.vadModel(),
      isAudioWindow: (id) => id === voice.audio.webContentsId,
      test: () => voice.test(),
      setMonitor: (target) => voice.setMonitor(target),
      idStatus: () => voice.voiceIdStatus(),
      idRecord: (add) => voice.recordVoiceSample(add),
      idSave: () => voice.saveVoiceprint(),
      idCancel: () => voice.cancelVoiceEnrollment(),
      idClear: () => voice.clearVoiceprint(),
    },
  });

  settings.on('changed', (next, previous) => {
    if (next.launchAtLogin !== previous.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    if (JSON.stringify(next.shortcuts) !== JSON.stringify(previous.shortcuts)) registerShortcuts();
    voice.refresh();
    if (
      next.notifications.enabled !== previous.notifications.enabled &&
      !next.notifications.enabled
    )
      center.clear();
    if (JSON.stringify(next.notifications) !== JSON.stringify(previous.notifications))
      notificationsChanged();
    tray.update({
      state: trayState(),
      microphoneMuted: next.microphoneMuted,
      launchAtLogin: next.launchAtLogin,
      paletteShortcut: shortcutStatus.palette ? displayAccelerator(next.shortcuts.palette) : null,
    });
  });

  voice.start();
  timers.start();
  notifications.start();
  connectivity.start();

  let restoredSound = false;
  app.on('will-quit', (event) => {
    // Put lowered apps back before the helper that does it shuts down (at most 1.5 s).
    if (!restoredSound && ducker.pending) {
      event.preventDefault();
      restoredSound = true;
      void Promise.race([ducker.set(false), new Promise((r) => setTimeout(r, 1500))]).finally(() =>
        app.quit(),
      );
      return;
    }
    updater.dispose();
    timers.dispose();
    notifications.stop();
    connectivity.stop();
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
