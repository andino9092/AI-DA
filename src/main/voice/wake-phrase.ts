/**
 * Whisper spells the name many ways ("Aida", "Ada", "Ayda", "Ida", "Aidan"), and sometimes
 * merges it with the greeting ("Hayda"). A greeting ("hey", "ok", "hi") makes any close spelling
 * count. A bare name only counts when it's one of the usual spellings followed by a pause
 * (punctuation) or nothing, so "Ada Lovelace was..." in a video doesn't trigger AI-DA.
 */
const NAMES = String.raw`(?:aida|a[iy]da|aída|ada|ayda|aide|ida|eda|a\.\s?i\.\s?d\.\s?a\.?)`;
const GREETING = String.raw`(?:hey|hay|hi|hello|ok|okay|yo)`;
const WITH_GREETING = new RegExp(
  String.raw`^\W*(?:${GREETING}[\s,.!-]+)+(${NAMES}|[a-zà-ÿ]{3,6})\b[\s,.!?:;-]*`,
  'i',
);
/** Greeting and name run together: "Hayda", "Heyda", "Haida", "Hey-Aida". */
const MERGED = /^\W*(?:ha|he|hei|hey|hay|hai)-?(?:ai|ay|a)?d[ae]h?\b[\s,.!?:;-]*/i;
const BARE_NAME = new RegExp(String.raw`^\W*${NAMES}(?:[,.!?:;-]+\s*|\s*$)`, 'i');
const KNOWN_NAME = new RegExp(String.raw`^${NAMES}$`, 'i');

/** Spellings Whisper produces for "Aida" that are too far from it for the fuzzy check. */
const EXTRA_NAMES = new Set(['aiden', 'aidan', 'haida', 'hayda', 'heyda']);

export interface WakeOptions {
  /** Accept close misspellings after a greeting ("Hey Aita") and run-together forms ("Hayda"). */
  fuzzy: boolean;
}

export interface WakeMatch {
  /** What was said after the wake phrase, e.g. "pause the music". Empty if only the name. */
  command: string;
}

export function matchWakePhrase(
  transcript: string,
  options: WakeOptions = { fuzzy: true },
): WakeMatch | null {
  const text = transcript.trim();
  const greeted = WITH_GREETING.exec(text);
  let match: RegExpExecArray | null = null;
  if (greeted && isName(greeted[1]!, options.fuzzy)) match = greeted;
  if (!match && options.fuzzy) match = MERGED.exec(text);
  match ??= BARE_NAME.exec(text);
  if (!match) return null;
  const command = text
    .slice(match[0].length)
    .trim()
    .replace(/^[,.!?:;-]+\s*/, '');
  return { command };
}

function isName(word: string, fuzzy: boolean): boolean {
  const w = word.toLowerCase();
  if (KNOWN_NAME.test(w)) return true;
  if (!fuzzy) return false;
  if (EXTRA_NAMES.has(w)) return true;
  // One letter off, and starting with a vowel sound: "aita", "eida", "aidah", "oida".
  return /^[aeiou]/.test(w) && w.length <= 5 && editDistance(w, 'aida') <= 1;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length]!;
}

/** Whisper's markers for non-speech, and captions it hallucinates on silence or noise. */
const NON_SPEECH =
  /\[(?:blank_audio|music|silence|noise|inaudible|applause|laughter)\]|\((?:music|silence|noise|inaudible)\)/gi;
const HALLUCINATIONS = /^(?:thank you\.?|thanks for watching[.!]?|you|bye\.?|\.+)$/i;

export function cleanTranscript(text: string): string {
  const cleaned = text.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(cleaned) ? '' : cleaned;
}
