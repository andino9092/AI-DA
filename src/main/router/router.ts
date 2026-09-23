import type { JsonlLog } from '../safety/action-log';
import {
  ProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ProviderId,
} from '../providers/llm/types';
import type { QuotaTracker } from './quota';

export interface RoutedProvider {
  provider: LlmProvider;
  dailyLimit: number;
}

export class NoProviderError extends Error {}

const DEFAULT_COOL_DOWN_MS = 60_000;
const AUTH_COOL_DOWN_MS = 10 * 60_000;

/**
 * The only way out to an AI provider. Tries providers in priority order, skipping any that are
 * over their daily free quota or cooling down after a 429, and falls through on failures.
 * Every request is written to the outbound log exactly as sent (it is already scrubbed).
 */
export class LlmRouter {
  constructor(
    private readonly providers: () => RoutedProvider[],
    private readonly quota: QuotaTracker,
    private readonly outbound: JsonlLog,
  ) {}

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

    const failures: string[] = [];
    for (const { provider, dailyLimit } of candidates) {
      if (this.quota.isCoolingDown(provider.id)) {
        failures.push(`${provider.id} is rate-limited`);
        continue;
      }
      if (this.quota.used(provider.id) >= dailyLimit) {
        failures.push(`${provider.id} used today's free quota`);
        continue;
      }

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

      try {
        this.quota.record(provider.id);
        const response = await provider.complete(request, signal);
        return { ...response, provider: provider.id };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.kind === 'aborted') throw err;
        if (err.kind === 'rate_limit')
          this.quota.coolDown(provider.id, err.retryAfterMs ?? DEFAULT_COOL_DOWN_MS);
        if (err.kind === 'auth') this.quota.coolDown(provider.id, AUTH_COOL_DOWN_MS);
        failures.push(err.kind === 'auth' ? `${provider.id} rejected the API key` : err.message);
      }
    }
    throw new NoProviderError(`I couldn't reach an AI provider (${failures.join('; ')}).`);
  }
}
