import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { ModelStatus } from '@shared/models';
import type { Settings, SettingsPatch } from '@shared/settings';
import { KOKORO_VOICES } from '@shared/voice';
import { Button, Section, Toggle } from './components';
import { ShortcutInput } from './ShortcutInput';

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

const selectClass =
  'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950';

export function VoiceSection({
  settings,
  info,
  update,
}: {
  settings: Settings;
  info: AppInfo;
  update: (patch: SettingsPatch) => void;
}) {
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    void window.aida.models.status().then(setModels);
    const off = window.aida.models.onChanged(setModels);
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) =>
        setMics(devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')),
      );
    return off;
  }, []);

  const voice = settings.voice;
  const setVoice = (patch: Partial<Settings['voice']>) => update({ voice: { ...voice, ...patch } });
  const missing = models.filter((m) => m.state !== 'ready');
  const downloading = models.some((m) => m.state === 'downloading');
  const remaining = missing.reduce((sum, m) => sum + m.bytes, 0);

  async function test() {
    setTesting(true);
    setTestError(null);
    const result = await window.aida.voice.test();
    setTesting(false);
    if (!result.ok) setTestError(result.error ?? 'Could not play the voice.');
  }

  return (
    <Section
      title="Voice"
      description="Say “Hey Aida, …” or press the push-to-talk shortcut. Listening, speech recognition and the voice all run on this PC; your audio is never uploaded."
    >
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {models.map((m) => (
            <li key={m.id} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  {m.label}
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{m.purpose}</span>
                </span>
                <span className="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                  {m.state === 'ready'
                    ? 'Installed'
                    : m.state === 'downloading'
                      ? `${formatBytes(m.received)} / ${formatBytes(m.bytes)}`
                      : formatBytes(m.bytes)}
                </span>
              </div>
              {m.state === 'downloading' && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className="h-full bg-accent transition-[width]"
                    style={{ width: `${Math.min(100, (m.received / m.bytes) * 100)}%` }}
                  />
                </div>
              )}
              {m.state === 'error' && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{m.error}</p>
              )}
            </li>
          ))}
        </ul>
        {missing.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Downloads from GitHub and Hugging Face; every file is checked against a pinned
              SHA-256.
            </span>
            <Button
              variant="primary"
              disabled={downloading}
              onClick={() => void window.aida.models.install()}
            >
              {downloading ? 'Downloading…' : `Download (${formatBytes(remaining)})`}
            </Button>
          </div>
        )}
      </div>

      <Toggle
        label="Listen for “Hey Aida”"
        hint="Speech is checked on this PC; anything that doesn't start with “Hey Aida” is discarded immediately."
        checked={voice.wakeWord}
        onChange={(v) => setVoice({ wakeWord: v })}
      />
      <Toggle
        label="Speak replies"
        checked={voice.speakReplies}
        onChange={(v) => setVoice({ speakReplies: v })}
      />
      <Toggle
        label="Show status pill"
        hint="A small indicator above the taskbar while Aida listens, thinks and talks."
        checked={voice.showOverlay}
        onChange={(v) => setVoice({ showOverlay: v })}
      />

      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-sm">Microphone</span>
        <select
          className={selectClass}
          aria-label="Microphone"
          value={voice.inputDeviceId ?? ''}
          onChange={(e) => setVoice({ inputDeviceId: e.target.value || null })}
        >
          <option value="">Windows default</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label || 'Microphone'}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-sm">Voice</span>
        <select
          className={selectClass}
          aria-label="Voice"
          value={voice.voice}
          onChange={(e) => setVoice({ voice: e.target.value })}
        >
          {KOKORO_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        <Button onClick={() => void test()} disabled={testing}>
          {testing ? 'Playing…' : 'Test voice'}
        </Button>
      </div>
      {testError && <p className="text-xs text-red-600 dark:text-red-400">{testError}</p>}

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm">Push to talk</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Press, then speak. Also stops Aida while she is talking.
          </div>
        </div>
        <ShortcutInput
          label="Push to talk"
          value={settings.shortcuts.pushToTalk}
          registered={info.pushToTalkShortcut.registered}
          onChange={(pushToTalk) => update({ shortcuts: { ...settings.shortcuts, pushToTalk } })}
        />
      </div>
    </Section>
  );
}
