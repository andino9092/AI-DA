import { describe, expect, it } from 'vitest';
import type { AidaNotification } from '@shared/notifications';
import type { Presence } from '../../../src/main/native/win-host';
import { busyReason, micAppName, NotificationCenter } from '../../../src/main/notifications/center';
import { NotificationService, describeError } from '../../../src/main/notifications/service';
import { GoogleError } from '../../../src/main/google/client';
import type { GmailWatcher } from '../../../src/main/notifications/gmail';
import type { CalendarWatcher } from '../../../src/main/notifications/calendar';

const T0 = Date.parse('2026-09-29T15:00:00Z');
const OWN = 'c:#apps#ai-da#ai-da.exe';

function note(id: string, overrides: Partial<AidaNotification> = {}): AidaNotification {
  return {
    id,
    source: 'gmail',
    at: T0,
    title: 'Sam',
    detail: `Mail ${id}`,
    state: 'pending',
    ...overrides,
  };
}

function setup(options: { holdWhenBusy?: boolean; enabled?: boolean } = {}) {
  const state = {
    now: T0,
    presence: { notificationState: 5, idleSeconds: 3, micApps: [] } as Presence,
    free: true,
    canTalk: true,
    said: [] as string[],
    shown: [] as string[],
    changes: 0,
  };
  const center = new NotificationCenter({
    enabled: () => options.enabled ?? true,
    holdWhenBusy: () => options.holdWhenBusy ?? true,
    presence: async () => state.presence,
    voice: {
      get free() {
        return state.free;
      },
      get canTalk() {
        return state.canTalk;
      },
      notify: (text) => {
        if (!state.free) return false;
        state.said.push(text);
        return true;
      },
    },
    show: (text) => state.shown.push(text),
    isOwnMicApp: (app) => app.toLowerCase() === OWN,
    changed: () => state.changes++,
    now: () => state.now,
  });
  return { center, state };
}

describe('when notifications are read out', () => {
  it('reads them right away when the user and Aida are free', async () => {
    const { center, state } = setup();
    center.add([note('1')]);
    await center.tick();
    expect(state.said).toEqual(['Email from Sam: Mail 1.']);
    expect(center.pendingCount).toBe(0);
    // Already known: not added (or read) twice.
    center.add([note('1')]);
    await center.tick();
    expect(state.said).toHaveLength(1);
  });

  it('holds during a full-screen game, then sums up once the user is back for a moment', async () => {
    const { center, state } = setup();
    state.presence = { notificationState: 3, idleSeconds: 0, micApps: [] };
    center.add([note('1'), note('2', { title: 'GitHub' })]);
    await center.tick();
    expect(state.said).toEqual([]);
    expect(center.holdReason).toBe('fullscreen');

    state.presence = { notificationState: 5, idleSeconds: 0, micApps: [] };
    state.now += 3000;
    await center.tick(); // Just back: wait a moment.
    expect(state.said).toEqual([]);
    state.now += 3000;
    await center.tick();
    expect(state.said).toEqual(['While you were busy: 2 new emails, from Sam and GitHub.']);
    expect(center.holdReason).toBeNull();
  });

  it('holds while another app uses the microphone, but not for AI-DA itself', async () => {
    const { center, state } = setup();
    state.presence = { notificationState: 5, idleSeconds: 0, micApps: [OWN] };
    center.add([note('1')]);
    await center.tick();
    expect(state.said).toHaveLength(1);

    state.presence = {
      notificationState: 5,
      idleSeconds: 0,
      micApps: [OWN, 'C:#Users#me#AppData#Local#Discord#app-1.0.9220#Discord.exe'],
    };
    center.add([note('2')]);
    await center.tick();
    expect(state.said).toHaveLength(1);
    expect(center.holdReason).toBe('call');
    expect(center.heldBy).toBe('Discord');
  });

  it('waits while the user is away and while Aida is busy', async () => {
    const { center, state } = setup();
    state.presence = { notificationState: 5, idleSeconds: 600, micApps: [] };
    center.add([note('1')]);
    await center.tick();
    expect(center.holdReason).toBe('away');

    state.presence = { notificationState: 5, idleSeconds: 1, micApps: [] };
    state.free = false;
    state.now += 10_000;
    await center.tick();
    expect(center.holdReason).toBe('aida-busy');
    state.free = true;
    await center.tick();
    expect(state.said).toEqual(['While you were away: email from Sam: Mail 1.']);
  });

  it('reads right away with holding turned off, even in a full-screen app', async () => {
    const { center, state } = setup({ holdWhenBusy: false });
    state.presence = { notificationState: 2, idleSeconds: 900, micApps: ['x.exe'] };
    center.add([note('1')]);
    await center.tick();
    expect(state.said).toHaveLength(1);
  });

  it('drops reminders that are out of date by the time it could speak', async () => {
    const { center, state } = setup();
    state.presence = { notificationState: 3, idleSeconds: 0, micApps: [] };
    center.add([
      note('meeting', {
        source: 'calendar',
        title: 'Standup',
        detail: '',
        startsAt: T0 + 60_000,
        expiresAt: T0 + 180_000,
      }),
      note('mail'),
    ]);
    await center.tick();
    state.now = T0 + 10 * 60_000;
    state.presence = { notificationState: 5, idleSeconds: 0, micApps: [] };
    await center.tick();
    state.now += 5000;
    await center.tick();
    expect(state.said).toEqual(['While you were busy: email from Sam: Mail mail.']);
    expect(center.recent().find((n) => n.id === 'meeting')!.state).toBe('missed');
  });

  it('stays quiet while muted and keeps everything for "what did I miss"', async () => {
    const { center, state } = setup();
    center.mute(T0 + 60 * 60_000);
    center.add([note('1'), note('2')]);
    await center.tick();
    expect(state.said).toEqual([]);
    expect(center.holdReason).toBe('muted');
    expect(center.takeUnheard().map((n) => n.id)).toEqual(['1', '2']);
    expect(center.pendingCount).toBe(0);
    expect(center.takeUnheard()).toEqual([]);
  });

  it('shows them as a Windows notification when Aida can’t talk', async () => {
    const { center, state } = setup();
    state.canTalk = false;
    center.add([note('1')]);
    await center.tick();
    expect(state.shown).toEqual(['Email from Sam: Mail 1.']);
    expect(center.pendingCount).toBe(0);
  });

  it('ignores new notifications while turned off', () => {
    const { center } = setup({ enabled: false });
    center.add([note('1')]);
    expect(center.recent()).toEqual([]);
  });

  it('knows full-screen, locked and away states from Windows', () => {
    const own = () => false;
    expect(busyReason({ notificationState: 1, idleSeconds: 0, micApps: [] }, own)).toBe('away');
    for (const s of [2, 3, 4, 7])
      expect(busyReason({ notificationState: s, idleSeconds: 0, micApps: [] }, own)).toBe(
        'fullscreen',
      );
    expect(busyReason({ notificationState: 5, idleSeconds: 299, micApps: [] }, own)).toBeNull();
    expect(busyReason({ notificationState: 6, idleSeconds: 0, micApps: [] }, own)).toBeNull();
    expect(busyReason(null, own)).toBeNull();
    expect(micAppName('Microsoft.SkypeApp_kzf8qxf38zg5c')).toBe('SkypeApp');
    expect(micAppName('C:#Program Files#Zoom#bin#Zoom.exe')).toBe('Zoom');
  });
});

describe('NotificationService', () => {
  function service(
    options: { connected?: boolean; granted?: { gmail: boolean; calendar: boolean } | null } = {},
  ) {
    const state = { now: T0, gmailChecks: 0, calendarRefreshes: 0, gmailError: null as unknown };
    const { center } = setup();
    const gmail = {
      reset() {},
      async check() {
        state.gmailChecks++;
        if (state.gmailError) throw state.gmailError;
        return [note(`g${state.gmailChecks}`)];
      },
    } as unknown as GmailWatcher;
    const calendar = {
      reset() {},
      async refresh() {
        state.calendarRefreshes++;
      },
      due: () => [],
    } as unknown as CalendarWatcher;
    const svc = new NotificationService({
      google: { connected: () => options.connected ?? true },
      gmail,
      calendar,
      center,
      settings: () => ({ enabled: true, gmail: 'primary', calendarMinutes: 10 }),
      granted: () =>
        options.granted === undefined ? { gmail: true, calendar: true } : options.granted,
      now: () => state.now,
    });
    return { svc, state, center };
  }

  it('checks Gmail every minute and Calendar every ten', async () => {
    const { svc, state, center } = service();
    await svc.poll();
    state.now += 30_000;
    await svc.poll();
    expect([state.gmailChecks, state.calendarRefreshes]).toEqual([1, 1]);
    state.now += 31_000;
    await svc.poll();
    expect([state.gmailChecks, state.calendarRefreshes]).toEqual([2, 1]);
    state.now += 10 * 60_000;
    await svc.poll();
    expect(state.calendarRefreshes).toBe(2);
    expect(center.recent()).toHaveLength(3);
  });

  it("does nothing until Google is connected, and skips what wasn't allowed", async () => {
    const off = service({ connected: false });
    await off.svc.poll();
    expect(off.state.gmailChecks).toBe(0);
    const noGmail = service({ granted: { gmail: false, calendar: true } });
    await noGmail.svc.poll();
    expect([noGmail.state.gmailChecks, noGmail.state.calendarRefreshes]).toEqual([0, 1]);
  });

  it('backs off after an error, shows it, and says once that the sign-in expired', async () => {
    const { svc, state, center } = service();
    state.gmailError = new GoogleError(401, 'The Google sign-in expired.', 'expired');
    await svc.poll();
    expect(svc.snapshotParts().error).toBe('The Google sign-in expired. Connect again.');
    expect(center.recent().map((n) => n.title)).toEqual(['Your Google sign-in expired']);
    state.now += 2 * 60_000;
    await svc.poll();
    expect(state.gmailChecks).toBe(1); // Waits 5 minutes after a failure.
    state.now += 4 * 60_000;
    await svc.poll();
    expect(state.gmailChecks).toBe(2);
    expect(center.recent().filter((n) => n.source === 'system')).toHaveLength(1);
    state.gmailError = null;
    state.now += 5 * 60_000;
    await svc.poll();
    expect(svc.snapshotParts().error).toBeNull();
  });

  it('explains fixable Google errors', () => {
    expect(
      describeError(
        new GoogleError(403, 'Gmail API has not been used in project 1', 'accessNotConfigured'),
        'gmail',
      ),
    ).toMatch(/Turn on the Gmail API/);
    expect(
      describeError(new GoogleError(403, 'nope', 'insufficientPermissions'), 'calendar'),
    ).toMatch(/tick every box/);
    expect(describeError(new TypeError('fetch failed'), 'gmail')).toBe(
      "Couldn't reach Gmail. Check your connection.",
    );
  });
});
