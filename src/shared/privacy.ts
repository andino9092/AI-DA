export interface SensitiveValueSummary {
  id: string;
  label: string;
  /** Last four characters for recognition, or null for short values. Never the full value. */
  hint: string | null;
}

export type AddSensitiveValueResult =
  { ok: true; items: SensitiveValueSummary[] } | { ok: false; error: string };
