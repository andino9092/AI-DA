import { useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { SecretsSnapshot } from '@shared/secrets';
import type { Settings, SettingsPatch } from '@shared/settings';
import { Button } from './components';
import { MicCheck } from './MicCheck';
import { ModelsCard } from './ModelsCard';
import { listenReady, useModels } from './models';
import { SecretRow } from './SecretRow';
import { displayAccelerator } from './shortcut';

const STEPS = ['Welcome', 'AI key', 'Voice', 'Mic check', 'Ready'] as const;

/**
 * First run: a few steps to get from "installed" to "talking to Aida". Every step can be skipped;
 * everything here is also in the regular settings afterwards.
 */
export function Setup({
  settings,
  secrets,
  info,
  update,
  onSecrets,
}: {
  settings: Settings;
  secrets: SecretsSnapshot;
  info: AppInfo;
  update: (patch: SettingsPatch) => void;
  onSecrets: (next: SecretsSnapshot) => void;
}) {
  const [step, setStep] = useState(0);
  const models = useModels();
  const anyKey = secrets.items.some((s) => s.configured);
  const voiceReady = listenReady(models);
  const downloading = models.some((m) => m.state === 'downloading');
  const finish = () => update({ firstRunComplete: true });
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const { shortcuts } = settings;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col px-6 py-8">
      <header className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-accent text-lg font-bold text-white">
          A
        </div>
        <div>
          <h1 className="text-lg font-semibold">Set up AI-DA</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </p>
        </div>
      </header>

      <ol className="mt-4 flex gap-1.5" aria-label="Setup progress">
        {STEPS.map((name, i) => (
          <li
            key={name}
            aria-current={i === step ? 'step' : undefined}
            className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-zinc-200 dark:bg-zinc-800'}`}
          />
        ))}
      </ol>

      <section className="mt-6 flex-1 space-y-4 text-sm">
        {step === 0 && (
          <>
            <p>
              Aida lives in your system tray. Talk to her (“Hey Aida, …”) or type a command, and she
              controls your PC: music, volume, apps, windows, buttons, files and timers.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">
              <li>Your voice is turned into text on this PC. Audio is never uploaded.</li>
              <li>
                Card numbers, passwords, bank details and other private values are replaced with
                placeholders before anything goes to the AI.
              </li>
              <li>Nothing is read from password managers or banking pages.</li>
              <li>
                Anything that sends, deletes or buys asks you first.{' '}
                {displayAccelerator(shortcuts.panic)} stops everything.
              </li>
            </ul>
          </>
        )}

        {step === 1 && (
          <>
            <p>
              Aida uses a free AI for requests that need thinking (“move Spotify to my other screen
              and pause it”). Add a free key from Google (Gemini) or Groq. Simple commands like
              volume, music, apps and timers work without one.
            </p>
            {secrets.items.map((status) => (
              <SecretRow
                key={status.name}
                status={status}
                disabled={!secrets.encryptionAvailable}
                onSaved={onSecrets}
              />
            ))}
            {anyKey && <p className="text-emerald-600 dark:text-emerald-400">✓ Key saved.</p>}
          </>
        )}

        {step === 2 && (
          <>
            <p>
              For voice, Aida needs speech recognition and a voice on this PC (about 2 GB, a
              one-time download). You can skip this and type commands with{' '}
              {displayAccelerator(shortcuts.palette)} instead.
            </p>
            <ModelsCard models={models} />
            {voiceReady && <p className="text-emerald-600 dark:text-emerald-400">✓ Voice ready.</p>}
          </>
        )}

        {step === 3 && (
          <>
            <p>
              Check that Aida hears you. Say “Hey Aida, what time is it?” and watch for a ✓. If it
              looks quiet, raise your mic in Windows Sound settings.
            </p>
            <MicCheck
              disabledReason={
                !voiceReady
                  ? 'Download the voice models in the previous step first.'
                  : settings.microphoneMuted
                    ? 'The microphone is muted (tray menu).'
                    : null
              }
            />
          </>
        )}

        {step === 4 && (
          <>
            <p>You're all set. The ways to reach Aida:</p>
            <ul className="space-y-1.5">
              {voiceReady && settings.voice.wakeWord && (
                <li>
                  <b>“Hey Aida, …”</b> anytime
                </li>
              )}
              {voiceReady && (
                <li>
                  <b>Hold {displayAccelerator(shortcuts.pushToTalk)}</b> and speak
                </li>
              )}
              <li>
                <b>{displayAccelerator(shortcuts.palette)}</b> to type a command
              </li>
              <li>
                <b>{displayAccelerator(shortcuts.panic)}</b> stops everything
              </li>
            </ul>
            <p className="text-zinc-600 dark:text-zinc-300">
              Try “open Spotify and set volume to 30” or “set a timer for 10 minutes”. Windows may
              hide the tray icon under the ^ arrow; drag it onto the taskbar to keep it in view.
            </p>
            {!info.isPackaged && (
              <p className="text-xs text-zinc-500">
                Development build: launch at login applies to the installed app only.
              </p>
            )}
          </>
        )}
      </section>

      <footer className="mt-8 flex items-center justify-between gap-3">
        <button
          type="button"
          className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
          onClick={finish}
        >
          Skip setup
        </button>
        <div className="flex gap-2">
          {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>Back</Button>}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>
              {step === 0
                ? 'Get started'
                : (step === 1 && !anyKey) || (step === 2 && !voiceReady && !downloading)
                  ? 'Skip'
                  : 'Next'}
            </Button>
          ) : (
            <Button variant="primary" onClick={finish}>
              Finish
            </Button>
          )}
        </div>
      </footer>
    </main>
  );
}
