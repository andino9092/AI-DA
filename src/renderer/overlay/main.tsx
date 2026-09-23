import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OverlayState } from '@shared/voice';
import '../styles.css';

const LABELS: Record<OverlayState['phase'], string> = {
  hidden: '',
  listening: 'Listening…',
  transcribing: 'Got it…',
  thinking: 'Thinking…',
  speaking: '',
  reply: '',
  error: '',
};

const DOT: Record<OverlayState['phase'], string> = {
  hidden: 'bg-zinc-500',
  listening: 'bg-emerald-400',
  transcribing: 'bg-emerald-400',
  thinking: 'bg-amber-400 animate-pulse',
  speaking: 'bg-sky-400',
  reply: 'bg-accent',
  error: 'bg-red-400',
};

function Overlay() {
  const [state, setState] = useState<OverlayState>({ phase: 'hidden' });

  useEffect(() => window.aida.voice.onOverlay(setState), []);

  if (state.phase === 'hidden') return null;
  const level = state.phase === 'listening' ? Math.max(0.08, state.level ?? 0) : 0;

  return (
    <div className="flex h-screen items-end justify-center p-2">
      <div
        role="status"
        aria-live="polite"
        className="flex max-w-full items-center gap-3 rounded-full border border-white/10 bg-zinc-900/95 px-4 py-2 text-sm text-zinc-100 shadow-xl ring-1 ring-black/40"
      >
        <span className={`size-2.5 shrink-0 rounded-full ${DOT[state.phase]}`} />
        {state.phase === 'listening' && (
          <span className="flex h-4 items-center gap-0.5" aria-hidden>
            {[0.6, 1, 0.75, 0.9, 0.5].map((k, i) => (
              <span
                key={i}
                className="w-1 rounded-full bg-emerald-400 transition-[height] duration-75"
                style={{ height: `${Math.max(3, level * k * 16)}px` }}
              />
            ))}
          </span>
        )}
        <span className="truncate">
          {LABELS[state.phase] && <span className="text-zinc-400">{LABELS[state.phase]} </span>}
          {state.text}
        </span>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <Overlay />
  </StrictMode>,
);
