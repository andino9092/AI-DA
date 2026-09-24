import { useEffect, useState } from 'react';
import type { MemorySnapshot } from '@shared/memory';
import { Button, Section } from './components';

export function MemorySection() {
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void window.aida.memory.list().then(setMemory);
    return window.aida.memory.onChanged(setMemory);
  }, []);

  if (!memory) return null;
  const empty = memory.facts.length === 0 && memory.nicknames.length === 0;

  async function remove(id: string) {
    setMemory(await window.aida.memory.remove([id]));
  }

  return (
    <Section
      title="Memory"
      description="Things you asked Aida to remember (“remember that I take my coffee black”) and nicknames (“when I say my editor, I mean VS Code”). Stored only on this PC; facts are included with AI requests so Aida can use them. Card numbers, passwords, emails and other private details are never saved."
    >
      {empty ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing remembered yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {memory.nicknames.map((n) => (
            <li key={n.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <span className="font-medium">“{n.nickname}”</span> means {n.means}
              </span>
              <Button onClick={() => void remove(n.id)} aria-label={`Forget ${n.nickname}`}>
                Remove
              </Button>
            </li>
          ))}
          {memory.facts.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 break-words">{f.text}</span>
              <Button onClick={() => void remove(f.id)} aria-label={`Forget ${f.text}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!empty &&
        (confirmClear ? (
          <div className="flex items-center gap-2 text-sm">
            Forget everything?
            <Button
              variant="danger"
              onClick={() =>
                void window.aida.memory.clear().then((m) => {
                  setMemory(m);
                  setConfirmClear(false);
                })
              }
            >
              Yes, forget all
            </Button>
            <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmClear(true)}>
            Forget everything
          </Button>
        ))}
    </Section>
  );
}
