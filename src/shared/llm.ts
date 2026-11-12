/** A place in the router's list: a provider, or its backup model ("gemini-backup"). */
export type ProviderSlot = 'gemini' | 'gemini-backup' | 'groq';

export interface ProviderUsage {
  slot: ProviderSlot;
  /** "Gemini", "Gemini (backup)", "Groq". */
  label: string;
  model: string;
  /** An API key is saved for this provider. */
  configured: boolean;
  /** Requests today (resets at midnight Pacific, like the free tiers). */
  used: number;
  limit: number;
  /** Temporarily skipped after an error. */
  coolingDown: boolean;
  /** Why: rate-limited, key rejected, or busy/unreachable. */
  coolingReason: 'rate_limit' | 'auth' | 'busy' | null;
}

/** Settings → "Test" next to an API key. */
export interface KeyTestResult {
  ok: boolean;
  /** "Works: gemini-3.5-flash-lite answered in 0.8 s" or what went wrong and what to do. */
  message: string;
}
