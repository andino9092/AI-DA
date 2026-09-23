const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
};

/** Converts a key press into an Electron accelerator, or null if it isn't a usable shortcut. */
export function toAccelerator(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const modifiers = [
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super',
  ].filter(Boolean) as string[];
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3)
    : /^Digit\d$/.test(e.code)
      ? e.code.slice(5)
      : /^F\d{1,2}$/.test(e.key)
        ? e.key
        : (KEY_NAMES[e.key] ?? null);
  if (!key) return null;
  // Plain letters would hijack typing everywhere; require a modifier (function keys are fine alone).
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (
    !isFunctionKey &&
    (modifiers.length === 0 || (modifiers.length === 1 && modifiers[0] === 'Shift'))
  )
    return null;
  return [...modifiers, key].join('+');
}

export function displayAccelerator(accelerator: string): string {
  return accelerator.replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win');
}
