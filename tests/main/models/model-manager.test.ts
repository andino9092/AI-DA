import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../../../src/main/models/manifest';
import { ModelManager } from '../../../src/main/models/model-manager';
import { tempDir } from '../fakes';

const vadFile = MODELS.find((m) => m.id === 'vad')!.files[0]!;

/** A fetch that serves fixed bytes for the VAD URL. */
function fakeFetch(body: Buffer): typeof fetch {
  return vi.fn(
    async () => new Response(new Uint8Array(body), { status: 200 }),
  ) as unknown as typeof fetch;
}

let dir: string;
beforeEach(() => {
  dir = tempDir('aida-models-');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ModelManager', () => {
  it('rejects and deletes a download whose hash does not match', async () => {
    const tampered = Buffer.alloc(vadFile.size, 7);
    const manager = new ModelManager(() => dir, fakeFetch(tampered));
    expect(await manager.install('vad')).toBe(false);
    expect(manager.status().find((m) => m.id === 'vad')).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/integrity check/),
    });
    expect(existsSync(join(dir, vadFile.path))).toBe(false);
    expect(existsSync(join(dir, `${vadFile.path}.part`))).toBe(false);
  });

  it('adopts an existing file only if its hash matches, then marks it verified', async () => {
    const target = join(dir, vadFile.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(vadFile.size, 1));
    const fetchSpy = fakeFetch(Buffer.alloc(0));
    const manager = new ModelManager(() => dir, fetchSpy);
    expect(manager.isReady('vad')).toBe(false);
    // Wrong content → it re-downloads (and the fake serves garbage, so it fails safely).
    expect(await manager.install('vad')).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports every model as missing in an empty folder', () => {
    const manager = new ModelManager(() => dir, fakeFetch(Buffer.alloc(0)));
    expect(manager.status().map((m) => m.state)).toEqual([
      'missing',
      'missing',
      'missing',
      'missing',
    ]);
  });

  it('treats a file with a valid marker and size as ready without re-hashing', () => {
    const target = join(dir, vadFile.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(vadFile.size));
    writeFileSync(`${target}.verified`, vadFile.sha256);
    const manager = new ModelManager(() => dir, fakeFetch(Buffer.alloc(0)));
    expect(manager.isReady('vad')).toBe(true);
    writeFileSync(`${target}.verified`, 'something else');
    expect(manager.isReady('vad')).toBe(false);
  });

  it('pins a SHA-256 for every file in the manifest', () => {
    for (const file of MODELS.flatMap((m) => m.files)) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.url).toMatch(/^https:\/\//);
      // Hugging Face URLs must be pinned to a commit, never "main".
      if (file.url.includes('huggingface.co')) expect(file.url).not.toContain('/resolve/main/');
    }
  });
});

describe('ModelManager archives', () => {
  const runtime = MODELS.find((m) => m.id === 'whisper-runtime')!;
  const archive = runtime.files[0]!;

  it('counts an extracted archive as ready after the zip itself was deleted', () => {
    const exe = join(dir, runtime.readyCheck);
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, 'exe');
    mkdirSync(dirname(join(dir, archive.path)), { recursive: true });
    writeFileSync(`${join(dir, archive.path)}.verified`, archive.sha256);
    const manager = new ModelManager(() => dir, fakeFetch(Buffer.alloc(0)));
    expect(manager.isReady('whisper-runtime')).toBe(true);
  });

  it('downloads again if the extracted files went missing', async () => {
    mkdirSync(dirname(join(dir, archive.path)), { recursive: true });
    writeFileSync(`${join(dir, archive.path)}.verified`, archive.sha256);
    const fetchSpy = fakeFetch(Buffer.alloc(3));
    const manager = new ModelManager(() => dir, fetchSpy);
    expect(manager.isReady('whisper-runtime')).toBe(false);
    expect(await manager.install('whisper-runtime')).toBe(false); // the fake serves a bad zip
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(`${join(dir, archive.path)}.verified`)).toBe(false);
  });
});
