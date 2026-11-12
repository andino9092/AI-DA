import { useEffect, useState } from 'react';
import type { Settings, SettingsPatch } from '@shared/settings';
import type { VoiceIdStatus } from '@shared/voice';
import { Button, Toggle } from './components';

/** What to say for each sample: real commands, so the voiceprint matches how you talk to Aida. */
const PROMPTS = [
  'Hey Aida, what’s the weather today?',
  'Hey Aida, pause the music.',
  'Hey Aida, set a timer for ten minutes.',
  'Hey Aida, open Spotify.',
  'Hey Aida, what time is it?',
];

/** Below this, the recordings didn't agree with each other (noise, or someone else talking). */
const GOOD_CONSISTENCY = 0.6;

/**
 * "Only respond to my voice": records a few samples of the owner saying "Hey Aida, …" and saves
 * their voiceprint (encrypted, on this PC). After that, "Hey Aida" in any other voice (another
 * person, a video on a speaker, a TV) is ignored.
 */
export function VoiceId({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: SettingsPatch) => void;
}) {
  const [status, setStatus] = useState<VoiceIdStatus | null>(null);
  const [recording, setRecording] = useState(false);
  /** A recording session: a new voiceprint, or samples added over background sound. */
  const [session, setSession] = useState<'new' | 'add' | null>(null);
  const [message, setMessage] = useState<{ text: string; warn: boolean } | null>(null);
  const voice = settings.voice;

  useEffect(() => {
    void window.aida.voice.idStatus().then(setStatus);
    // Leaving the page drops unsaved samples.
    return () => void window.aida.voice.idCancel();
  }, []);

  if (!status) return null;

  async function record() {
    setRecording(true);
    setMessage(null);
    const result = await window.aida.voice.idRecord(session === 'add');
    setRecording(false);
    setStatus(result.status);
    if (!result.ok) setMessage({ text: result.error, warn: true });
    else if (result.status.recorded >= result.status.needed) await save();
  }

  async function save() {
    const adding = session === 'add';
    const result = await window.aida.voice.idSave();
    setStatus(result.status);
    setSession(null);
    if (!result.ok) return setMessage({ text: result.error, warn: true });
    // Samples over background sound are meant to differ from the quiet ones.
    const consistent = adding || (result.consistency ?? 1) >= GOOD_CONSISTENCY;
    setMessage({
      text: adding
        ? 'Added. Aida should now recognize you with sound playing too.'
        : consistent
          ? 'Saved. Aida now only answers “Hey Aida” in your voice.'
          : 'Saved, but the recordings didn’t sound alike. If Aida ignores you, record again somewhere quieter.',
      warn: !consistent,
    });
    if (!voice.onlyMyVoice) update({ voice: { ...voice, onlyMyVoice: true } });
  }

  async function cancel() {
    setStatus(await window.aida.voice.idCancel());
    setSession(null);
    setMessage(null);
  }

  async function forget() {
    setStatus(await window.aida.voice.idClear());
    setMessage({ text: 'Your voiceprint was deleted.', warn: false });
  }

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 px-3 py-3 dark:border-zinc-800">
      <Toggle
        label="Only respond to my voice"
        hint="“Hey Aida” only counts in your voice, not other people, or videos and music on a speaker. Push-to-talk works for anyone. Your voiceprint is encrypted and stays on this PC."
        checked={voice.onlyMyVoice}
        onChange={(v) => update({ voice: { ...voice, onlyMyVoice: v } })}
      />

      {!status.modelReady ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Download “Voice recognition” (26 MB) above first.
        </p>
      ) : session ? (
        <div className="space-y-2">
          <div className="text-sm">
            Sample {Math.min(status.recorded + 1, status.needed)} of {status.needed}.{' '}
            {session === 'add'
              ? 'Play music or a video the way you usually do (on your speaker, at your usual volume), then press Record and say:'
              : 'Press Record, then say, in your normal voice:'}
          </div>
          <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium dark:bg-zinc-950">
            {PROMPTS[status.recorded % PROMPTS.length]}
          </div>
          <div className="flex gap-2">
            <Button variant="primary" disabled={recording} onClick={() => void record()}>
              {recording ? 'Listening… say it now' : 'Record'}
            </Button>
            {status.recorded >= (session === 'add' ? 1 : 3) && !recording && (
              <Button onClick={() => void save()}>Save now</Button>
            )}
            <Button disabled={recording} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm">
            {status.enrolled
              ? `Your voice is saved (${status.saved} samples).`
              : 'Your voice isn’t recorded yet.'}
          </span>
          <Button
            variant={status.enrolled && !status.outdated ? 'secondary' : 'primary'}
            onClick={() => {
              setSession('new');
              setMessage(null);
            }}
          >
            {status.enrolled ? 'Record again' : 'Record my voice'}
          </Button>
          {status.enrolled && !status.outdated && (
            <Button
              onClick={() => {
                setSession('add');
                setMessage(null);
              }}
            >
              Add samples with sound playing
            </Button>
          )}
          {status.enrolled && (
            <Button variant="danger" onClick={() => void forget()}>
              Forget my voice
            </Button>
          )}
        </div>
      )}

      {status.enrolled && status.outdated && !session && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Voice matching works better with background sound in this version. Press Record again to
          update your voiceprint.
        </p>
      )}
      {status.enrolled && !status.outdated && !session && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          If Aida misses you while music or videos play, add a few samples with that sound on.
        </p>
      )}
      {voice.onlyMyVoice && status.modelReady && !status.enrolled && !session && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Until your voice is recorded, anyone can say “Hey Aida”.
        </p>
      )}
      {message && (
        <p
          role="status"
          className={`text-xs ${message.warn ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
