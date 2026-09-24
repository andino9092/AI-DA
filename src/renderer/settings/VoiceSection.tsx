import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { Settings, SettingsPatch } from '@shared/settings';
import { KOKORO_VOICES, type WakeSensitivity } from '@shared/voice';
import { Button, Section, Toggle } from './components';
import { MicCheck } from './MicCheck';
import { ModelsCard } from './ModelsCard';
import { listenReady, useModels } from './models';
import { ShortcutInput } from './ShortcutInput';

const SENSITIVITY: { id: WakeSensitivity; label: string }[] = [
  { id: 'low', label: 'Low: exact name only, ignores quiet speech' },
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High: quiet or distant mics, close-sounding names' },
];

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
  const models = useModels();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) =>
        setMics(devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')),
      );
  }, []);

  const voice = settings.voice;
  const setVoice = (patch: Partial<Settings['voice']>) => update({ voice: { ...voice, ...patch } });
  const micCheckBlocked = !listenReady(models)
    ? 'Download the speech models first.'
    : settings.microphoneMuted
      ? 'Unmute the microphone first (tray menu or General).'
      : null;

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
      <ModelsCard models={models} />

      <Toggle
        label="Listen for “Hey Aida”"
        hint="Speech is checked on this PC; anything that doesn't start with “Hey Aida” is discarded immediately."
        checked={voice.wakeWord}
        onChange={(v) => setVoice({ wakeWord: v })}
      />
      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-sm">Sensitivity</span>
        <select
          className={selectClass}
          aria-label="Wake word sensitivity"
          value={voice.wakeSensitivity}
          onChange={(e) => setVoice({ wakeSensitivity: e.target.value as WakeSensitivity })}
        >
          {SENSITIVITY.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
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
      <Toggle
        label="Lower other sounds while Aida listens"
        hint="Turns music and videos down while you give a command and while she answers, so she hears you (and you hear her). Put back right after."
        checked={voice.duckOthers}
        onChange={(v) => setVoice({ duckOthers: v })}
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

      <MicCheck disabledReason={micCheckBlocked} />

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
            Hold while you speak, or tap and then speak. Also stops Aida while she is talking.
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
