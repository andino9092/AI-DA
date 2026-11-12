import { z } from 'zod';
import type { AidaNotification } from '@shared/notifications';
import type { GoogleApi } from '../google/client';
import { senderName, withholdSubject } from './format';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailFilter = 'primary' | 'important' | 'all';

/** Gmail returns messages that have all of these labels. */
const LABELS: Record<GmailFilter, string[]> = {
  primary: ['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'],
  important: ['INBOX', 'IMPORTANT', 'UNREAD'],
  all: ['INBOX', 'UNREAD'],
};

/** Newest unread messages looked at per check; more than this at once is summed up anyway. */
const PAGE = 15;
/** Message ids remembered, so an email is announced once. */
const MAX_SEEN = 500;
/** Mail older than this when first seen isn't news (e.g. marked unread again). */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  resultSizeEstimate: z.number().optional(),
});
const messageSchema = z.object({
  id: z.string(),
  internalDate: z.string().optional(),
  payload: z
    .object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() })
    .optional(),
});

export interface EmailSummary {
  id: string;
  from: string;
  /** Empty when withheld (sign-in codes, sensitive values). */
  subject: string;
  at: number;
}

export interface GmailDeps {
  google: GoogleApi;
  filter(): GmailFilter;
  /** The Privacy Guard's check: subjects it would mask aren't read out. */
  isSensitive(text: string): boolean;
  now?: () => number;
}

/**
 * Finds new unread mail by asking Gmail for the newest matching messages and remembering which
 * ones it has seen. Uses only headers (Gmail's metadata scope can't read message text). The first
 * check just learns what's already there, so nothing old is announced.
 */
export class GmailWatcher {
  private readonly seen = new Set<string>();
  private primedFor: GmailFilter | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: GmailDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Forget what was seen (after signing in to a different account). */
  reset(): void {
    this.seen.clear();
    this.primedFor = null;
  }

  async check(signal?: AbortSignal): Promise<AidaNotification[]> {
    const filter = this.deps.filter();
    const ids = await this.unreadIds(filter, PAGE, signal);
    if (this.primedFor !== filter) {
      // First check, or the filter changed: what's there now isn't new.
      for (const id of ids) this.remember(id);
      this.primedFor = filter;
      return [];
    }
    const fresh = ids.filter((id) => !this.seen.has(id));
    const found: AidaNotification[] = [];
    // Oldest first, so they're read in the order they came in.
    for (const id of fresh.reverse()) {
      const email = await this.summary(id, signal);
      this.remember(id);
      if (!email || this.now() - email.at > MAX_AGE_MS) continue;
      found.push({
        id: `gmail:${id}`,
        source: 'gmail',
        at: email.at,
        title: email.from,
        detail: email.subject,
        state: 'pending',
      });
    }
    return found;
  }

  /** The newest unread emails (for "check my email"), newest first, and how many there are. */
  async latest(
    max: number,
    signal?: AbortSignal,
  ): Promise<{ emails: EmailSummary[]; total: number }> {
    const response = listSchema.parse(
      await this.deps.google.get(
        `${GMAIL}/messages`,
        { labelIds: LABELS[this.deps.filter()], maxResults: String(max) },
        signal,
      ),
    );
    const emails: EmailSummary[] = [];
    for (const { id } of response.messages ?? []) {
      const email = await this.summary(id, signal);
      if (email) emails.push(email);
    }
    return { emails, total: Math.max(response.resultSizeEstimate ?? 0, emails.length) };
  }

  private async unreadIds(
    filter: GmailFilter,
    max: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = listSchema.parse(
      await this.deps.google.get(
        `${GMAIL}/messages`,
        { labelIds: LABELS[filter], maxResults: String(max) },
        signal,
      ),
    );
    return (response.messages ?? []).map((m) => m.id);
  }

  private async summary(id: string, signal?: AbortSignal): Promise<EmailSummary | null> {
    try {
      const message = messageSchema.parse(
        await this.deps.google.get(
          `${GMAIL}/messages/${encodeURIComponent(id)}`,
          { format: 'metadata', metadataHeaders: ['From', 'Subject'] },
          signal,
        ),
      );
      const header = (name: string) =>
        message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
        '';
      const subject = header('Subject').replace(/\s+/g, ' ').trim();
      return {
        id,
        from: senderName(header('From')) || 'someone',
        subject: withholdSubject(subject, this.deps.isSensitive) ? '' : subject,
        at: Number(message.internalDate) || this.now(),
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      // Deleted in the meantime, or unreadable: skip it.
      return null;
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
  }
}
