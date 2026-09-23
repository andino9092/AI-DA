import { useState } from 'react';
import { DEFAULT_SENSITIVE_APPS } from '@shared/sensitive-apps';
import { Button } from './components';

/**
 * Apps and title words AI-DA never reads from (password managers, banks). Stored in settings;
 * matching happens in the main process before any screen reading.
 */
export function SensitiveApps({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const entry = draft.trim();
    if (!entry || value.some((v) => v.toLowerCase() === entry.toLowerCase())) return;
    onChange([...value, entry]);
    setDraft('');
  };
  const missingDefaults = DEFAULT_SENSITIVE_APPS.filter((d) => !value.includes(d));

  return (
    <div>
      <div className="text-sm">Sensitive apps</div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        While one of these is the window Aida would act on, she reads nothing from the screen: no
        buttons, no text, no title. Matches app names and whole words in window titles (so “bank”
        covers your bank's site in a browser).
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Sensitive apps">
        {value.map((entry) => (
          <li
            key={entry}
            className="flex items-center gap-1 rounded-full border border-zinc-300 py-0.5 pr-1 pl-2.5 text-xs dark:border-zinc-700"
          >
            {entry}
            <button
              type="button"
              aria-label={`Remove ${entry}`}
              className="rounded-full px-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              onClick={() => onChange(value.filter((v) => v !== entry))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="App name or title word"
          aria-label="Add a sensitive app"
          maxLength={60}
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950"
        />
        <Button type="submit" disabled={!draft.trim()}>
          Add
        </Button>
        {missingDefaults.length > 0 && (
          <Button onClick={() => onChange([...value, ...missingDefaults])}>Restore defaults</Button>
        )}
      </form>
    </div>
  );
}
