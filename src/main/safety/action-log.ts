import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScrubbedText } from '../privacy/guard';

/** Every string field is `ScrubbedText`, so nothing sensitive can be written to disk by mistake. */
export type LogEntry =
  | { type: 'command'; requestId: string; source: string; text: ScrubbedText }
  | { type: 'route'; requestId: string; route: 'instant' | 'llm' }
  | { type: 'route'; requestId: string; route: 'routine'; text: ScrubbedText }
  | {
      type: 'tool';
      requestId: string;
      tool: string;
      summary: ScrubbedText;
      ok: boolean;
      result: ScrubbedText;
    }
  | { type: 'confirm'; requestId: string; summary: ScrubbedText; approved: boolean }
  | { type: 'reply'; requestId: string; text: ScrubbedText }
  | { type: 'error'; requestId: string; text: ScrubbedText }
  | { type: 'panic' };

export type OutboundEntry = {
  type: 'outbound';
  requestId: string;
  provider: string;
  model: string;
  system: ScrubbedText;
  messages: unknown;
  tools: string[];
};

const RETENTION_DAYS = 30;
const MAX_BACKLOG = 5000;

/**
 * Append-only JSON Lines logs, one file per day and kind (actions-YYYY-MM-DD.jsonl,
 * outbound-YYYY-MM-DD.jsonl). The outbound log is the exact text sent to AI providers, so you can
 * audit what left the PC.
 */
export class JsonlLog {
  constructor(
    private readonly dir: string,
    private readonly prefix: 'actions' | 'outbound',
  ) {
    mkdirSync(dir, { recursive: true });
    this.prune();
  }

  /** Lines that couldn't be written yet (the file was held open by another program). */
  private backlog: string[] = [];
  private warned = false;

  write(entry: LogEntry | OutboundEntry): void {
    this.backlog.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
    if (this.backlog.length > MAX_BACKLOG)
      this.backlog.splice(0, this.backlog.length - MAX_BACKLOG);
    const day = new Date().toISOString().slice(0, 10);
    const text = `${this.backlog.join('\n')}\n`;
    // A viewer (e.g. Explorer's preview pane) can hold the day's file open without letting
    // others write. Then use a second file, and keep lines in memory if that fails too.
    for (const name of [`${this.prefix}-${day}.jsonl`, `${this.prefix}-${day}-2.jsonl`]) {
      try {
        appendFileSync(join(this.dir, name), text, 'utf8');
        this.backlog = [];
        return;
      } catch (err) {
        if (!this.warned) console.error(`[AI-DA] couldn't write ${name}:`, err);
        this.warned = true;
      }
    }
    // Logging must never break the assistant; the lines are retried on the next write.
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith(`${this.prefix}-`)) continue;
      const file = join(this.dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file);
      } catch {
        // ignore
      }
    }
  }
}
