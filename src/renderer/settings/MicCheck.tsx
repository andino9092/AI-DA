import { useEffect, useState } from 'react';
import type { HeardEvent } from '@shared/voice';
import { Button } from './components';

const KEEP = 6;

/** Below this peak (dBFS) Whisper starts to struggle; above it the mic is usually fine. */
const QUIET_DB = -30;

function hint(last: HeardEvent[]): string | null {
  if (last.length === 0) return null;
  const quiet = last.filter((h) => h.peakDb < QUIET_DB).length;
  if (quiet >= Math.ceil(last.length / 2))
    return 'Your voice is coming in quiet. Move closer, or raise the mic level in Windows Sound settings → Input. You can also set sensitivity to High.';
  const missed = last.filter((h) => !h.accepted && h.mode === 'wake').length;
  if (missed >= 2)
    return 'Aida hears you but not the name. Pause briefly after “Hey Aida”, or try sensitivity High.';
  return null;
}

/**
 * Shows the live mic level and what the wake-phrase check heard, so you can tell a quiet mic
 * from a misheard name. Everything stays in this window's memory; nothing is logged or saved.
 */
export function MicCheck({ disabledReason }: { disabledReason: string | null }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState<HeardEvent[]>([]);

  useEffect(() => {
    if (!open) return;
    const off = window.aida.voice.onMonitor((event) => {
      if (event.type === 'level') setLevel(event.rms);
      else setHeard((list) => [event.heard, ...list].slice(0, KEEP));
    });
    void window.aida.voice.monitor(true);
    // Let the meter fall back to zero when you stop talking.
    const decay = window.setInterval(() => setLevel((l) => (l < 0.01 ? 0 : l * 0.7)), 100);
    return () => {
      off();
      window.clearInterval(decay);
      void window.aida.voice.monitor(false);
    };
  }, [open]);

  const advice = hint(heard);

  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm">Mic check</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {disabledReason ??
              'See what Aida hears. Say “Hey Aida, what time is it?” a few times. Shown here only, never saved.'}
          </div>
        </div>
        <Button
          disabled={disabledReason !== null}
          onClick={() => {
            setOpen((o) => !o);
            setHeard([]);
            setLevel(0);
          }}
        >
          {open ? 'Stop' : 'Start'}
        </Button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={level}
          >
            <div
              className="h-full bg-emerald-500 transition-[width] duration-75"
              style={{ width: `${Math.min(100, level * 100)}%` }}
            />
          </div>
          {heard.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Listening… If the bar doesn't move when you talk, pick another microphone above.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {heard.map((h, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span
                    className={
                      h.accepted
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-zinc-400 dark:text-zinc-500'
                    }
                    aria-label={h.accepted ? 'Recognized' : 'Ignored'}
                  >
                    {h.accepted ? '✓' : '✗'}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {h.text ? `“${h.text}”` : <em className="text-zinc-400">(no words)</em>}
                  </span>
                  <span
                    className={`shrink-0 tabular-nums ${h.peakDb < QUIET_DB ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'}`}
                  >
                    {h.peakDb} dB
                  </span>
                </li>
              ))}
            </ul>
          )}
          {advice && <p className="text-xs text-amber-700 dark:text-amber-400">{advice}</p>}
        </div>
      )}
    </div>
  );
}
