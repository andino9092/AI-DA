import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ModelStatus } from '@shared/models';
import { MODELS, type ModelFile, type ModelId, type ModelSpec } from './manifest';

const execFileAsync = promisify(execFile);

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

type Events = { changed: [status: ModelStatus[]] };

/**
 * Downloads, verifies (size + SHA-256) and unpacks models into the models folder. A file only
 * counts as installed once its hash matched; a `.verified` marker avoids re-hashing big files
 * on every start.
 */
export class ModelManager extends EventEmitter<Events> {
  private readonly progress = new Map<ModelId, { received: number; total: number }>();
  private readonly errors = new Map<ModelId, string>();
  private readonly active = new Map<ModelId, AbortController>();

  constructor(
    private readonly root: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  path(relative: string): string {
    return join(this.root(), relative);
  }

  isReady(id: ModelId): boolean {
    const spec = this.spec(id);
    return existsSync(this.path(spec.readyCheck)) && spec.files.every((f) => this.isVerified(f));
  }

  status(): ModelStatus[] {
    return MODELS.map((m) => {
      const progress = this.progress.get(m.id);
      const error = this.errors.get(m.id);
      const bytes = m.files.reduce((sum, f) => sum + f.size, 0);
      const state = this.active.has(m.id)
        ? 'downloading'
        : this.isReady(m.id)
          ? 'ready'
          : error
            ? 'error'
            : 'missing';
      return {
        id: m.id,
        label: m.label,
        purpose: m.purpose,
        bytes,
        state,
        received: progress?.received ?? 0,
        error: state === 'error' ? error : undefined,
      };
    });
  }

  /** Installs every missing model, one at a time (smallest first so something works sooner). */
  async installAll(): Promise<void> {
    const missing = MODELS.filter((m) => !this.isReady(m.id)).sort(
      (a, b) => a.files.reduce((s, f) => s + f.size, 0) - b.files.reduce((s, f) => s + f.size, 0),
    );
    for (const m of missing) await this.install(m.id);
  }

  async install(id: ModelId): Promise<boolean> {
    if (this.active.has(id)) return false;
    const spec = this.spec(id);
    const controller = new AbortController();
    this.active.set(id, controller);
    this.errors.delete(id);
    const total = spec.files.reduce((s, f) => s + f.size, 0);
    this.progress.set(id, { received: 0, total });
    this.changed();

    try {
      // If an unpacked archive went missing, forget that it was verified so it downloads again.
      if (!existsSync(this.path(spec.readyCheck))) {
        for (const f of spec.files) if (f.extractTo) rmSync(this.markerPath(f), { force: true });
      }
      let done = 0;
      for (const file of spec.files) {
        await this.ensureFile(file, controller.signal, (n) => {
          this.progress.set(id, { received: done + n, total });
          this.changedThrottled();
        });
        done += file.size;
        if (file.extractTo && existsSync(this.path(file.path))) await this.extract(file);
      }
      if (!existsSync(this.path(spec.readyCheck))) {
        throw new Error(`Installed, but ${spec.readyCheck} is missing.`);
      }
      return true;
    } catch (err) {
      this.errors.set(
        id,
        controller.signal.aborted ? 'Cancelled.' : err instanceof Error ? err.message : String(err),
      );
      return false;
    } finally {
      this.active.delete(id);
      this.progress.delete(id);
      this.changed();
    }
  }

  cancelAll(): void {
    for (const c of this.active.values()) c.abort();
  }

  private spec(id: ModelId): ModelSpec {
    const spec = MODELS.find((m) => m.id === id);
    if (!spec) throw new Error(`Unknown model ${id}`);
    return spec;
  }

  private markerPath(file: ModelFile): string {
    return `${this.path(file.path)}.verified`;
  }

  private isVerified(file: ModelFile): boolean {
    const target = this.path(file.path);
    if (!existsSync(this.markerPath(file))) return false;
    try {
      if (readFileSync(this.markerPath(file), 'utf8').trim() !== file.sha256) return false;
      // Archives are deleted once extracted; the marker records that they were verified.
      if (file.extractTo) return true;
      return existsSync(target) && statSync(target).size === file.size;
    } catch {
      return false;
    }
  }

  /** Uses an existing file if its hash matches, otherwise downloads it. */
  private async ensureFile(
    file: ModelFile,
    signal: AbortSignal,
    onBytes: (n: number) => void,
  ): Promise<void> {
    const target = this.path(file.path);
    if (this.isVerified(file)) {
      onBytes(file.size);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (
      existsSync(target) &&
      statSync(target).size === file.size &&
      (await sha256File(target)) === file.sha256
    ) {
      writeFileSync(this.markerPath(file), file.sha256);
      onBytes(file.size);
      return;
    }

    const partial = `${target}.part`;
    const response = await this.fetchImpl(file.url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body)
      throw new Error(`Download failed (${response.status}) for ${file.path}.`);

    const hash = createHash('sha256');
    let received = 0;
    const body = Readable.fromWeb(response.body as WebReadableStream);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      onBytes(received);
    });
    await pipeline(body, createWriteStream(partial), { signal });

    const digest = hash.digest('hex');
    if (received !== file.size || digest !== file.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`${file.path} failed its integrity check, so it was deleted.`);
    }
    renameSync(partial, target);
    writeFileSync(this.markerPath(file), file.sha256);
  }

  /** Windows 10+ ships bsdtar, which extracts zip files. */
  private async extract(file: ModelFile): Promise<void> {
    if (!file.extractTo) return;
    const dest = this.path(file.extractTo);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // Always Windows' own bsdtar: a GNU tar earlier on PATH (e.g. from Git) can't read zips.
    const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    await execFileAsync(tar, ['-xf', this.path(file.path), '-C', dest], { windowsHide: true });
    rmSync(this.path(file.path), { force: true });
  }

  private changed(): void {
    this.emit('changed', this.status());
  }

  private lastEmit = 0;
  private changedThrottled(): void {
    const now = Date.now();
    if (now - this.lastEmit > 250) {
      this.lastEmit = now;
      this.changed();
    }
  }
}
