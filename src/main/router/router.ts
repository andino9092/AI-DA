import type { JsonlLog } from '../safety/action-log';
import {
  ProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ProviderErrorKind,
  type ProviderId,
} from '../providers/llm/types';
import type { QuotaTracker } from './quota';

export interface RoutedProvider {
  provider: LlmProvider;
  dailyLimit: number;
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
  provider: ProviderId;
  kind: FailureKind;
  message: string;
}

/** Short, spoken-friendly reason per provider, e.g. "Gemini is busy right now". */
export function explainFailures(failures: Failure[]): string {
  const reasons = failures.map(({ provider, kind }) => {
    const name = NAMES[provider];
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
  ): Promise<LlmResponse & { provider: ProviderId }> {
    const candidates = this.providers();
    if (candidates.length === 0) {
      throw new NoProviderError(
        'No AI provider is set up yet. Add a free Gemini or Groq key in Settings.',
      );
    }

    const started = this.now();
    const failures: Failure[] = [];
    const ready: LlmProvider[] = [];
    const busy: LlmProvider[] = [];
    for (const { provider, dailyLimit } of candidates) {
      const cooling = this.quota.coolingReason(provider.id);
      if (this.quota.used(provider.id) >= dailyLimit)
        failures.push({ provider: provider.id, kind: 'quota', message: 'daily limit reached' });
      else if (cooling === 'busy') busy.push(provider);
      else if (cooling)
        failures.push({
          provider: provider.id,
          kind: cooling,
          message: `cooling down (${cooling})`,
        });
      else ready.push(provider);
    }

    // Busy providers go last: better a slow answer than none.
    for (const provider of [...ready, ...busy]) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (this.now() - started > TOTAL_BUDGET_MS) break;
        try {
          const response = await this.attempt(provider, request, requestId, signal);
          this.quota.clear(provider.id);
          this.health?.reached();
          return { ...response, provider: provider.id };
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          if (err.kind === 'aborted') throw err;
          const timedOut = err.message.endsWith('(timed out)');
          failures.push({
            provider: provider.id,
            kind: timedOut ? 'timeout' : err.kind,
            message: err.message,
          });
          if (err.kind === 'rate_limit')
            this.quota.coolDown(
              provider.id,
              err.retryAfterMs ?? DEFAULT_COOL_DOWN_MS,
              'rate_limit',
            );
          if (err.kind === 'auth') this.quota.coolDown(provider.id, AUTH_COOL_DOWN_MS, 'auth');
          if (err.kind === 'unavailable')
            this.quota.coolDown(provider.id, BUSY_COOL_DOWN_MS, 'busy');
          // "Overloaded, try again" answers come back fast; a quick retry often gets through.
          const overloaded = err.kind === 'unavailable' && !timedOut && err.status === 503;
          if (!overloaded || attempt === 2) break;
          await this.sleep(RETRY_DELAY_MS);
        }
      }
    }

    const tried = failures.filter((f) => f.kind !== 'quota' && !f.message.startsWith('cooling'));
    if (tried.length > 0 && tried.every((f) => f.kind === 'unavailable' || f.kind === 'timeout'))
      this.health?.unreachable();
    // One line per provider in the message (the last failure is the one that counts).
    const last = new Map(failures.map((f) => [f.provider, f]));
    throw new NoProviderError(
      explainFailures([...last.values()]),
      failures.map((f) => `${f.provider}: ${f.message}`).join(' | '),
    );
  }

  private async attempt(
    provider: LlmProvider,
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
    this.quota.record(provider.id);
    const timeout = AbortSignal.timeout(this.options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
    try {
      return await provider.complete(request, AbortSignal.any([signal, timeout]));
    } catch (err) {
      // Our time limit, not the user cancelling: treat it like "no answer".
      if (err instanceof ProviderError && err.kind === 'aborted' && !signal.aborted)
        throw new ProviderError('unavailable', `${NAMES[provider.id]}: no answer (timed out)`);
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
