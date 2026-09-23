import { useEffect, useRef, useState } from 'react';
import type { AssistantEvent } from '@shared/assistant';

interface Exchange {
  requestId: string | null;
  command: string;
  status: string | null;
  reply: { text: string; ok: boolean } | null;
}

interface PendingConfirm {
  confirmId: string;
  summary: string;
  usesSensitiveValue: boolean;
}

const HISTORY = 4;
const EXAMPLES = ['open spotify and set volume to 30', 'snap this window left', 'what time is it'];

export function Palette() {
  const [input, setInput] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offShown = window.aida.palette.onShown(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    const offEvent = window.aida.palette.onEvent((event: AssistantEvent) => {
      if (event.type === 'confirm') {
        setConfirm({
          confirmId: event.confirmId,
          summary: event.summary,
          usesSensitiveValue: event.usesSensitiveValue,
        });
        return;
      }
      if (event.type === 'confirm-resolved') {
        setConfirm((c) => (c?.confirmId === event.confirmId ? null : c));
        return;
      }
      setExchanges((list) => {
        const next = [...list];
        // Events for a new request attach to the newest exchange that has no id yet.
        let index = next.findIndex((x) => x.requestId === event.requestId);
        if (index === -1) index = next.findIndex((x) => x.requestId === null);
        if (index === -1) return list;
        const x = { ...next[index]!, requestId: event.requestId };
        if (event.type === 'status') x.status = event.text;
        if (event.type === 'reply') {
          x.reply = { text: event.text, ok: event.ok };
          x.status = null;
        }
        next[index] = x;
        return next;
      });
    });
    inputRef.current?.focus();
    return () => {
      offShown();
      offEvent();
    };
  }, []);

  function submit() {
    const command = input.trim();
    if (!command) return;
    setInput('');
    setExchanges((list) =>
      [{ requestId: null, command, status: 'Working…', reply: null }, ...list].slice(0, HISTORY),
    );
    void window.aida.palette.submit(command);
  }

  function answer(approved: boolean) {
    if (!confirm) return;
    void window.aida.palette.confirm(confirm.confirmId, approved);
    setConfirm(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (confirm) answer(false);
      else void window.aida.palette.hide();
    } else if (confirm && input === '' && (e.key === 'y' || e.key === 'n')) {
      e.preventDefault();
      answer(e.key === 'y');
    }
  }

  return (
    <div className="h-screen p-3">
      <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 text-zinc-100 shadow-2xl ring-1 ring-black/40">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-sm font-bold text-white">
            A
          </div>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask Aida to do something…"
            aria-label="Command"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-zinc-500"
          />
          <kbd className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400">
            Esc
          </kbd>
        </div>

        {confirm && (
          <div
            className="border-b border-white/10 bg-amber-500/10 px-4 py-3"
            role="alertdialog"
            aria-label="Confirm action"
          >
            <p className="text-sm">
              <span className="font-semibold">Allow this?</span> {confirm.summary}
            </p>
            {confirm.usesSensitiveValue && (
              <p className="mt-1 text-xs text-amber-300">
                This will use a private value stored on this PC. It is filled in locally and is
                never sent to the AI.
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => answer(true)}
                className="rounded-lg bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent-strong"
              >
                Yes (Y)
              </button>
              <button
                type="button"
                onClick={() => answer(false)}
                className="rounded-lg border border-white/15 px-3 py-1 text-sm hover:bg-white/5"
              >
                No (N)
              </button>
            </div>
          </div>
        )}

        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {exchanges.length === 0 && (
            <li className="text-sm text-zinc-500">
              Try:{' '}
              {EXAMPLES.map((e, i) => (
                <span key={e}>
                  {i > 0 && ' · '}
                  <button
                    type="button"
                    className="text-zinc-300 hover:underline"
                    onClick={() => setInput(e)}
                  >
                    {e}
                  </button>
                </span>
              ))}
            </li>
          )}
          {exchanges.map((x, i) => (
            <li key={`${x.requestId ?? 'pending'}-${i}`} className={i > 0 ? 'opacity-60' : ''}>
              <p className="text-xs text-zinc-500">{x.command}</p>
              {x.status && <p className="mt-0.5 animate-pulse text-sm text-zinc-400">{x.status}</p>}
              {x.reply && (
                <p className={`mt-0.5 text-sm ${x.reply.ok ? 'text-zinc-100' : 'text-red-300'}`}>
                  {x.reply.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
