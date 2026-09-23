/** Checksums and format rules that turn "looks like a number" into "is a real identifier". */

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** Luhn (mod 10) check used by every major payment card network. */
export function isLuhnValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** US Social Security Number structural rules (SSA never issues these ranges). */
export function isPlausibleSsn(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  if (area === 0 || area === 666 || area >= 900) return false;
  return group !== 0 && serial !== 0;
}

/** ABA routing number checksum: 3-7-1 weighted sum must be divisible by 10. */
export function isAbaRoutingValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 9 || /^0+$/.test(digits)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (digits.charCodeAt(i) - 48) * weights[i]!;
  return sum % 10 === 0;
}

/** IBAN mod-97 check (ISO 13616). */
export function isIbanValid(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const chunk = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of chunk) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Shannon entropy in bits per character. Random API keys sit around 4.5–6. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
