import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { WindowsBridge } from '../native/win-host';

type AudioBridge = Pick<WindowsBridge, 'appAudio' | 'setAppAudio'>;

interface Saved {
  /** Level before ducking. */
  original: number;
  /** Level we set; if it's still this when restoring, the user didn't touch it meanwhile. */
  ducked: number;
}

/**
 * Lowers other apps (music, videos) while Aida listens or talks, then puts them back. Windows
 * remembers per-app volume across restarts, so the original levels are also written to a small
 * file and restored on the next start if AI-DA quit while sounds were lowered.
 */
export class Ducker {
  private saved = new Map<string, Saved>();
  private ducked = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly win: AudioBridge,
    private readonly options: {
      enabled: () => boolean;
      /** Our own process name ("electron" in development, "AI-DA" installed). */
      ownProcess: string;
      stateFile: string;
      /** Ducked level as a fraction of the original. */
      factor?: number;
    },
  ) {}

  /** Something is lowered (or waiting to be put back). */
  get pending(): boolean {
    return this.ducked || this.saved.size > 0;
  }

  set(on: boolean): Promise<void> {
    this.chain = this.chain
      .then(() => (on ? this.duck() : this.restore()))
      .catch((err: unknown) => console.error('[AI-DA] ducking:', err));
    return this.chain;
  }

  /** Puts back levels left lowered by a previous run that didn't get to restore them. */
  recover(): Promise<void> {
    const { stateFile } = this.options;
    if (!existsSync(stateFile)) return Promise.resolve();
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, Saved>;
      this.saved = new Map(Object.entries(saved));
      this.ducked = true;
    } catch {
      rmSync(stateFile, { force: true });
      return Promise.resolve();
    }
    return this.set(false);
  }

  private async duck(): Promise<void> {
    if (this.ducked || !this.options.enabled()) return;
    this.ducked = true;
    const factor = this.options.factor ?? 0.3;
    const own = this.options.ownProcess.toLowerCase();
    const apps = await this.win.appAudio();
    for (const app of apps) {
      if (app.process.toLowerCase() === own || app.muted || app.level <= 5) continue;
      // Still waiting to be restored from an earlier duck: keep its real original level.
      if (!this.saved.has(app.process))
        this.saved.set(app.process, {
          original: app.level,
          ducked: Math.round(app.level * factor),
        });
    }
    this.persist();
    for (const app of apps) {
      const s = this.saved.get(app.process);
      if (s) await this.win.setAppAudio(app.process, { level: s.ducked }).catch(() => {});
    }
  }

  private async restore(): Promise<void> {
    if (!this.ducked && this.saved.size === 0) return;
    this.ducked = false;
    const current = await this.win.appAudio().catch(() => []);
    for (const [process, s] of this.saved) {
      const now = current.find((a) => a.process === process);
      // Not running right now: keep it, and put it back next time.
      if (!now) continue;
      // Changed by the user meanwhile: leave their choice alone.
      if (Math.abs(now.level - s.ducked) <= 1)
        await this.win.setAppAudio(process, { level: s.original }).catch(() => {});
      this.saved.delete(process);
    }
    this.persist();
  }

  private persist(): void {
    const { stateFile } = this.options;
    try {
      if (this.saved.size === 0) rmSync(stateFile, { force: true });
      else writeFileSync(stateFile, JSON.stringify(Object.fromEntries(this.saved)));
    } catch {
      // Best effort: worst case a lowered app stays lowered.
    }
  }
}
