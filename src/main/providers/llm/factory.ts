import type { Settings } from '@shared/settings';
import type { SecretVault } from '../../secrets/vault';
import type { RoutedProvider } from '../../router/router';
import { GeminiProvider } from './gemini';
import { GroqProvider } from './groq';
import type { LlmProvider, ProviderId } from './types';

/**
 * Builds the router's provider list from current settings and saved keys. Instances are cached
 * and rebuilt only when a key or model changes.
 */
export function createProviderSource(
  settings: () => Settings,
  vault: SecretVault,
): () => RoutedProvider[] {
  const cache = new Map<ProviderId, { signature: string; provider: LlmProvider }>();

  return () => {
    const { llm } = settings();
    const out: RoutedProvider[] = [];
    for (const id of llm.order) {
      const key = vault.get(id);
      if (!key) continue;
      const { model, dailyLimit } = llm[id];
      const signature = `${model}:${key}`;
      let entry = cache.get(id);
      if (!entry || entry.signature !== signature) {
        const provider =
          id === 'gemini' ? new GeminiProvider(key, model) : new GroqProvider(key, model);
        entry = { signature, provider };
        cache.set(id, entry);
      }
      out.push({ provider: entry.provider, dailyLimit });
    }
    return out;
  };
}
