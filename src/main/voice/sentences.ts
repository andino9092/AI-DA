const MAX_CHUNK = 220;

/**
 * Splits a reply into speakable chunks so the first sentence can play while the rest is still
 * being synthesized. Long sentences are split again at commas, then at spaces.
 */
export function splitForSpeech(text: string): string[] {
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
