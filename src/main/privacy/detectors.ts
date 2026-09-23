import {
  digitsOnly,
  isAbaRoutingValid,
  isIbanValid,
  isLuhnValid,
  isPlausibleSsn,
  shannonEntropy,
} from './validators';

export const SENSITIVE_KINDS = [
  'CARD',
  'CVV',
  'EXPIRY',
  'SSN',
  'ROUTING',
  'IBAN',
  'SWIFT',
  'ACCOUNT',
  'PASSWORD',
  'OTP',
  'API_KEY',
  'PRIVATE_KEY',
  'SECRET',
  'GOV_ID',
  'CUSTOM',
  'EMAIL',
  'PHONE',
] as const;

export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export interface Finding {
  kind: SensitiveKind;
  start: number;
  end: number;
  /** The exact matched text, kept only in memory for rehydration. */
  value: string;
}

export interface DetectOptions {
  /** Emails and phone numbers. Off by default because commands like "email John" need them. */
  maskContactInfo: boolean;
  /** Exact values the user registered as sensitive (account numbers, address, ...). */
  customValues: readonly string[];
}

interface Rule {
  kind: SensitiveKind;
  /** Must use the `d` flag when `group` is set, so group indices are available. */
  pattern: RegExp;
  /** Which capture group is the sensitive value. 0 means the whole match. */
  group?: number;
  validate?: (value: string) => boolean;
}

const RULES: Rule[] = [
  {
    kind: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'API_KEY',
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
  },
  { kind: 'SECRET', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: 'PASSWORD',
    pattern:
      /\b(?:password|passcode|passphrase|pwd|pin(?:\s+(?:number|code))?|user\s*name|username|user\s*id|login)(?:\s+(?:is|was)\s+|\s*[:=]\s*)["']?([^\s"']+)/dgi,
    group: 1,
  },
  {
    kind: 'OTP',
    pattern:
      /\b(?:otp|2fa|(?:verification|security|confirmation|login|auth(?:entication)?|one[- ]time)\s+code|code\s+is)\D{0,10}?(\d{4,8})\b/dgi,
    group: 1,
  },
  {
    kind: 'CVV',
    pattern: /\b(?:cvv2?|cvc2?|cid|card\s+security\s+code)\W{0,10}(?:is\s+)?(\d{3,4})\b/dgi,
    group: 1,
  },
  {
    kind: 'EXPIRY',
    pattern:
      /\b(?:exp(?:iry|iration|ires)?(?:\s+date)?)\W{0,12}(?:is\s+)?((?:0?[1-9]|1[0-2])\s*[/-]\s*(?:\d{4}|\d{2}))\b/dgi,
    group: 1,
  },
  { kind: 'CARD', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, validate: isLuhnValid },
  { kind: 'SSN', pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, validate: isPlausibleSsn },
  {
    kind: 'SSN',
    pattern: /\b(?:ssn|social(?:\s+security)?(?:\s+(?:number|no\.?|#))?)\D{0,10}?(\d{9})\b/dgi,
    group: 1,
    validate: isPlausibleSsn,
  },
  {
    kind: 'ROUTING',
    pattern: /\b(?:routing|aba|rtn|transit)(?:\s+(?:number|no\.?|#))?\D{0,10}?(\d{9})\b/dgi,
    group: 1,
    validate: isAbaRoutingValid,
  },
  {
    kind: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    validate: isIbanValid,
  },
  {
    kind: 'SWIFT',
    pattern:
      /\b(?:swift|bic)(?:\s+code)?\W{0,10}(?:is\s+)?([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/dgi,
    group: 1,
  },
  {
    kind: 'ACCOUNT',
    pattern:
      /\b(?:account|acct|a\/c|checking|savings)(?:\s+(?:number|no\.?|#|num))?\W{0,10}?(?:is\s+)?(\d(?:[ -]?\d){5,16})\b/dgi,
    group: 1,
  },
  {
    kind: 'GOV_ID',
    pattern:
      /\b(?:passport|driver'?s?\s+licen[cs]e|license\s+number|tax\s+id|ein|itin)(?:\s+(?:number|no\.?|#))?\W{0,10}?(?:is\s+)?([A-Z0-9][A-Z0-9-]{4,14})\b/dgi,
    group: 1,
    validate: (v) => /\d/.test(v),
  },
];

const CONTACT_RULES: Rule[] = [
  { kind: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: 'PHONE',
    pattern: /(?<![\d-])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\d-])/g,
  },
];

/** Long random-looking tokens: unknown API keys, session tokens, recovery codes. */
function findHighEntropyTokens(text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{24,}/g)) {
    const token = m[0];
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(token)).length;
    if (classes >= 3 && shannonEntropy(token) >= 4) {
      out.push({ kind: 'SECRET', start: m.index, end: m.index + token.length, value: token });
    }
  }
  return out;
}

/** Builds a pattern that finds a registered value even when spacing or dashes differ. */
function customValuePattern(value: string): RegExp | null {
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  const compact = digitsOnly(trimmed);
  if (compact.length >= 4 && compact.length === trimmed.replace(/[\s-]/g, '').length) {
    // Purely numeric: allow any spaces/dashes between digits.
    return new RegExp(`(?<!\\d)${compact.split('').join('[\\s-]*')}(?!\\d)`, 'g');
  }
  const escaped = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(escaped, 'gi');
}

function runRule(rule: Rule, text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(rule.pattern)) {
    const group = rule.group ?? 0;
    const value = m[group];
    const span: readonly [number, number] | undefined =
      group === 0 ? [m.index, m.index + m[0].length] : m.indices?.[group];
    if (!value || !span) continue;
    if (rule.validate && !rule.validate(value)) continue;
    out.push({ kind: rule.kind, start: span[0], end: span[1], value });
  }
  return out;
}

/**
 * Finds sensitive values in text. Deterministic and local. Overlapping findings are resolved in
 * favour of the one that starts first, then the longest, so nothing is masked twice.
 */
export function detectSensitive(text: string, options: DetectOptions): Finding[] {
  const findings: Finding[] = [];

  for (const value of options.customValues) {
    const pattern = customValuePattern(value);
    if (!pattern) continue;
    for (const m of text.matchAll(pattern)) {
      findings.push({ kind: 'CUSTOM', start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  }
  for (const rule of RULES) findings.push(...runRule(rule, text));
  if (options.maskContactInfo) {
    for (const rule of CONTACT_RULES) findings.push(...runRule(rule, text));
  }
  findings.push(...findHighEntropyTokens(text));

  findings.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const resolved: Finding[] = [];
  let cursor = -1;
  for (const f of findings) {
    if (f.start < cursor) continue;
    resolved.push(f);
    cursor = f.end;
  }
  return resolved;
}
