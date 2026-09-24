/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeName(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Spoken forms of symbols in app names: "Notepad++", "C#".
      .replace(/\+/g, ' plus ')
      .replace(/#/g, ' sharp ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length]!;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) if (ch === needle[i]) i++;
  return i === needle.length;
}

/**
 * Scores how well a spoken/typed query matches a name, 0–1. Tuned for app and window names:
 * "chrome" → "Google Chrome", "vs code" → "Visual Studio Code", "spotfy" → "Spotify".
 */
export function matchScore(query: string, name: string): number {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;

  const qCompact = q.replace(/ /g, '');
  const nCompact = n.replace(/ /g, '');
  if (qCompact === nCompact) return 0.98;

  const words = n.split(' ');
  const initials = words.map((w) => w[0]).join('');
  if (n.startsWith(q)) return 0.92;
  if (words.some((w) => w === q)) return 0.9;
  if (qCompact.length >= 2 && initials === qCompact) return 0.88;
  if (q.split(' ').every((qw) => words.some((w) => w.startsWith(qw)))) return 0.85;
  if (n.includes(q)) return 0.8;
  if (qCompact.length >= 3 && initials.startsWith(qCompact)) return 0.75;

  // Typos: compare against the whole name and against each word.
  const candidates = [nCompact, ...words];
  let best = 0;
  for (const c of candidates) {
    const distance = levenshtein(qCompact, c);
    const similarity = 1 - distance / Math.max(qCompact.length, c.length);
    best = Math.max(best, similarity);
  }
  // Short names misheard by one letter ("zan" → "Zen"): one edit is a big fraction of a short
  // word, so allow it when the first letter matches.
  if (
    qCompact.length >= 3 &&
    qCompact.length <= 5 &&
    candidates.some((c) => c.length <= 5 && c[0] === qCompact[0] && levenshtein(qCompact, c) === 1)
  )
    return Math.max(0.62, best >= 0.75 ? 0.7 * best : 0);
  if (best >= 0.75) return 0.7 * best;
  if (qCompact.length >= 3 && isSubsequence(qCompact, nCompact)) return 0.55;
  return 0.5 * best;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export function rankByName<T>(
  query: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): Ranked<T>[] {
  return items
    .map((item) => ({ item, score: matchScore(query, nameOf(item)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
