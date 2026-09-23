import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { Settings, SettingsPatch } from '@shared/settings';
import type { SecretsSnapshot } from '@shared/secrets';
import { Button, Section, Toggle } from './components';
import { SecretRow } from './SecretRow';
import { PrivacySection } from './PrivacySection';
import { UsageSection } from './UsageSection';
import { VoiceSection } from './VoiceSection';
import { ShortcutInput } from './ShortcutInput';

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [secrets, setSecrets] = useState<SecretsSnapshot | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void Promise.all([
      window.aida.settings.get(),
      window.aida.secrets.list(),
      window.aida.app.info(),
    ]).then(([s, sec, i]) => {
      setSettings(s);
      setSecrets(sec);
      setInfo(i);
    });
    // Shortcut registration status lives in app info, so refresh it with every settings change.
    return window.aida.settings.onChanged((next) => {
      setSettings(next);
      void window.aida.app.info().then(setInfo);
    });
  }, []);

  if (!settings || !secrets || !info) return null;

  const update = (patch: SettingsPatch) =>
    void window.aida.settings.update(patch).then(setSettings);
  const modelsDir = settings.modelsDir ?? info.defaultModelsDir;
  const anyKey = secrets.items.some((s) => s.configured);

  async function chooseModelsDir() {
    const picked = await window.aida.app.chooseFolder(modelsDir);
    if (picked) update({ modelsDir: picked });
  }

  return (
    <main className="mx-auto max-w-2xl space-y-5 px-6 py-8">
      <header className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-accent text-lg font-bold text-white">
          A
        </div>
        <div>
          <h1 className="text-lg font-semibold">AI-DA</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Version {info.version}
            {!info.isPackaged && ' · development build'}
          </p>
        </div>
      </header>

      {!settings.firstRunComplete && (
        <div className="rounded-xl border border-accent/40 bg-accent/10 p-5">
          <h2 className="text-sm font-semibold">Welcome to AI-DA</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            AI-DA lives in your system tray. To get started, add at least one free API key below.
            Your voice, screen and sensitive information stay on this PC; only scrubbed text
            requests go to the AI provider.
          </p>
          <Button
            variant="primary"
            className="mt-3"
            disabled={!anyKey}
            onClick={() => update({ firstRunComplete: true })}
          >
            {anyKey ? 'Finish setup' : 'Add a key to continue'}
          </Button>
        </div>
      )}

      <Section
        title="AI providers"
        description="Keys are encrypted with Windows (DPAPI) and only ever sent to their own provider."
      >
        {!secrets.encryptionAvailable && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Windows encryption is unavailable, so keys can&apos;t be saved safely right now.
          </p>
        )}
        {secrets.items.map((status) => (
          <SecretRow
            key={status.name}
            status={status}
            disabled={!secrets.encryptionAvailable}
            onSaved={setSecrets}
          />
        ))}
      </Section>

      <VoiceSection settings={settings} info={info} update={update} />

      <UsageSection settings={settings} />

      <PrivacySection settings={settings} update={update} />

      <Section title="General">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm">Command box</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Type a command from anywhere.
            </div>
          </div>
          <ShortcutInput
            label="Command box"
            value={settings.shortcuts.palette}
            registered={info.paletteShortcut.registered}
            onChange={(palette) => update({ shortcuts: { ...settings.shortcuts, palette } })}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm">Panic key</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Stops everything Aida is doing right away: the command, typing, talking, questions.
            </div>
          </div>
          <ShortcutInput
            label="Panic key"
            value={settings.shortcuts.panic}
            registered={info.panicShortcut.registered}
            onChange={(panic) => update({ shortcuts: { ...settings.shortcuts, panic } })}
          />
        </div>
        <Toggle
          label="Launch at login"
          hint={
            info.isPackaged
              ? 'Start AI-DA quietly in the tray when you sign in to Windows.'
              : 'Saved, but only applied in the installed app (not in development builds).'
          }
          checked={settings.launchAtLogin}
          onChange={(v) => update({ launchAtLogin: v })}
        />
        <Toggle
          label="Mute microphone"
          hint="AI-DA won't listen for the wake word while muted."
          checked={settings.microphoneMuted}
          onChange={(v) => update({ microphoneMuted: v })}
        />
      </Section>

      <Section
        title="Storage"
        description="Local speech models (about 1.5–3 GB) are downloaded here in a later setup step."
      >
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-3 py-1.5 text-xs dark:bg-zinc-950">
            {modelsDir}
          </code>
          <Button onClick={() => void chooseModelsDir()}>Change…</Button>
          {settings.modelsDir && <Button onClick={() => update({ modelsDir: null })}>Reset</Button>}
        </div>
      </Section>
    </main>
  );
}
