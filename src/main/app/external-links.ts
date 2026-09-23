/** Only these hosts may be opened from a renderer; everything else is dropped. */
const ALLOWED_HOSTS = new Set(['aistudio.google.com', 'console.groq.com', 'github.com']);

export function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
