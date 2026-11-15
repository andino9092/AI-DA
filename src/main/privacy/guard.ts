import { detectSensitive, type DetectOptions, type Finding, type SensitiveKind } from './detectors';

declare const scrubbedBrand: unique symbol;

/**
 * Text that has been through the Privacy Guard. Providers only accept this type, so sending raw
 * text off the PC is a compile error. Only this module may create it; an ESLint rule forbids
 * `as ScrubbedText` anywhere else.
 */
export type ScrubbedText = string & { readonly [scrubbedBrand]: true };

const PLACEHOLDER_PATTERN = /\[([A-Z_]+)_(\d+)\]/g;

/** Shorter values (a CVV, a PIN) are too likely to match ordinary text by accident. */
const MIN_LOOSE_LENGTH = 6;

/**
 * Finds a value whatever its case, spacing or dashes: the same differences the placeholder
 * session ignores when it decides two values are the same one. Not inside a longer word or
 * number, and not inside a placeholder.
 */
function loosePattern(value: string): RegExp | null {
  const chars = Array.from(value.replace(/[\s-]/g, ''));
  if (chars.length < MIN_LOOSE_LENGTH) return null;
  const body = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]*');
  return new RegExp(`(?<![A-Za-z0-9[])${body}(?![A-Za-z0-9_\\]])`, 'gi');
}

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

  /** Every value seen so far with its placeholder, longest first. */
  entries(): { placeholder: string; value: string }[] {
    return [...this.byPlaceholder.entries()]
      .map(([placeholder, value]) => ({ placeholder, value }))
      .sort((a, b) => b.value.length - a.value.length);
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

  /** Joining scrubbed pieces keeps them scrubbed. */
  static join(...parts: ScrubbedText[]): ScrubbedText {
    return parts.join('') as ScrubbedText;
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
    if (found.length === 0)
      return { text: this.maskKnown(text, session) as ScrubbedText, findings: [] };

    let out = '';
    let last = 0;
    const findings: ScrubResult['findings'] = [];
    for (const f of found) {
      const placeholder = session.placeholderFor(f);
      out += text.slice(last, f.start) + placeholder;
      last = f.end;
      findings.push({ kind: f.kind, placeholder });
    }
    return { text: this.maskKnown(out + text.slice(last), session) as ScrubbedText, findings };
  }

  /**
   * Masks values this conversation has already marked sensitive, however they are written now.
   * Detectors look at the original text: some need its case (API keys, IBANs) or the words
   * around a value. Once a value has been lower-cased by the command parser, or repeated by a
   * tool in its reply ("I couldn't find an app called akia…"), they no longer recognise it.
   */
  private maskKnown(text: string, session: PlaceholderSession): string {
    let out = text;
    for (const { placeholder, value } of session.entries()) {
      const pattern = loosePattern(value);
      if (pattern) out = out.replace(pattern, placeholder);
    }
    return out;
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
