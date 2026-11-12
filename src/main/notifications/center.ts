import type { AidaNotification, HoldReason } from '@shared/notifications';
import type { Presence } from '../native/win-host';
import { describe } from './format';

/** Most notifications kept for Settings and "what did I miss". */
const MAX_HISTORY = 50;
/** No keyboard or mouse input for this long counts as away from the PC. */
export const AWAY_AFTER_SECONDS = 5 * 60;
/** After being busy or away, wait this long before talking (they just sat down, the call ended). */
const SETTLE_MS = 4000;

export interface CenterDeps {
  /** Settings → Notifications is on. */
  enabled(): boolean;
  /** Hold while in a full-screen app, on a call or away, then sum up. */
  holdWhenBusy(): boolean;
  /** Null if Windows couldn't be asked; then it's treated as a good moment. */
  presence(): Promise<Presence | null>;
  voice: {
    /** Not listening, thinking or talking. */
    readonly free: boolean;
    /** The voice is installed and replies are read aloud. */
    readonly canTalk: boolean;
    /** Speaks if Aida is free right now; false means try again later. */
    notify(text: string): boolean;
  };
  /** When Aida can't talk (voice off): show it as a Windows notification instead. */
  show(text: string): void;
  /** Whether a microphone user is AI-DA itself (its echo canceller or audio window). */
  isOwnMicApp(app: string): boolean;
  changed?(): void;
  now?: () => number;
}

/** Why now isn't a good moment, from what Windows says. */
export function busyReason(
  presence: Presence | null,
  isOwnMicApp: (app: string) => boolean,
): HoldReason {
  if (!presence) return null;
  if (presence.notificationState === 1) return 'away';
  if ([2, 3, 4, 7].includes(presence.notificationState)) return 'fullscreen';
  if (presence.micApps.some((app) => !isOwnMicApp(app))) return 'call';
  if (presence.idleSeconds >= AWAY_AFTER_SECONDS) return 'away';
  return null;
}

/** "C:#Users#me#AppData#Local#Discord#app-1.0#Discord.exe" → "Discord"; Store app ids too. */
export function micAppName(app: string): string {
  const last = app.split('#').pop() ?? app;
  return last
    .replace(/\.exe$/i, '')
    .replace(/_[a-z0-9]{13}$/i, '')
    .replace(/^Microsoft\./, '')
    .split('.')
    .pop()!;
}

/**
 * Collects notifications and reads them out at a good moment: Aida is idle, and (unless the user
 * turned holding off) they're not in a full-screen app or game, not on a call and not away. What
 * piled up meanwhile is summed up in one go ("While you were busy: 3 new emails…"). Reminders
 * that are out of date by then are dropped, but stay in the history.
 */
export class NotificationCenter {
  private items: AidaNotification[] = [];
  private mutedUntil: number | null = null;
  private held: HoldReason = null;
  private heldApp: string | null = null;
  /** Busy or away while something was waiting: the next reading starts with "While you were…". */
  private heldFor: HoldReason = null;
  private lastBusyAt = 0;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly deps: CenterDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** New notifications (oldest first) from Gmail or Calendar; ones already known are ignored. */
  add(found: readonly AidaNotification[]): void {
    if (!this.deps.enabled()) return;
    const known = new Set(this.items.map((i) => i.id));
    const fresh = found.filter((f) => !known.has(f.id));
    if (fresh.length === 0) return;
    // History is newest first.
    this.items = [...fresh.map((f) => ({ ...f })).reverse(), ...this.items].slice(0, MAX_HISTORY);
    this.deps.changed?.();
  }

  /** Newest first. */
  recent(): AidaNotification[] {
    return this.items.map((i) => ({ ...i }));
  }

  get pendingCount(): number {
    return this.items.filter((i) => i.state === 'pending').length;
  }

  get holdReason(): HoldReason {
    return this.pendingCount > 0 ? this.held : null;
  }

  /** While held for a call: the app using the microphone. */
  get heldBy(): string | null {
    return this.holdReason === 'call' ? this.heldApp : null;
  }

  get muteEnd(): number | null {
    return this.mutedUntil !== null && this.mutedUntil > this.now() ? this.mutedUntil : null;
  }

  /** Quiet until then (ms), or null to talk again. Waiting notifications stay for later. */
  mute(until: number | null): void {
    this.mutedUntil = until;
    this.deps.changed?.();
  }

  /**
   * "What did I miss?": everything not read out yet (oldest first), now counted as heard. Empty
   * if there's nothing new.
   */
  takeUnheard(): AidaNotification[] {
    const unheard = this.items.filter((i) => i.state !== 'heard').reverse();
    for (const item of this.items) item.state = 'heard';
    if (unheard.length > 0) {
      this.heldFor = null;
      this.deps.changed?.();
    }
    return unheard.map((i) => ({ ...i }));
  }

  /** Drops everything (signed out, or notifications turned off). */
  clear(): void {
    this.items = [];
    this.heldFor = null;
    this.held = null;
    this.deps.changed?.();
  }

  /** Called every few seconds: reads out what's waiting if now is a good moment. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.deliver();
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const item of this.items)
      if (item.state === 'pending' && item.expiresAt !== undefined && item.expiresAt < now) {
        item.state = 'missed';
        changed = true;
      }
    const pending = this.items.filter((i) => i.state === 'pending').reverse();
    const hold = (reason: HoldReason) => {
      if (this.held !== reason) changed = true;
      this.held = reason;
    };

    if (pending.length === 0) hold(null);
    else if (!this.deps.enabled() || this.muteEnd !== null) hold('muted');
    else if (!this.deps.voice.canTalk) {
      // Voice off: show it instead, and count it as seen.
      this.deps.show(describe(pending, now));
      for (const item of pending) item.state = 'heard';
      this.heldFor = null;
      hold(null);
    } else {
      const presence = this.deps.holdWhenBusy()
        ? await this.deps.presence().catch(() => null)
        : null;
      const reason = busyReason(presence, this.deps.isOwnMicApp);
      const micApp = presence?.micApps.find((app) => !this.deps.isOwnMicApp(app));
      this.heldApp = micApp ? micAppName(micApp) : null;
      if (reason) {
        this.lastBusyAt = now;
        this.heldFor = reason;
        hold(reason);
      } else if (this.heldFor && now - this.lastBusyAt < SETTLE_MS) hold(this.heldFor);
      else if (!this.deps.voice.free) hold('aida-busy');
      else {
        // The moment may have passed while Windows was being asked.
        const text = describe(pending, this.now(), this.heldFor);
        if (this.deps.voice.notify(text)) {
          for (const item of pending) item.state = 'heard';
          this.heldFor = null;
          hold(null);
          changed = true;
        } else hold('aida-busy');
      }
    }
    if (changed) this.deps.changed?.();
  }
}
