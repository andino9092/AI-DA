import { useState } from 'react';
import type { KeyTestResult } from '@shared/llm';
import { SECRET_INFO, type SecretStatus, type SecretsSnapshot } from '@shared/secrets';
import { Button } from './components';

export function SecretRow({
  status,
  disabled,
  onSaved,
}: {
  status: SecretStatus;
  disabled: boolean;
  onSaved: (snapshot: SecretsSnapshot) => void;
}) {
  const info = SECRET_INFO[status.name];
  const [editing, setEditing] = useState(!status.configured);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<KeyTestResult | 'testing' | null>(null);

  async function runTest() {
    setTest('testing');
    setTest(await window.aida.llm.testKey(status.name));
  }

  async function save() {
    setBusy(true);
    const result = await window.aida.secrets.set(status.name, value);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setValue('');
    setError(null);
    setEditing(false);
    onSaved(result.snapshot);
    // Check the new key right away, so a typo shows up now rather than mid-command.
    void runTest();
  }

  async function remove() {
    onSaved(await window.aida.secrets.remove(status.name));
    setEditing(true);
  }

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {info.label}
            {status.configured ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                Saved ••••{status.hint}
              </span>
            ) : (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                Not set
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{info.purpose}</p>
        </div>
        <button
          type="button"
          className="shrink-0 text-xs text-accent hover:underline"
          onClick={() => void window.aida.app.openExternal(info.getKeyUrl)}
        >
          Get a free key ↗
        </button>
      </div>

      {editing ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste your ${info.label} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled || busy}
            aria-label={`${info.label} API key`}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={disabled || busy || value.trim() === ''}
          >
            Save
          </Button>
          {status.configured && (
            <Button onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          )}
        </form>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button onClick={() => void runTest()} disabled={disabled || test === 'testing'}>
            {test === 'testing' ? 'Testing…' : 'Test'}
          </Button>
          <Button onClick={() => setEditing(true)} disabled={disabled}>
            Replace
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={disabled}>
            Remove
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {test && test !== 'testing' && (
        <p
          role="status"
          className={`mt-2 text-xs ${test.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {test.ok ? '✓ ' : ''}
          {test.message}
        </p>
      )}
    </div>
  );
}
