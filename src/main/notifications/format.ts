import type { AidaNotification, HoldReason } from '@shared/notifications';

/** Senders whose address says nothing about who they are ("noreply@github.com" → "GitHub"). */
const GENERIC_SENDER =
  /^(?:no-?reply|do-?not-?reply|notifications?|notify|info|support|hello|hi|team|news|newsletter|updates?|alerts?|mail|mailer|account|accounts|service|contact|help|billing|security|admin)$/i;

/** Well-known brands whose domain doesn't capitalize well. */
const BRANDS: Record<string, string> = {
  github: 'GitHub',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  paypal: 'PayPal',
  doordash: 'DoorDash',
  playstation: 'PlayStation',
  ebay: 'eBay',
  icloud: 'iCloud',
};

/** A From header → a name to say: "Sam Lee <sam@x.com>" → "Sam Lee". */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const name = match?.[1]?.trim();
  if (name && !name.includes('@')) return name;
  const address = (match?.[2] ?? from).trim();
  const [local = '', domain = ''] = address.split('@');
  if (local && !GENERIC_SENDER.test(local) && !/\d{3,}/.test(local))
    return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const parts = domain.toLowerCase().split('.');
  // "mail.google.com" → "google"; "amazon.co.uk" → "amazon".
  const core =
    parts.length >= 3 && parts[parts.length - 2]!.length <= 3
      ? parts[parts.length - 3]!
      : (parts[parts.length - 2] ?? parts[0] ?? address);
  return BRANDS[core] ?? core.charAt(0).toUpperCase() + core.slice(1);
}

/** Subjects that carry sign-in codes and the like: said as "a security message", never read out. */
const SECURITY_SUBJECT =
  /\b(?:(?:verification|security|confirmation|sign-?in|log-?in|access|authentication|one-?time|2fa|otp)\s+(?:code|pin|link|number)|pass-?codes?|one-?time pass(?:word|code)|otp|2fa|two-?factor|password reset|reset (?:your )?password)\b|\b\d{4,8}\b.*\bcode\b|\bcode\b.*\b\d{4,8}\b/i;

/** Whether an email subject must not be read out (codes, or anything the Privacy Guard masks). */
export function withholdSubject(subject: string, isSensitive: (text: string) => boolean): boolean {
  return SECURITY_SUBJECT.test(subject) || isSensitive(subject);
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function minutesUntil(startsAt: number, now: number): number {
  return Math.round((startsAt - now) / 60_000);
}

/** "Standup starts in 10 minutes." / "Standup is starting now." / "Standup started 3 minutes ago." */
export function eventSentence(item: AidaNotification, now: number): string {
  const title = item.title || 'An event';
  if (item.startsAt === undefined) return `${title}.`;
  const minutes = minutesUntil(item.startsAt, now);
  if (minutes >= 2) return `${title} starts in ${minutes} minutes.`;
  if (minutes === 1) return `${title} starts in a minute.`;
  if (minutes > -2) return `${title} is starting now.`;
  return `${title} started ${-minutes} minutes ago.`;
}

/** "Email from Sam Lee: Lunch tomorrow?" */
export function emailSentence(item: AidaNotification): string {
  return item.detail ? `Email from ${item.title}: ${item.detail}` : `Email from ${item.title}.`;
}

const MAX_NAMES = 3;

/**
 * What Aida says for a batch of notifications: events first (they're time-sensitive), then
 * emails; one email is read out, several are summed up by sender. After holding them while the
 * user was busy or away, it starts with "While you were busy".
 */
export function describe(
  items: readonly AidaNotification[],
  now: number,
  heldFor: HoldReason = null,
): string {
  const sentences: string[] = [];
  for (const item of items) {
    if (item.source === 'calendar') sentences.push(eventSentence(item, now));
    else if (item.source !== 'gmail')
      sentences.push(end(item.detail ? `${item.title}: ${item.detail}` : item.title));
  }
  const emails = items.filter((i) => i.source === 'gmail');
  if (emails.length === 1) sentences.push(end(emailSentence(emails[0]!)));
  else if (emails.length > 1) {
    const names = [...new Set(emails.map((e) => e.title))];
    const shown = names.slice(0, MAX_NAMES);
    const others = names.length - shown.length;
    const from =
      others > 0
        ? `${shown.join(', ')} and ${others} other${others === 1 ? '' : 's'}`
        : list(shown);
    sentences.push(`${emails.length} new emails, from ${from}.`);
  }
  const text = sentences.join(' ');
  if (heldFor === 'away') return `While you were away: ${lowerFirst(text)}`;
  if (heldFor === 'fullscreen' || heldFor === 'call')
    return `While you were busy: ${lowerFirst(text)}`;
  return text;
}

function end(sentence: string): string {
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** "Email from…" → "email from…" after a lead-in; event titles and names keep their capitals. */
function lowerFirst(text: string): string {
  return text.replace(/^(Email|An event)\b/, (w) => w.toLowerCase());
}
