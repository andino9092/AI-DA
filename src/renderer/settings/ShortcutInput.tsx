import { useState } from 'react';
import { displayAccelerator, toAccelerator } from './shortcut';

/** Click, then press the new key combination. Esc cancels. */
export function ShortcutInput({
  label,
  value,
  registered,
  onChange,
}: {
  label: string;
  value: string;
  registered: boolean;
  onChange: (accelerator: string) => void;
}) {
  const [recording, setRecording] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        aria-label={`${label} shortcut: ${displayAccelerator(value)}. Click to change.`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          if (e.key === 'Escape') {
            setRecording(false);
            return;
          }
          const accelerator = toAccelerator(e.nativeEvent);
          if (accelerator) {
            onChange(accelerator);
            setRecording(false);
          }
        }}
        className={`rounded-md border px-2 py-1 text-xs whitespace-nowrap ${
          recording
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
        }`}
      >
        {recording ? 'Press keys… (Esc to cancel)' : displayAccelerator(value)}
      </button>
      {!registered && !recording && (
        <span className="text-xs text-red-600 dark:text-red-400">
          Taken by another app. Pick another.
        </span>
      )}
    </div>
  );
}
