import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScrubbedText } from '../privacy/guard';

/** Every string field is `ScrubbedText`, so nothing sensitive can be written to disk by mistake. */
export type LogEntry =
  | { type: 'command'; requestId: string; source: string; text: ScrubbedText }
  | { type: 'route'; requestId: string; route: 'instant' | 'llm' }
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
  | { type: 'error'; requestId: string; text: ScrubbedText };

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

  write(entry: LogEntry | OutboundEntry): void {
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      appendFileSync(join(this.dir, `${this.prefix}-${day}.jsonl`), `${line}\n`, 'utf8');
    } catch {
      // Logging must never break the assistant.
    }
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
