/**
 * Whisper spells the name a few ways ("Aida", "Ada", "Ayda", "Ida"). A greeting ("hey", "ok",
 * "hi") makes any of them count. A bare name only counts when it's followed by a pause
 * (punctuation) or nothing, so "Ada Lovelace was..." in a video doesn't trigger AI-DA.
 */
const NAME = String.raw`(?:aida|a[iy]da|aída|ada|ayda|aide|ida|eda|a\.\s?i\.\s?d\.\s?a\.?)`;
const WITH_GREETING = new RegExp(
  String.raw`^\W*(?:hey|hi|hello|ok|okay|yo)[\s,.!-]+${NAME}\b[\s,.!?:;-]*`,
  'i',
);
const BARE_NAME = new RegExp(String.raw`^\W*${NAME}(?:[,.!?:;-]+\s*|\s*$)`, 'i');

export interface WakeMatch {
  /** What was said after the wake phrase, e.g. "pause the music". Empty if only the name. */
  command: string;
}

export function matchWakePhrase(transcript: string): WakeMatch | null {
  const text = transcript.trim();
  const match = WITH_GREETING.exec(text) ?? BARE_NAME.exec(text);
  if (!match) return null;
  const command = text
    .slice(match[0].length)
    .trim()
    .replace(/^[,.!?:;-]+\s*/, '');
  return { command };
}

/** Whisper's markers for non-speech, and captions it hallucinates on silence or noise. */
const NON_SPEECH =
  /\[(?:blank_audio|music|silence|noise|inaudible|applause|laughter)\]|\((?:music|silence|noise|inaudible)\)/gi;
const HALLUCINATIONS = /^(?:thank you\.?|thanks for watching[.!]?|you|bye\.?|\.+)$/i;

export function cleanTranscript(text: string): string {
  const cleaned = text.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(cleaned) ? '' : cleaned;
}
