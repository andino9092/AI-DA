import { z } from 'zod';
import type { AidaNotification } from '@shared/notifications';
import type { GoogleApi } from '../google/client';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';

/** How far ahead events are fetched for reminders. */
const LOOKAHEAD_MS = 26 * 60 * 60 * 1000;
/** The list of calendars changes rarely. */
const CALENDAR_LIST_MS = 60 * 60 * 1000;
/** A reminder found up to this long after the event started is still worth a "starting now". */
const LATE_GRACE_MS = 60_000;
/** Reading "starting now" out later than this after the start is pointless. */
const EXPIRE_AFTER_START_MS = 2 * 60_000;

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        selected: z.boolean().optional(),
        hidden: z.boolean().optional(),
        primary: z.boolean().optional(),
      }),
    )
    .optional(),
});

const timeSchema = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  eventType: z.string().optional(),
  start: timeSchema.optional(),
  end: timeSchema.optional(),
  attendees: z
    .array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() }))
    .optional(),
});
const eventsSchema = z.object({ items: z.array(eventSchema).optional() });

export interface CalendarEvent {
  /** Unique per occurrence: event id + start. */
  key: string;
  title: string;
  location: string;
  /** ms; for all-day events, local midnight of the day. */
  start: number;
  end: number;
  allDay: boolean;
  calendar: string;
}

export interface CalendarDeps {
  google: GoogleApi;
  now?: () => number;
}

/**
 * Keeps the next day of events from every calendar the user shows in Google Calendar, and says
 * which ones are due for a reminder. Refreshed every few minutes; reminders are checked locally.
 */
export class CalendarWatcher {
  private calendars: { id: string; name: string }[] | null = null;
  private calendarsAt = 0;
  private upcoming: CalendarEvent[] = [];
  private readonly reminded = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: CalendarDeps) {
    this.now = deps.now ?? Date.now;
  }

  reset(): void {
    this.calendars = null;
    this.upcoming = [];
    this.reminded.clear();
  }

  /** Fetches the events of the next day. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    this.upcoming = await this.eventsBetween(now - LATE_GRACE_MS, now + LOOKAHEAD_MS, signal);
    // Forget reminders for events that are over.
    const keys = new Set(this.upcoming.map((e) => e.key));
    for (const key of this.reminded) if (!keys.has(key)) this.reminded.delete(key);
  }

  /**
   * Events whose reminder time has come (minutesBefore their start), each returned once. An event
   * that's already under way isn't announced, except right at its start.
   */
  due(minutesBefore: number): AidaNotification[] {
    const now = this.now();
    const found: AidaNotification[] = [];
    for (const event of this.upcoming) {
      if (event.allDay || this.reminded.has(event.key)) continue;
      if (now < event.start - minutesBefore * 60_000 || now > event.start + LATE_GRACE_MS) continue;
      this.reminded.add(event.key);
      found.push({
        id: `calendar:${event.key}`,
        source: 'calendar',
        at: now,
        title: event.title,
        detail: event.location,
        startsAt: event.start,
        expiresAt: event.start + EXPIRE_AFTER_START_MS,
        state: 'pending',
      });
    }
    return found;
  }

  /** Every shown calendar's events that overlap [from, to), in start order. */
  async eventsBetween(from: number, to: number, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const calendars = await this.calendarList(signal);
    const events: CalendarEvent[] = [];
    for (const calendar of calendars) {
      const response = eventsSchema.parse(
        await this.deps.google.get(
          `${CALENDAR}/calendars/${encodeURIComponent(calendar.id)}/events`,
          {
            timeMin: new Date(from).toISOString(),
            timeMax: new Date(to).toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '50',
          },
          signal,
        ),
      );
      for (const item of response.items ?? []) {
        const event = toEvent(item, calendar.name);
        if (event) events.push(event);
      }
    }
    // The same meeting can be on two calendars (yours and a shared one).
    const unique = new Map<string, CalendarEvent>();
    for (const e of events) {
      const key = `${e.title}|${e.start}`;
      if (!unique.has(key)) unique.set(key, e);
    }
    return [...unique.values()].sort((a, b) => a.start - b.start);
  }

  private async calendarList(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
    if (this.calendars && this.now() - this.calendarsAt < CALENDAR_LIST_MS) return this.calendars;
    const response = calendarListSchema.parse(
      await this.deps.google.get(`${CALENDAR}/users/me/calendarList`, { maxResults: '50' }, signal),
    );
    // The calendars ticked in Google Calendar's sidebar.
    this.calendars = (response.items ?? [])
      .filter((c) => c.primary || (c.selected === true && !c.hidden))
      .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id }));
    this.calendarsAt = this.now();
    return this.calendars;
  }
}

function toEvent(item: z.infer<typeof eventSchema>, calendar: string): CalendarEvent | null {
  if (item.status === 'cancelled') return null;
  // Out-of-office blocks and working locations aren't things to be reminded of.
  if (item.eventType && !['default', 'fromGmail', 'focusTime'].includes(item.eventType))
    return null;
  if (item.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = !item.start?.dateTime && !!item.start?.date;
  const start = parseTime(item.start);
  if (start === null) return null;
  const end = parseTime(item.end) ?? start;
  return {
    key: `${item.id}@${start}`,
    title: (item.summary ?? '').trim() || 'An event',
    location: (item.location ?? '').split('\n')[0]!.trim(),
    start,
    end,
    allDay,
    calendar,
  };
}

function parseTime(time: z.infer<typeof timeSchema> | undefined): number | null {
  if (time?.dateTime) {
    const t = Date.parse(time.dateTime);
    return Number.isNaN(t) ? null : t;
  }
  if (time?.date) {
    // All-day events: local midnight of that date.
    const [y, m, d] = time.date.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d).getTime();
  }
  return null;
}
