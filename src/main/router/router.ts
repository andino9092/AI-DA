import type { JsonlLog } from '../safety/action-log';
import {
  ProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ProviderErrorKind,
  type ProviderId,
} from '../providers/llm/types';
import type { ProviderSlot } from '@shared/llm';
import type { Trace } from '../trace/tracer';
import type { QuotaTracker } from './quota';

export interface RoutedProvider {
  provider: LlmProvider;
  dailyLimit: number;
  /** Quota and cool-down bucket; defaults to the provider id. A backup model has its own. */
  slot?: ProviderSlot;
  /** Name used when explaining failures, e.g. "Gemini (backup)". */
  label?: string;
}

export class NoProviderError extends Error {
  constructor(
    message: string,
    /** The providers' own error messages, for the action log. */
    readonly detail = '',
  ) {
    super(message);
  }
}

const DEFAULT_COOL_DOWN_MS = 60_000;
const AUTH_COOL_DOWN_MS = 10 * 60_000;
/** After "overloaded" or no answer, try other providers first for a little while. */
const BUSY_COOL_DOWN_MS = 30_000;
/** One provider gets this long to answer before the next one is tried. */
const ATTEMPT_TIMEOUT_MS = 10_000;
/** Don't start another attempt after this long: an answer would come too late to be useful. */
const TOTAL_BUDGET_MS = 22_000;
/** A quick second try after "overloaded" (503) often works. */
const RETRY_DELAY_MS = 700;

const NAMES: Record<ProviderId, string> = { gemini: 'Gemini', groq: 'Groq' };

type FailureKind = ProviderErrorKind | 'timeout' | 'quota';

interface Failure {
  slot: ProviderSlot;
  label: string;
  kind: FailureKind;
  message: string;
}

/** Short, spoken-friendly reason per provider, e.g. "Gemini is busy right now". */
export function explainFailures(failures: Pick<Failure, 'label' | 'kind'>[]): string {
  const reasons = failures.map(({ label: name, kind }) => {
    switch (kind) {
      case 'timeout':
        return `${name} took too long to answer`;
      case 'unavailable':
        return `${name} is busy or unreachable right now`;
      case 'auth':
        return `${name} rejected its API key (use Test in Settings)`;
      case 'rate_limit':
        return `${name} is rate-limited for a minute`;
      case 'quota':
        return `${name} used today's free requests`;
      default:
        return `${name} couldn't handle that request`;
    }
  });
  return `I couldn't get an answer from the AI: ${reasons.join(', and ')}. Local commands like volume, music, apps and timers still work.`;
}

/**
 * The only way out to an AI provider. Tries providers in priority order, skipping any over their
 * daily free quota or cooling down, gives each a time limit, retries once when a provider says
 * it's overloaded, and as a last resort retries providers that were recently busy. Every request
 * is written to the outbound log exactly as sent (it is already scrubbed).
 */
export class LlmRouter {
  constructor(
    private readonly providers: () => RoutedProvider[],
    private readonly quota: QuotaTracker,
    private readonly outbound: JsonlLog,
    /** Told whether providers answered, for the offline indicator. */
    private readonly health?: { reached(): void; unreachable(): void },
    private readonly options: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      attemptTimeoutMs?: number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  async complete(
    request: LlmRequest,
    requestId: string,
    signal: AbortSignal,
    /** Every attempt, answered or not, is timed into this trace. */
    trace?: Trace,
  ): Promise<LlmResponse & { provider: ProviderId }> {
    const candidates = this.providers();
    if (candidates.length === 0) {
      throw new NoProviderError(
        'No AI provider is set up yet. Add a free Gemini or Groq key in Settings.',
      );
    }

    const started = this.now();
    const failures: Failure[] = [];
    type Entry = { provider: LlmProvider; slot: ProviderSlot; label: string };
    const ready: Entry[] = [];
    const busy: Entry[] = [];
    for (const routed of candidates) {
      const entry: Entry = {
        provider: routed.provider,
        slot: routed.slot ?? routed.provider.id,
        label: routed.label ?? NAMES[routed.provider.id],
      };
      const { slot, label } = entry;
      const cooling = this.quota.coolingReason(slot);
      if (this.quota.used(slot) >= routed.dailyLimit)
        failures.push({ slot, label, kind: 'quota', message: 'daily limit reached' });
      else if (cooling === 'busy') busy.push(entry);
      else if (cooling)
        failures.push({ slot, label, kind: cooling, message: `cooling down (${cooling})` });
      else ready.push(entry);
    }

    // Busy providers go last: better a slow answer than none.
    const order = [...ready, ...busy];
    /** Providers whose key was just rejected: their other models would be rejected too. */
    const rejected = new Set<ProviderId>();
    for (const [index, { provider, slot, label }] of order.entries()) {
      if (rejected.has(provider.id)) continue;
      // A backup model of the same provider is next in line: it answers faster than a retry.
      const backupNext = order[index + 1]?.provider.id === provider.id;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (this.now() - started > TOTAL_BUDGET_MS) break;
        try {
          const call = () => this.attempt(provider, label, slot, request, requestId, signal);
          const response = trace
            ? await trace.time<LlmResponse>(
                (answer, err) => ({
                  name: 'llm',
                  provider: provider.id,
                  model: provider.model,
                  toolsOffered: request.tools.length,
                  ...(answer?.usage ?? {}),
                  ...(err
                    ? {
                        error:
                          err instanceof ProviderError
                            ? err.message.endsWith('(timed out)')
                              ? 'timeout'
                              : err.kind
                            : 'error',
                      }
                    : {}),
                }),
                call,
              )
            : await call();
          this.quota.clear(slot);
          this.health?.reached();
          return { ...response, provider: provider.id };
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          if (err.kind === 'aborted') throw err;
          const timedOut = err.message.endsWith('(timed out)');
          failures.push({
            slot,
            label,
            kind: timedOut ? 'timeout' : err.kind,
            message: err.message,
          });
          if (err.kind === 'rate_limit')
            this.quota.coolDown(slot, err.retryAfterMs ?? DEFAULT_COOL_DOWN_MS, 'rate_limit');
          // A rejected key is rejected for every model of that provider.
          if (err.kind === 'auth') {
            rejected.add(provider.id);
            for (const other of order)
              if (other.provider.id === provider.id)
                this.quota.coolDown(other.slot, AUTH_COOL_DOWN_MS, 'auth');
          }
          if (err.kind === 'unavailable') this.quota.coolDown(slot, BUSY_COOL_DOWN_MS, 'busy');
          // "Overloaded, try again" answers come back fast; a quick retry often gets through.
          const overloaded = err.kind === 'unavailable' && !timedOut && err.status === 503;
          if (!overloaded || attempt === 2 || backupNext) break;
          await this.sleep(RETRY_DELAY_MS);
        }
      }
    }

    const tried = failures.filter((f) => f.kind !== 'quota' && !f.message.startsWith('cooling'));
    if (tried.length > 0 && tried.every((f) => f.kind === 'unavailable' || f.kind === 'timeout'))
      this.health?.unreachable();
    // One line per provider in the message (the last failure is the one that counts).
    const last = new Map(failures.map((f) => [f.slot, f]));
    throw new NoProviderError(
      explainFailures([...last.values()]),
      failures.map((f) => `${f.slot}: ${f.message}`).join(' | '),
    );
  }

  private async attempt(
    provider: LlmProvider,
    label: string,
    slot: ProviderSlot,
    request: LlmRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<LlmResponse> {
    this.outbound.write({
      type: 'outbound',
      requestId,
      provider: provider.id,
      model: provider.model,
      system: request.system,
      // Provider-specific replay data (e.g. Gemini thought signatures) is model output, not ours.
      messages: request.messages.map((m) =>
        m.role === 'assistant' ? { ...m, raw: undefined } : m,
      ),
      tools: request.tools.map((t) => t.name),
    });
    this.quota.record(slot);
    const timeout = AbortSignal.timeout(this.options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
    try {
      return await provider.complete(request, AbortSignal.any([signal, timeout]));
    } catch (err) {
      // Our time limit, not the user cancelling: treat it like "no answer".
      if (err instanceof ProviderError && err.kind === 'aborted' && !signal.aborted)
        throw new ProviderError('unavailable', `${label}: no answer (timed out)`);
      throw err;
    }
  }
}

/**
 * Settings → "Test": sends one tiny request (no personal data) with a saved key and explains the
 * result in plain words.
 */
export async function testProvider(
  provider: LlmProvider,
  request: LlmRequest,
  outbound: JsonlLog,
): Promise<{ ok: boolean; message: string }> {
  const name = NAMES[provider.id];
  outbound.write({
    type: 'outbound',
    requestId: 'key-test',
    provider: provider.id,
    model: provider.model,
    system: request.system,
    messages: request.messages,
    tools: [],
  });
  const started = Date.now();
  try {
    await provider.complete(request, AbortSignal.timeout(15_000));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    return { ok: true, message: `Works: ${provider.model} answered in ${seconds} s.` };
  } catch (err) {
    if (!(err instanceof ProviderError))
      return { ok: false, message: `${name} failed: ${String(err)}` };
    const detail = err.message.replace(/^\w+:\s*/, '');
    switch (err.kind) {
      case 'auth':
        return {
          ok: false,
          message:
            err.status === 403
              ? `${name} refused access (403): ${detail}. The key may not be allowed to use ${provider.model}.`
              : `${name} says the key is invalid (401). Copy a fresh key and save it again.`,
        };
      case 'bad_request':
        return {
          ok: false,
          message: /model/i.test(detail)
            ? `${name} doesn't offer the model “${provider.model}” to this key: ${detail}`
            : `${name} rejected the request: ${detail}`,
        };
      case 'rate_limit':
        return { ok: false, message: `The key works, but ${name} is rate-limiting it right now.` };
      case 'aborted':
        return { ok: false, message: `${name} didn't answer within 15 seconds. Try again later.` };
      default:
        return {
          ok: false,
          message: `${name} is busy or unreachable right now (${detail}). The key itself may be fine.`,
        };
    }
  }
}
