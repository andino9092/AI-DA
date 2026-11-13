import { randomUUID } from 'node:crypto';

/**
 * One timed stage of a request. Spans hold numbers and names only (durations, counts, tool and
 * model names), never the text of a command or a reply, so a trace needs no scrubbing.
 */
export type Span =
  /** Speech to text. reused: the transcript was started during a pause and was already under way. */
  | { name: 'stt'; audioSeconds: number; reused: boolean }
  /** One request to an AI provider, answered or not. */
  | {
      name: 'llm';
      provider: string;
      model: string;
      toolsOffered: number;
      inputTokens?: number;
      outputTokens?: number;
      /** Why it failed (rate_limit, unavailable, timeout…); absent when it answered. */
      error?: string;
    }
  | { name: 'tool'; tool: string; ok: boolean }
  /** Waiting for the user to answer a confirmation: time that isn't AI-DA's. */
  | { name: 'confirm'; approved: boolean }
  /** From the reply being ready to the first audio handed to the speakers. */
  | { name: 'tts' };

export type TimedSpan = Span & {
  /** When the span started, in ms after the trace started. */
  at: number;
  ms: number;
};

export type TraceRoute = 'instant' | 'llm' | 'routine';

/** One line of the traces log: a whole request. */
export interface TraceEntry {
  type: 'trace';
  /** The same id as the request's lines in the action and outbound logs. */
  requestId: string;
  source: string;
  route: TraceRoute | null;
  ok: boolean;
  /** Start to end, including time spent waiting for confirmations. */
  totalMs: number;
  spans: TimedSpan[];
}

/**
 * The record of one request being built up. Whoever starts a trace ends it: the voice loop for
 * spoken commands (after the first audio), the assistant for typed ones.
 */
export class Trace {
  readonly id = randomUUID();
  private readonly spans: TimedSpan[] = [];
  private readonly startedAt: number;
  private route: TraceRoute | null = null;
  private ok = true;
  private ended = false;

  constructor(
    private readonly source: string,
    private readonly sink: (entry: TraceEntry) => void,
    private readonly now: () => number,
    /** For work that began before the trace existed (transcription): how long ago it started. */
    backdateMs = 0,
  ) {
    this.startedAt = now() - backdateMs;
  }

  /** Records a stage that has just finished and took `ms`. */
  add(span: Span, ms: number): void {
    if (this.ended) return;
    const end = this.now() - this.startedAt;
    this.spans.push({ ...span, at: Math.max(0, Math.round(end - ms)), ms: Math.round(ms) });
  }

  /** Times a stage. describe() turns its result (or failure) into the span. */
  async time<T>(describe: (result: T | undefined, error: unknown) => Span, run: () => Promise<T>) {
    const started = this.now();
    try {
      const result = await run();
      this.add(describe(result, undefined), this.now() - started);
      return result;
    } catch (err) {
      this.add(describe(undefined, err), this.now() - started);
      throw err;
    }
  }

  /** The first route counts: a routine stays a routine whatever its steps do. */
  routed(route: TraceRoute): void {
    this.route ??= route;
  }

  outcome(ok: boolean): void {
    this.ok = ok;
  }

  /** Writes the trace. Later calls and later spans are ignored. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.sink({
      type: 'trace',
      requestId: this.id,
      source: this.source,
      route: this.route,
      ok: this.ok,
      totalMs: Math.round(this.now() - this.startedAt),
      spans: this.spans,
    });
  }
}

export class Tracer {
  constructor(
    private readonly sink: (entry: TraceEntry) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(source: string, backdateMs = 0): Trace {
    return new Trace(source, this.sink, this.now, backdateMs);
  }
}
