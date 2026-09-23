import { useEffect, useState } from 'react';
import type { SensitiveValueSummary } from '@shared/privacy';
import type { Settings, SettingsPatch } from '@shared/settings';
import { Button, Section, Toggle } from './components';

export function PrivacySection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: SettingsPatch) => void;
}) {
  const [items, setItems] = useState<SensitiveValueSummary[]>([]);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.aida.privacy.list().then(setItems);
  }, []);

  async function add() {
    const result = await window.aida.privacy.add(label, value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems(result.items);
    setLabel('');
    setValue('');
    setError(null);
  }

  return (
    <Section
      title="Privacy"
      description="Card, bank and Social Security numbers, passwords, codes and keys are always replaced with placeholders like [CARD_1] before anything is sent to an AI provider."
    >
      <div>
        <div className="text-sm">Your sensitive values</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          Things only you know are private (account numbers, your address). They are encrypted on
          this PC and masked even when mentioned without context.
        </div>
        {items.length > 0 && (
          <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span>
                  {item.label}
                  {item.hint && (
                    <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                      ••••{item.hint}
                    </span>
                  )}
                </span>
                <Button
                  variant="danger"
                  onClick={() => void window.aida.privacy.remove(item.id).then(setItems)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name (e.g. Savings account)"
            aria-label="Name"
            className="w-44 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value"
            aria-label="Value"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950"
          />
          <Button type="submit" variant="primary" disabled={!label.trim() || !value.trim()}>
            Add
          </Button>
        </form>
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <Toggle
        label="Also mask emails and phone numbers"
        hint="Off by default, because requests like “email John” need them."
        checked={settings.privacy.maskContactInfo}
        onChange={(v) => update({ privacy: { ...settings.privacy, maskContactInfo: v } })}
      />

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm">Outbound log</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Every request sent to an AI provider, exactly as sent, so you can check what left this
            PC. Kept for 30 days.
          </div>
        </div>
        <Button onClick={() => void window.aida.app.openLogs()}>Open logs</Button>
      </div>
    </Section>
  );
}
