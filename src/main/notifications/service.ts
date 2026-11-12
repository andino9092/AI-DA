import type { NotificationsSnapshot } from '@shared/notifications';
import { GoogleError } from '../google/client';
import type { CalendarWatcher } from './calendar';
import type { NotificationCenter } from './center';
import type { GmailFilter, GmailWatcher } from './gmail';

/** How often each source is checked, and how long to wait after a failure. */
export const GMAIL_EVERY_MS = 60_000;
export const CALENDAR_EVERY_MS = 10 * 60_000;
const RETRY_AFTER_ERROR_MS = 5 * 60_000;
/** The polling loop; calendar reminders are checked on every pass. */
const LOOP_MS = 15_000;
/** How often the center looks for a good moment to talk. */
const DELIVER_MS = 3000;

export interface NotificationSettings {
  enabled: boolean;
  gmail: GmailFilter | 'off';
  /** Minutes before an event to mention it; null: no calendar reminders. */
  calendarMinutes: number | null;
}

export interface ServiceDeps {
  google: { connected(): boolean };
  gmail: GmailWatcher;
  calendar: CalendarWatcher;
  center: NotificationCenter;
  settings(): NotificationSettings;
  /** What Google granted on its consent page (null: not known yet). */
  granted(): { gmail: boolean; calendar: boolean } | null;
  changed?(): void;
  now?: () => number;
}

type Source = 'gmail' | 'calendar';

/**
 * Checks Gmail every minute and Calendar every ten minutes while notifications are on and Google
 * is connected, and hands what's new to the center, which picks the moment to read it out.
 */
export class NotificationService {
  private readonly nextCheck: Record<Source, number> = { gmail: 0, calendar: 0 };
  private readonly errors: Record<Source, string | null> = { gmail: null, calendar: null };
  private expiredNoticeGiven = false;
  private loop: ReturnType<typeof setInterval> | null = null;
  private deliverLoop: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stop();
    this.loop = setInterval(() => void this.poll(), LOOP_MS);
    this.deliverLoop = setInterval(() => void this.deps.center.tick(), DELIVER_MS);
    void this.poll();
  }

  stop(): void {
    if (this.loop) clearInterval(this.loop);
    if (this.deliverLoop) clearInterval(this.deliverLoop);
    this.loop = this.deliverLoop = null;
  }

  /** Signed in (again), or the settings changed: start over and check right away. */
  reset(): void {
    this.deps.gmail.reset();
    this.deps.calendar.reset();
    this.nextCheck.gmail = this.nextCheck.calendar = 0;
    this.errors.gmail = this.errors.calendar = null;
    this.expiredNoticeGiven = false;
    this.deps.changed?.();
    void this.poll();
  }

  /** One pass: check whatever is due. Public for tests. */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settings = this.deps.settings();
      if (!settings.enabled || !this.deps.google.connected()) return;
      const granted = this.deps.granted();
      if (settings.gmail !== 'off' && granted?.gmail !== false)
        await this.check('gmail', GMAIL_EVERY_MS, async () =>
          this.deps.center.add(await this.deps.gmail.check()),
        );
      if (settings.calendarMinutes !== null && granted?.calendar !== false) {
        await this.check('calendar', CALENDAR_EVERY_MS, () => this.deps.calendar.refresh());
        // Reminders come from the events already fetched, so they're on time between checks.
        this.deps.center.add(this.deps.calendar.due(settings.calendarMinutes));
      }
    } finally {
      this.running = false;
    }
  }

  snapshotParts(): Pick<
    NotificationsSnapshot,
    'recent' | 'pending' | 'held' | 'heldBy' | 'mutedUntil' | 'error'
  > {
    const { center } = this.deps;
    return {
      recent: center.recent(),
      pending: center.pendingCount,
      held: center.holdReason,
      heldBy: center.heldBy,
      mutedUntil: center.muteEnd,
      error: this.errors.gmail ?? this.errors.calendar,
    };
  }

  private async check(source: Source, every: number, run: () => Promise<void>): Promise<void> {
    const now = this.now();
    if (now < this.nextCheck[source]) return;
    try {
      await run();
      this.nextCheck[source] = now + every;
      if (this.errors[source]) {
        this.errors[source] = null;
        this.deps.changed?.();
      }
    } catch (err) {
      this.nextCheck[source] = now + RETRY_AFTER_ERROR_MS;
      const message = describeError(err, source);
      if (message !== this.errors[source]) {
        this.errors[source] = message;
        this.deps.changed?.();
      }
      // Once: say that the sign-in ran out, since everything stops until the user reconnects.
      if (err instanceof GoogleError && err.reason === 'expired' && !this.expiredNoticeGiven) {
        this.expiredNoticeGiven = true;
        this.deps.center.add([
          {
            id: `system:expired:${now}`,
            source: 'system',
            at: now,
            title: 'Your Google sign-in expired',
            detail: 'reconnect it in Settings to keep getting email and calendar notifications',
            state: 'pending',
          },
        ]);
      }
    }
  }
}

/** A short, fixable description of what went wrong. */
export function describeError(err: unknown, source: Source): string {
  const api = source === 'gmail' ? 'Gmail' : 'Google Calendar';
  if (err instanceof GoogleError) {
    if (err.reason === 'expired' || err.reason === 'not_connected')
      return 'The Google sign-in expired. Connect again.';
    if (err.reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(err.message))
      return `Turn on the ${api} API in your Google Cloud project (step 2), then wait a minute.`;
    if (err.status === 403)
      return `Google didn't allow reading ${api}. Connect again and tick every box on Google's page.`;
    if (err.status === 429) return `${api} is rate-limiting AI-DA; it will try again shortly.`;
    return `${api}: ${err.message}`;
  }
  return `Couldn't reach ${api}. Check your connection.`;
}
