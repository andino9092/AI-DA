import { detectSensitive, type DetectOptions, type Finding, type SensitiveKind } from './detectors';

declare const scrubbedBrand: unique symbol;

/**
 * Text that has been through the Privacy Guard. Providers only accept this type, so sending raw
 * text off the PC is a compile error. Only this module may create it; an ESLint rule forbids
 * `as ScrubbedText` anywhere else.
 */
export type ScrubbedText = string & { readonly [scrubbedBrand]: true };

const PLACEHOLDER_PATTERN = /\[([A-Z_]+)_(\d+)\]/g;

/**
 * Remembers which placeholder stands for which value during one conversation, so the same card
 * number is always `[CARD_1]` and tool arguments can be filled back in locally.
 */
export class PlaceholderSession {
  private readonly byKey = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<SensitiveKind, number>();

  placeholderFor(finding: Finding): string {
    const key = `${finding.kind}:${finding.value.replace(/[\s-]/g, '').toLowerCase()}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const n = (this.counters.get(finding.kind) ?? 0) + 1;
    this.counters.set(finding.kind, n);
    const placeholder = `[${finding.kind}_${n}]`;
    this.byKey.set(key, placeholder);
    this.byPlaceholder.set(placeholder, finding.value);
    return placeholder;
  }

  valueOf(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  get size(): number {
    return this.byPlaceholder.size;
  }
}

export interface ScrubResult {
  text: ScrubbedText;
  findings: { kind: SensitiveKind; placeholder: string }[];
}

export interface RehydrateResult<T> {
  value: T;
  /** True when at least one real sensitive value was put back in; callers must confirm first. */
  usedSensitive: boolean;
}

export class PrivacyGuard {
  constructor(private readonly options: () => DetectOptions) {}

  /** Static text written by us (system prompt, tool descriptions). Never user or screen data. */
  static constant(text: string): ScrubbedText {
    return text as ScrubbedText;
  }

  /**
   * overrides: stricter rules for one call, e.g. always masking emails and phone numbers in text
   * read off the screen (the setting exists for commands you say, like "email John").
   */
  scrub(
    text: string,
    session: PlaceholderSession,
    overrides: Partial<DetectOptions> = {},
  ): ScrubResult {
    const found = detectSensitive(text, { ...this.options(), ...overrides });
    if (found.length === 0) return { text: text as ScrubbedText, findings: [] };

    let out = '';
    let last = 0;
    const findings: ScrubResult['findings'] = [];
    for (const f of found) {
      const placeholder = session.placeholderFor(f);
      out += text.slice(last, f.start) + placeholder;
      last = f.end;
      findings.push({ kind: f.kind, placeholder });
    }
    return { text: (out + text.slice(last)) as ScrubbedText, findings };
  }

  /** Scrubs every string inside a JSON-like value (tool results) and serialises it. */
  scrubJson(
    value: unknown,
    session: PlaceholderSession,
    overrides: Partial<DetectOptions> = {},
  ): ScrubbedText {
    return this.scrub(JSON.stringify(value), session, overrides).text;
  }

  /** Puts real values back into placeholder tokens in tool arguments, for local use only. */
  rehydrate<T>(value: T, session: PlaceholderSession): RehydrateResult<T> {
    let usedSensitive = false;
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') {
        return v.replace(PLACEHOLDER_PATTERN, (token) => {
          const real = session.valueOf(token);
          if (real === undefined) return token;
          usedSensitive = true;
          return real;
        });
      }
      if (Array.isArray(v)) return v.map(visit);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, visit(inner)]));
      }
      return v;
    };
    return { value: visit(value) as T, usedSensitive };
  }
}
