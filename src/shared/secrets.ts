/** Every secret AI-DA knows about. Adding a provider means adding it here first. */
export const SECRET_NAMES = ['gemini', 'groq'] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Sign-in tokens AI-DA saves for itself (Spotify). Encrypted like keys, but never listed, typed
 * or read back through IPC.
 */
export const TOKEN_NAMES = ['spotify'] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

export interface SecretStatus {
  name: SecretName;
  configured: boolean;
  /** Last four characters, for recognising which key is saved. Never the full value. */
  hint: string | null;
}

export interface SecretsSnapshot {
  encryptionAvailable: boolean;
  items: SecretStatus[];
}

export const SECRET_INFO: Record<
  SecretName,
  { label: string; purpose: string; getKeyUrl: string }
> = {
  gemini: {
    label: 'Google Gemini',
    purpose: 'Main brain (Gemini Flash-Lite, free tier).',
    getKeyUrl: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq',
    purpose: 'Backup brain when Gemini is unavailable (free tier).',
    getKeyUrl: 'https://console.groq.com/keys',
  },
};
