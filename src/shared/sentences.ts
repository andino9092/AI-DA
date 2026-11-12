const MAX_CHUNK = 220;
/** A first sentence longer than this starts with its first clause, so audio begins sooner. */
const FIRST_CHUNK_TARGET = 48;
const MIN_LEAD = 12;

/**
 * Splits a reply into speakable chunks so the first sentence can play while the rest is still
 * being synthesized. Long sentences are split again at commas, then at spaces. Synthesis time
 * grows with length, so a long first sentence gives up its first clause ("It's 18 degrees,")
 * as a chunk of its own: that plays while the rest is made.
 */
export function splitForSpeech(text: string): string[] {
  const chunks = splitSentences(text);
  const first = chunks[0];
  if (!first || first.length <= FIRST_CHUNK_TARGET) return chunks;
  const pause = /[,;:—–]\s/g;
  let m: RegExpExecArray | null;
  while ((m = pause.exec(first))) {
    const at = m.index + 1;
    if (at < MIN_LEAD) continue;
    if (at > FIRST_CHUNK_TARGET + 12) break;
    const rest = first.slice(at).trim();
    // Not worth a split when almost nothing is left.
    if (rest.length < MIN_LEAD) break;
    return [first.slice(0, at).trim(), rest, ...chunks.slice(1)];
  }
  return chunks;
}

function splitSentences(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHUNK) {
      chunks.push(sentence);
      continue;
    }
    let current = '';
    for (const part of sentence.split(/(?<=[,;:])\s+/)) {
      if ((current + ' ' + part).trim().length > MAX_CHUNK && current) {
        chunks.push(current.trim());
        current = '';
      }
      if (part.length > MAX_CHUNK) {
        for (const word of part.split(' ')) {
          if ((current + ' ' + word).length > MAX_CHUNK && current) {
            chunks.push(current.trim());
            current = '';
          }
          current += ` ${word}`;
        }
      } else {
        current += ` ${part}`;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}
