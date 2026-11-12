import { describe, expect, it } from 'vitest';
import type { AidaNotification } from '@shared/notifications';
import type { GoogleApi } from '../../../src/main/google/client';
import {
  describe as describeBatch,
  eventSentence,
  senderName,
  withholdSubject,
} from '../../../src/main/notifications/format';
import { GmailWatcher, type GmailFilter } from '../../../src/main/notifications/gmail';
import { CalendarWatcher } from '../../../src/main/notifications/calendar';

/** Answers Google API calls from a function; records the URLs asked for. */
class FakeGoogle implements GoogleApi {
  calls: URL[] = [];
  constructor(private readonly answer: (url: URL) => unknown) {}
  connected() {
    return true;
  }
  async get<T>(url: string, query: Record<string, string | string[] | undefined> = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query))
      for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v])
        u.searchParams.append(k, x);
    this.calls.push(u);
    const result = this.answer(u);
    if (result instanceof Error) throw result;
    return result as T;
  }
}

const MIN = 60_000;
const T0 = Date.parse('2026-09-29T15:00:00Z');

function email(overrides: Partial<AidaNotification> = {}): AidaNotification {
  return {
    id: `gmail:${Math.random()}`,
    source: 'gmail',
    at: T0,
    title: 'Sam Lee',
    detail: 'Lunch tomorrow?',
    state: 'pending',
    ...overrides,
  };
}

describe('what Aida says', () => {
  it('turns From headers into names worth saying', () => {
    expect(senderName('"Sam Lee" <sam@example.com>')).toBe('Sam Lee');
    expect(senderName('Sam Lee <sam@example.com>')).toBe('Sam Lee');
    expect(senderName('noreply@github.com')).toBe('GitHub');
    expect(senderName('<notifications@mail.youtube.com>')).toBe('YouTube');
    expect(senderName('order-update@amazon.co.uk')).toBe('Order Update');
    expect(senderName('no-reply@amazon.co.uk')).toBe('Amazon');
    expect(senderName('jane.doe@gmail.com')).toBe('Jane Doe');
    expect(senderName('user12345@mail.example.com')).toBe('Example');
  });

  it('never reads out sign-in codes or anything the Privacy Guard would mask', () => {
    const none = () => false;
    for (const subject of [
      'Your verification code is 482913',
      '482913 is your Instagram code',
      'Your Google security code',
      'Sign-in code for Steam',
      'Reset your password',
      'Your one-time passcode',
    ])
      expect(withholdSubject(subject, none), subject).toBe(true);
    for (const subject of ['Lunch tomorrow?', 'Your order has shipped', 'Code review: PR #42'])
      expect(withholdSubject(subject, none), subject).toBe(false);
    expect(withholdSubject('Card 4111 1111 1111 1111', (t) => t.includes('4111'))).toBe(true);
  });

  it('reads one email, and sums up several by sender', () => {
    expect(describeBatch([email()], T0)).toBe('Email from Sam Lee: Lunch tomorrow?');
    expect(describeBatch([email({ detail: '' })], T0)).toBe('Email from Sam Lee.');
    expect(
      describeBatch([email(), email({ title: 'GitHub' }), email({ title: 'Sam Lee' })], T0),
    ).toBe('3 new emails, from Sam Lee and GitHub.');
    const many = ['A', 'B', 'C', 'D', 'E'].map((title) => email({ title }));
    expect(describeBatch(many, T0)).toBe('5 new emails, from A, B, C and 2 others.');
  });

  it('says events relative to now, events first, with a lead-in after holding', () => {
    const standup: AidaNotification = {
      id: 'calendar:x',
      source: 'calendar',
      at: T0,
      title: 'Standup',
      detail: '',
      startsAt: T0 + 10 * MIN,
      state: 'pending',
    };
    expect(eventSentence(standup, T0)).toBe('Standup starts in 10 minutes.');
    expect(eventSentence(standup, T0 + 9 * MIN)).toBe('Standup starts in a minute.');
    expect(eventSentence(standup, T0 + 10 * MIN)).toBe('Standup is starting now.');
    expect(describeBatch([email(), standup], T0, 'fullscreen')).toBe(
      'While you were busy: Standup starts in 10 minutes. Email from Sam Lee: Lunch tomorrow?',
    );
    expect(describeBatch([email()], T0, 'away')).toBe(
      'While you were away: email from Sam Lee: Lunch tomorrow?',
    );
  });
});

describe('GmailWatcher', () => {
  function inbox(messages: Record<string, { from: string; subject: string; at?: number }>) {
    const ids = { current: Object.keys(messages) };
    const google = new FakeGoogle((url) => {
      if (url.pathname.endsWith('/messages'))
        return {
          messages: ids.current.map((id) => ({ id })),
          resultSizeEstimate: ids.current.length,
        };
      const id = url.pathname.split('/').pop()!;
      const m = messages[id];
      if (!m) return new Error('gone');
      return {
        id,
        internalDate: String(m.at ?? T0),
        payload: {
          headers: [
            { name: 'From', value: m.from },
            { name: 'Subject', value: m.subject },
          ],
        },
      };
    });
    return { google, ids, messages };
  }

  it('learns the inbox on the first check, then announces only new mail, oldest first', async () => {
    const { google, ids, messages } = inbox({
      old: { from: 'Old <o@x.com>', subject: 'Old news' },
    });
    let filter: GmailFilter = 'primary';
    const gmail = new GmailWatcher({
      google,
      filter: () => filter,
      isSensitive: () => false,
      now: () => T0,
    });
    expect(await gmail.check()).toEqual([]);

    messages['b'] = { from: '"Sam Lee" <sam@x.com>', subject: 'Lunch tomorrow?' };
    messages['c'] = { from: 'noreply@github.com', subject: 'Your verification code is 123456' };
    ids.current = ['c', 'b', 'old']; // Gmail lists newest first.
    const found = await gmail.check();
    expect(found.map((n) => [n.id, n.title, n.detail])).toEqual([
      ['gmail:b', 'Sam Lee', 'Lunch tomorrow?'],
      ['gmail:c', 'GitHub', ''],
    ]);
    // Asked only for headers of unread Primary mail.
    const list = google.calls.find((u) => u.pathname.endsWith('/messages'))!;
    expect(list.searchParams.getAll('labelIds')).toEqual(['INBOX', 'CATEGORY_PERSONAL', 'UNREAD']);
    const get = google.calls.find((u) => u.pathname.endsWith('/b'))!;
    expect(get.searchParams.get('format')).toBe('metadata');

    expect(await gmail.check()).toEqual([]);
    // Changing the filter starts over instead of announcing a whole other set of mail.
    filter = 'all';
    messages['d'] = { from: 'd@x.com', subject: 'D' };
    ids.current = ['d', 'c', 'b', 'old'];
    expect(await gmail.check()).toEqual([]);
  });

  it('skips mail that is old news (marked unread again)', async () => {
    const { google, ids, messages } = inbox({});
    const gmail = new GmailWatcher({
      google,
      filter: () => 'primary',
      isSensitive: () => false,
      now: () => T0,
    });
    await gmail.check();
    messages['x'] = { from: 'x@y.com', subject: 'From last week', at: T0 - 7 * 24 * 60 * MIN };
    ids.current = ['x'];
    expect(await gmail.check()).toEqual([]);
  });

  it('lists the newest unread emails for "check my email"', async () => {
    const { google } = inbox({
      a: { from: 'Ann <a@x.com>', subject: 'Hi' },
      b: { from: 'Bob <b@x.com>', subject: 'Plans' },
    });
    const gmail = new GmailWatcher({ google, filter: () => 'important', isSensitive: () => false });
    const { emails, total } = await gmail.latest(5);
    expect(emails.map((e) => `${e.from}: ${e.subject}`)).toEqual(['Ann: Hi', 'Bob: Plans']);
    expect(total).toBe(2);
    expect(google.calls[0]!.searchParams.getAll('labelIds')).toEqual([
      'INBOX',
      'IMPORTANT',
      'UNREAD',
    ]);
  });
});

describe('CalendarWatcher', () => {
  const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
  function calendars(events: Record<string, object[]>) {
    return new FakeGoogle((url) => {
      if (url.pathname.endsWith('/calendarList'))
        return {
          items: [
            { id: 'me@gmail.com', summary: 'Me', primary: true, selected: true },
            { id: 'team', summary: 'Team', selected: true },
            { id: 'holidays', summary: 'Holidays', selected: false },
          ],
        };
      const id = decodeURIComponent(url.pathname.split('/')[4]!);
      return { items: events[id] ?? [] };
    });
  }

  it('reminds once, minutes before each timed event, across calendars', async () => {
    let now = T0;
    const google = calendars({
      'me@gmail.com': [
        {
          id: 'standup',
          summary: 'Standup',
          start: { dateTime: at(15) },
          end: { dateTime: at(30) },
        },
        { id: 'trip', summary: 'Trip', start: { date: '2026-09-29' }, end: { date: '2026-09-30' } },
        {
          id: 'skip',
          summary: 'Declined',
          start: { dateTime: at(12) },
          attendees: [{ self: true, responseStatus: 'declined' }],
        },
        {
          id: 'ooo',
          summary: 'Out of office',
          eventType: 'outOfOffice',
          start: { dateTime: at(14) },
        },
        { id: 'gone', summary: 'Cancelled', status: 'cancelled', start: { dateTime: at(13) } },
      ],
      // The same meeting on a shared calendar is one event.
      team: [{ id: 'standup2', summary: 'Standup', start: { dateTime: at(15) } }],
      holidays: [{ id: 'h', summary: 'Hidden calendar', start: { dateTime: at(15) } }],
    });
    const calendar = new CalendarWatcher({ google, now: () => now });
    await calendar.refresh();
    expect(calendar.due(10)).toEqual([]);
    now = T0 + 5 * MIN;
    const due = calendar.due(10);
    expect(due.map((d) => [d.title, d.startsAt, d.expiresAt])).toEqual([
      ['Standup', T0 + 15 * MIN, T0 + 17 * MIN],
    ]);
    expect(calendar.due(10)).toEqual([]);
    // The hidden calendar was never asked for.
    expect(google.calls.some((u) => u.pathname.includes('holidays'))).toBe(false);
  });

  it('still mentions an event found just after it started, but not one well under way', async () => {
    const now = T0;
    const google = calendars({
      'me@gmail.com': [
        { id: 'a', summary: 'Just started', start: { dateTime: at(-0.5) } },
        { id: 'b', summary: 'Long running', start: { dateTime: at(-20) } },
      ],
    });
    const calendar = new CalendarWatcher({ google, now: () => now });
    await calendar.refresh();
    expect(calendar.due(10).map((d) => d.title)).toEqual(['Just started']);
  });
});
