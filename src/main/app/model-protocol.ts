import { net, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * aida-model:// serves the graphics-card voice engine (a worker in the audio window) its local
 * files, and nothing else:
 *   aida-model://models/kokoro/…  → the Kokoro model in the models folder
 *   aida-model://voices/<id>.bin  → a voice that ships inside the app
 */
export const MODEL_SCHEME = 'aida-model';

/** Must run before the app is ready. */
export function registerModelScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MODEL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

const VOICE_ID = /^[a-z]{2}_[a-z]+\.bin$/;

/** Maps a request URL to a file, or null if it's outside what may be served. */
export function resolveModelUrl(
  url: string,
  roots: { modelsDir: string; voicesDir: string },
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (parsed.hostname === 'voices') {
    return VOICE_ID.test(path) ? join(roots.voicesDir, path) : null;
  }
  if (parsed.hostname === 'models') {
    const root = join(roots.modelsDir, 'kokoro');
    const file = normalize(join(roots.modelsDir, path));
    return file.startsWith(root + sep) ? file : null;
  }
  return null;
}

export function serveModels(modelsDir: () => string): void {
  // kokoro-js ships its voices next to its code (inside app.asar when installed).
  const voicesDir = join(dirname(require.resolve('kokoro-js')), '..', 'voices');
  protocol.handle(MODEL_SCHEME, async (request) => {
    const file = resolveModelUrl(request.url, { modelsDir: modelsDir(), voicesDir });
    if (!file) return new Response('Not found', { status: 404 });
    const headers = { 'Access-Control-Allow-Origin': '*' };
    try {
      // Voices are small and may live in app.asar; model files are big and stream from disk.
      if (file.startsWith(voicesDir)) return new Response(await readFile(file), { headers });
      const response = await net.fetch(pathToFileURL(file).toString());
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Not found', { status: 404, headers });
    }
  });
}
