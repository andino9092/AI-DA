import { useState } from 'react';
import type { Routine, Settings, SettingsPatch } from '@shared/settings';
import { Button, Section } from './components';

const INPUT =
  'w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950';

interface Draft {
  /** Index being edited, or null for a new routine. */
  index: number | null;
  name: string;
  steps: string;
}

export function RoutinesSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: SettingsPatch) => void;
}) {
  const { routines } = settings;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!draft) return;
    const name = draft.name.trim();
    const steps = draft.steps
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!name) return setError('Give the routine a name.');
    if (name.length > 40) return setError('Keep the name under 40 characters.');
    if (steps.length === 0) return setError('Add at least one command.');
    if (steps.length > 10) return setError('A routine can have up to 10 commands.');
    if (steps.some((s) => s.length > 200))
      return setError('Each command must be under 200 characters.');
    const clash = routines.findIndex(
      (r, i) => i !== draft.index && r.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash >= 0) return setError('Another routine already has that name.');
    const routine: Routine = { name, steps };
    const next =
      draft.index === null
        ? [...routines, routine]
        : routines.map((r, i) => (i === draft.index ? routine : r));
    update({ routines: next });
    setDraft(null);
    setError(null);
  }

  return (
    <Section
      title="Routines"
      description="Say a routine's name (“gaming mode”, “start good morning”) to run its commands in order. Write each command the way you'd say it."
    >
      {routines.length > 0 && (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {routines.map((r, i) => (
            <li key={r.name} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs break-words text-zinc-500 dark:text-zinc-400">
                  {r.steps.join(' → ')}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => setDraft({ index: i, name: r.name, steps: r.steps.join('\n') })}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  onClick={() => update({ routines: routines.filter((_, j) => j !== i) })}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <form
          className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name, e.g. Gaming mode"
            aria-label="Routine name"
            className={INPUT}
          />
          <textarea
            value={draft.steps}
            onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
            placeholder={'One command per line, e.g.\nopen steam\nset volume to 40\nclose discord'}
            aria-label="Routine commands, one per line"
            rows={5}
            className={INPUT}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              Save
            </Button>
            <Button
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => setDraft({ index: null, name: '', steps: '' })}>New routine</Button>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Section>
  );
}
