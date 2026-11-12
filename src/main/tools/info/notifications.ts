import { z } from 'zod';
import type { CalendarEvent, CalendarWatcher } from '../../notifications/calendar';
import type { NotificationCenter } from '../../notifications/center';
import { describe } from '../../notifications/format';
import type { GmailWatcher } from '../../notifications/gmail';
import { defineTool } from '../types';
import { dayIndex } from './weather';
import { formatClock, formatDuration } from './timers';

export interface NotificationToolDeps {
  center: NotificationCenter;
  gmail: GmailWatcher;
  calendar: CalendarWatcher;
  /** Google is connected, and which parts the user allowed. */
  google(): { connected: boolean; gmail: boolean; calendar: boolean };
  now?: () => number;
}

const NOT_CONNECTED = 'Connect your Google account in Settings → Notifications first.';

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Standup at 10:00 AM" / "Holiday, all day". */
function eventPhrase(event: CalendarEvent): string {
  return event.allDay
    ? `${event.title}, all day`
    : `${event.title} at ${formatClock(new Date(event.start))}`;
}

/** Local midnight of the day `offset` days from `now`. */
function dayStart(now: number, offset: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

export function notificationTools({
  center,
  gmail,
  calendar,
  google,
  now = Date.now,
}: NotificationToolDeps) {
  return [
    defineTool({
      name: 'read_notifications',
      description:
        'Notifications the user has not heard yet (new emails, calendar reminders), e.g. "what did I miss", "any notifications".',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'Read new notifications',
      run: async () => {
        const unheard = center.takeUnheard();
        if (unheard.length === 0) return { ok: true, speak: 'Nothing new since I last told you.' };
        return {
          ok: true,
          speak: describe(unheard, now()),
          data: unheard.map((n) => ({ source: n.source, title: n.title, detail: n.detail })),
        };
      },
    }),

    defineTool({
      name: 'mute_notifications',
      description:
        'Pause reading notifications aloud for a while ("mute notifications for an hour"), or turn them back on (off: true).',
      risk: 'safe',
      input: z.object({
        minutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .optional()
          .describe('How long; default 60'),
        off: z.boolean().optional().describe('true to unmute (read notifications again)'),
      }),
      describe: ({ minutes, off }) =>
        off
          ? 'Unmute notifications'
          : `Mute notifications for ${formatDuration((minutes ?? 60) * 60_000)}`,
      run: async ({ minutes, off }) => {
        if (off) {
          center.mute(null);
          return { ok: true, speak: "Notifications are back on. I'll tell you what comes in." };
        }
        const ms = (minutes ?? 60) * 60_000;
        center.mute(now() + ms);
        return {
          ok: true,
          speak: `Okay, no notifications for ${formatDuration(ms)}. Ask "what did I miss" anytime.`,
        };
      },
    }),

    defineTool({
      name: 'check_email',
      description:
        'The user\'s newest unread emails in Gmail (sender and subject only), e.g. "do I have any new emails".',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'Check Gmail for unread emails',
      run: async (_args, ctx) => {
        const g = google();
        if (!g.connected) return { ok: false, speak: NOT_CONNECTED };
        if (!g.gmail)
          return {
            ok: false,
            speak: 'Gmail access wasn’t allowed. Connect Google again and tick the Gmail box.',
          };
        try {
          const { emails, total } = await gmail.latest(5, ctx.signal);
          if (emails.length === 0) return { ok: true, speak: 'No unread emails.' };
          const lines = emails.map((e) => (e.subject ? `${e.from} about ${e.subject}` : e.from));
          const speak =
            emails.length === 1
              ? `One unread email, from ${lines[0]}.`
              : total > emails.length
                ? `About ${total} unread emails. The newest are from ${list(lines)}.`
                : `${emails.length} unread emails, from ${list(lines)}.`;
          return {
            ok: true,
            speak,
            data: emails.map(({ from, subject }) => ({ from, subject })),
          };
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { ok: false, speak: "I couldn't reach Gmail right now." };
        }
      },
    }),

    defineTool({
      name: 'get_calendar',
      description:
        'Events on the user\'s Google Calendar: a day ("what\'s on my calendar tomorrow") or the next one ("when\'s my next meeting").',
      risk: 'safe',
      input: z.object({
        when: z
          .string()
          .optional()
          .describe(
            '"today" (default), "tomorrow", a weekday like "friday", or "next" for the next event',
          ),
      }),
      describe: ({ when }) => `Check the calendar${when ? ` (${when})` : ''}`,
      run: async ({ when }, ctx) => {
        const g = google();
        if (!g.connected) return { ok: false, speak: NOT_CONNECTED };
        if (!g.calendar)
          return {
            ok: false,
            speak:
              'Calendar access wasn’t allowed. Connect Google again and tick the Calendar box.',
          };
        const t = now();
        try {
          if (/^(?:next|upcoming|soon)/i.test(when ?? '')) {
            const events = (await calendar.eventsBetween(t, t + 7 * 86_400_000, ctx.signal)).filter(
              (e) => !e.allDay && e.start >= t - 60_000,
            );
            const next = events[0];
            if (!next) return { ok: true, speak: 'Nothing on your calendar in the next week.' };
            const inMs = next.start - t;
            const soon =
              inMs < 12 * 3_600_000 ? `, in ${formatDuration(Math.max(inMs, 60_000))}` : '';
            const day =
              next.start < dayStart(t, 1)
                ? ''
                : next.start < dayStart(t, 2)
                  ? ' tomorrow'
                  : ` on ${new Date(next.start).toLocaleDateString(undefined, { weekday: 'long' })}`;
            return { ok: true, speak: `Your next event is ${eventPhrase(next)}${day}${soon}.` };
          }
          const index = dayIndex(when ?? 'today', new Date(t));
          const offset = index === 'now' || index === null ? 0 : index === 'week' ? null : index;
          if (offset === null)
            return {
              ok: false,
              speak: 'I can check one day at a time, like today or Friday.',
              followUp: true,
            };
          const from = offset === 0 ? t : dayStart(t, offset);
          const events = await calendar.eventsBetween(from, dayStart(t, offset + 1), ctx.signal);
          const dayName =
            offset === 0
              ? 'today'
              : offset === 1
                ? 'tomorrow'
                : `on ${new Date(from).toLocaleDateString(undefined, { weekday: 'long' })}`;
          if (events.length === 0)
            return {
              ok: true,
              speak:
                offset === 0
                  ? 'Nothing else on your calendar today.'
                  : `Nothing on your calendar ${dayName}.`,
            };
          const phrases = events.map(eventPhrase);
          const lead =
            offset === 0
              ? `Still to come today`
              : `You have ${events.length} event${events.length === 1 ? '' : 's'} ${dayName}`;
          return {
            ok: true,
            speak: `${lead}: ${list(phrases.slice(0, 6))}${events.length > 6 ? `, and ${events.length - 6} more` : ''}.`,
            data: events.map((e) => ({
              title: e.title,
              start: new Date(e.start).toISOString(),
              allDay: e.allDay,
            })),
          };
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { ok: false, speak: "I couldn't reach Google Calendar right now." };
        }
      },
    }),
  ];
}
