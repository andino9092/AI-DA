import { normalizeName } from '../util/fuzzy';

export interface WindowIdentity {
  title: string;
  process: string;
}

/**
 * Returns the sensitive-apps entry a window matches ("1Password", "bank"), or null. Entries match
 * whole words of the process name or window title, so "bank" matches "Chase Bank - Chrome" but
 * not "Bankside Hotel".
 */
export function matchSensitiveApp(
  window: WindowIdentity,
  entries: readonly string[],
): string | null {
  const haystack = ` ${normalizeName(window.process)} ${normalizeName(window.title)} `;
  for (const entry of entries) {
    const needle = normalizeName(entry);
    if (needle && haystack.includes(` ${needle} `)) return entry;
  }
  return null;
}

/** Thrown before anything is read from a window on the sensitive-apps list. */
export class SensitiveWindowError extends Error {
  constructor(readonly entry: string) {
    super(`That window matches “${entry}” on your sensitive apps list, so I don't read it.`);
  }
}
