import { describe, expect, it } from 'vitest';
import type { AidaNotification } from '@shared/notifications';
import { NotificationCenter } from '../../../src/main/notifications/center';
import type { CalendarEvent, CalendarWatcher } from '../../../src/main/notifications/calendar';
import type { GmailWatcher } from '../../../src/main/notifications/gmail';
import { notificationTools } from '../../../src/main/tools/info/notifications';
import type { AnyTool, ToolContext } from '../../../src/main/tools/types';

const ctx = (): ToolContext => ({
  activeWindow: null,
  signal: new AbortController().signal,
  confirm: async () => true,
});

// Tuesday 29 September 2026, 9:00 local time.
const NOW = new Date(2026, 8, 29, 9, 0).getTime();
const at = (hours: number, minutes = 0, dayOffset = 0) =>
  new Date(2026, 8, 29 + dayOffset, hours, minutes).getTime();

function event(title: string, start: number, allDay = false): CalendarEvent {
  return {
    key: `${title}@${start}`,
    title,
    location: '',
    start,
    end: start + 1800_000,
    allDay,
    calendar: 'Me',
  };
}

function setup(options: { connected?: boolean; gmail?: boolean; events?: CalendarEvent[] } = {}) {
  const center = new NotificationCenter({
    enabled: () => true,
    holdWhenBusy: () => true,
    presence: async () => null,
    voice: { free: false, canTalk: true, notify: () => false },
    show: () => {},
    isOwnMicApp: () => false,
    now: () => NOW,
  });
  const ranges: [number, number][] = [];
  const calendar = {
    eventsBetween: async (from: number, to: number) => {
      ranges.push([from, to]);
      return (options.events ?? []).filter((e) => e.start < to && e.end > from);
    },
  } as unknown as CalendarWatcher;
  const gmail = {
    latest: async () => ({
      emails: [
        { id: 'a', from: 'Sam Lee', subject: 'Lunch tomorrow?', at: NOW },
        { id: 'b', from: 'GitHub', subject: '', at: NOW },
      ],
      total: 12,
    }),
  } as unknown as GmailWatcher;
  const tools = new Map<string, AnyTool>(
    notificationTools({
      center,
      gmail,
      calendar,
      google: () => ({
        connected: options.connected ?? true,
        gmail: options.gmail ?? true,
        calendar: true,
      }),
      now: () => NOW,
    }).map((t) => [t.name, t]),
  );
  const run = (name: string, args: object = {}) => tools.get(name)!.run(args, ctx());
  return { center, run, ranges };
}

const mail = (id: string, title: string): AidaNotification => ({
  id,
  source: 'gmail',
  at: NOW,
  title,
  detail: 'Hello',
  state: 'pending',
});

describe('notification tools', () => {
  it('"what did I miss" reads what was held back, once', async () => {
    const { center, run } = setup();
    center.add([mail('1', 'Sam'), mail('2', 'Ann')]);
    expect((await run('read_notifications')).speak).toBe('2 new emails, from Sam and Ann.');
    expect(center.pendingCount).toBe(0);
    expect((await run('read_notifications')).speak).toBe('Nothing new since I last told you.');
  });

  it('mutes for a while, and unmutes', async () => {
    const { center, run } = setup();
    expect((await run('mute_notifications', { minutes: 90 })).speak).toMatch(
      /no notifications for 1 hour 30 minutes/,
    );
    expect(center.muteEnd).toBe(NOW + 90 * 60_000);
    await run('mute_notifications', { off: true });
    expect(center.muteEnd).toBeNull();
  });

  it('checks Gmail: sender and subject, withheld subjects left out', async () => {
    const { run } = setup();
    expect((await run('check_email')).speak).toBe(
      'About 12 unread emails. The newest are from Sam Lee about Lunch tomorrow? and GitHub.',
    );
  });

  it('points to Settings when Google isn’t connected or Gmail wasn’t allowed', async () => {
    expect((await setup({ connected: false }).run('check_email')).speak).toMatch(
      /Settings → Notifications/,
    );
    expect((await setup({ gmail: false }).run('check_email')).speak).toMatch(/tick the Gmail box/);
  });

  it('lists the rest of today, another day, and the next event', async () => {
    const events = [
      event('Standup', at(10)),
      event('Lunch with Sam', at(12, 30)),
      event('Dentist', at(15, 0, 1)),
      event('Holiday', at(0, 0, 3), true),
    ];
    const { run, ranges } = setup({ events });
    const today = (await run('get_calendar', { when: 'today' })).speak;
    expect(today).toMatch(
      /^Still to come today: Standup at 10:00\sAM and Lunch with Sam at 12:30\sPM\.$/,
    );
    // Today starts now, not at midnight: meetings that are over aren't listed.
    expect(ranges[0]).toEqual([NOW, at(0, 0, 1)]);

    expect((await run('get_calendar', { when: 'tomorrow' })).speak).toMatch(
      /^You have 1 event tomorrow: Dentist at 3:00\sPM\.$/,
    );
    expect((await run('get_calendar', { when: 'next' })).speak).toMatch(
      /^Your next event is Standup at 10:00\sAM, in 1 hour\.$/,
    );
    expect((await run('get_calendar', { when: 'friday' })).speak).toBe(
      'You have 1 event on Friday: Holiday, all day.',
    );
    expect((await run('get_calendar', { when: 'this week' })).ok).toBe(false);
  });
});
