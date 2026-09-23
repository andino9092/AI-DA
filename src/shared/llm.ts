export interface ProviderUsage {
  provider: 'gemini' | 'groq';
  /** An API key is saved for this provider. */
  configured: boolean;
  /** Requests today (resets at midnight Pacific, like the free tiers). */
  used: number;
  limit: number;
  /** Temporarily skipped after a rate-limit error. */
  coolingDown: boolean;
}
