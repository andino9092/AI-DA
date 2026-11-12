import type { ProviderSlot } from '@shared/llm';
import type { Settings } from '@shared/settings';
import type { SecretVault } from '../../secrets/vault';
import type { RoutedProvider } from '../../router/router';
import { GeminiProvider } from './gemini';
import { GroqProvider } from './groq';
import type { LlmProvider, ProviderId } from './types';

/** One provider instance for a key and model. */
export function buildProvider(id: ProviderId, key: string, model: string): LlmProvider {
  return id === 'gemini' ? new GeminiProvider(key, model) : new GroqProvider(key, model);
}

/** Every router slot the settings describe, in order, with its model and limit. */
export function providerSlots(
  llm: Settings['llm'],
): { slot: ProviderSlot; id: ProviderId; label: string; model: string; dailyLimit: number }[] {
  const out: ReturnType<typeof providerSlots> = [];
  for (const id of llm.order) {
    if (id === 'gemini') {
      const { model, dailyLimit, backupModel, backupDailyLimit } = llm.gemini;
      out.push({ slot: 'gemini', id, label: 'Gemini', model, dailyLimit });
      // Right after the main model: a different model is rarely overloaded at the same moment.
      if (backupModel && backupModel !== model)
        out.push({
          slot: 'gemini-backup',
          id,
          label: 'Gemini (backup)',
          model: backupModel,
          dailyLimit: backupDailyLimit,
        });
    } else {
      out.push({ slot: id, id, label: 'Groq', ...llm.groq });
    }
  }
  return out;
}

/**
 * Builds the router's provider list from current settings and saved keys. Instances are cached
 * and rebuilt only when a key or model changes.
 */
export function createProviderSource(
  settings: () => Settings,
  vault: SecretVault,
): () => RoutedProvider[] {
  const cache = new Map<ProviderSlot, { signature: string; provider: LlmProvider }>();

  return () => {
    const out: RoutedProvider[] = [];
    for (const { slot, id, label, model, dailyLimit } of providerSlots(settings().llm)) {
      const key = vault.get(id);
      if (!key) continue;
      const signature = `${model}:${key}`;
      let entry = cache.get(slot);
      if (!entry || entry.signature !== signature) {
        entry = { signature, provider: buildProvider(id, key, model) };
        cache.set(slot, entry);
      }
      out.push({ provider: entry.provider, dailyLimit, slot, label });
    }
    return out;
  };
}
