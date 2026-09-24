import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from '../types';

export interface Timer {
  id: string;
  /** What to remind about ("take out the laundry"); empty for a plain timer. */
  label: string;
  durationMs: number;
  endsAt: number;
}

const MAX_TIMERS = 20;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** A timer that went off while AI-DA was closed is still announced if it's this recent. */
const LATE_GRACE_MS = 10 * 60 * 1000;

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty five': 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};

const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000 };

/**
 * "10 minutes", "an hour and a half", "1.5 hours", "90 seconds", "two minutes 30 seconds",
 * "half an hour" → milliseconds. Null if there's no duration in the text.
 */
export function parseDuration(text: string): number | null {
  let t = ` ${text.toLowerCase().replace(/-/g, ' ')} `;
  // "twenty five" → "25" (speech recognition usually writes digits, but not always).
  t = t.replace(
    /\b(twenty|thirty|forty|fifty) (one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_, tens: string, ones: string) => String(NUMBER_WORDS[tens]! + NUMBER_WORDS[ones]!),
  );
  t = t.replace(/\bhalf an? hour\b/g, '30 minutes');
  t = t.replace(/\ba quarter of an hour\b/g, '15 minutes');
  let total = 0;
  let found = false;
  const re =
    /\b(\d+(?:\.\d+)?|forty five|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b(\s+and\s+a\s+half)?/g;
  for (const m of t.matchAll(re)) {
    const amount = /^\d/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!]!;
    const unit = m[2]!.startsWith('h') ? 'hour' : m[2]!.startsWith('m') ? 'minute' : 'second';
    total += (amount + (m[3] ? 0.5 : 0)) * UNIT_MS[unit]!;
    found = true;
  }
  return found && total > 0 ? Math.round(total) : null;
}

/** 90_000 → "1 minute 30 seconds"; 3_600_000 → "1 hour". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (hours) parts.push(part(hours, 'hour'));
  if (minutes) parts.push(part(minutes, 'minute'));
  // Seconds only matter for short timers.
  if (seconds && hours === 0 && minutes < 10) parts.push(part(seconds, 'second'));
  return parts.join(' ') || 'less than a second';
}

/**
 * Timers and reminders. Kept in a small local file so they survive a restart; a timer that went
 * off while AI-DA was closed is announced on the next start if it's recent.
 */
export class TimerService {
  private timers: Timer[] = [];
  private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly file: string,
    private readonly onFire: (timer: Timer, late: boolean) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Loads saved timers and schedules them. */
  start(): void {
    let saved: Timer[] = [];
    try {
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8')) as Timer[];
    } catch {
      saved = [];
    }
    const now = this.now();
    for (const timer of saved) {
      if (timer.endsAt > now) this.schedule(timer);
      else if (now - timer.endsAt < LATE_GRACE_MS) this.onFire(timer, true);
    }
    this.save();
  }

  list(): Timer[] {
    return [...this.timers].sort((a, b) => a.endsAt - b.endsAt);
  }

  add(durationMs: number, label = ''): Timer {
    if (this.timers.length >= MAX_TIMERS) throw new Error(`You already have ${MAX_TIMERS} timers.`);
    const timer: Timer = {
      id: randomUUID(),
      label: label.trim(),
      durationMs,
      endsAt: this.now() + durationMs,
    };
    this.schedule(timer);
    this.save();
    return timer;
  }

  /** Cancels timers whose label matches (or all when no label); returns how many. */
  cancel(label?: string): number {
    const wanted = label?.trim().toLowerCase();
    const cancelled = this.timers.filter((t) => !wanted || t.label.toLowerCase().includes(wanted));
    for (const t of cancelled) this.remove(t.id);
    this.save();
    return cancelled.length;
  }

  dispose(): void {
    for (const handle of this.handles.values()) clearTimeout(handle);
    this.handles.clear();
  }

  private schedule(timer: Timer): void {
    this.timers.push(timer);
    const handle = setTimeout(
      () => {
        this.remove(timer.id);
        this.save();
        this.onFire(timer, false);
      },
      Math.max(0, timer.endsAt - this.now()),
    );
    this.handles.set(timer.id, handle);
  }

  private remove(id: string): void {
    clearTimeout(this.handles.get(id));
    this.handles.delete(id);
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.timers));
    } catch {
      // Best effort: timers still work until AI-DA quits.
    }
  }
}

/** What Aida says when a timer goes off. */
export function timerMessage(timer: Timer, late: boolean): string {
  if (timer.label)
    return late
      ? `While AI-DA was closed, you had a reminder to ${timer.label}.`
      : `Reminder: ${timer.label}.`;
  const length = formatDuration(timer.durationMs);
  return late
    ? `Your ${length} timer went off while AI-DA was closed.`
    : `Your ${length} timer is done.`;
}

export function timerTools(timers: TimerService, now: () => number = Date.now) {
  return [
    defineTool({
      name: 'set_timer',
      description:
        'Start a countdown timer, optionally as a reminder ("remind me in 20 minutes to take out the laundry" → label "take out the laundry"). Duration is required; for a clock time, work out the minutes from now.',
      risk: 'safe',
      input: z.object({
        duration: z
          .string()
          .min(1)
          .describe('How long, in words like "10 minutes" or "1 hour 30 minutes"'),
        label: z.string().max(120).optional().describe('What the reminder is for'),
      }),
      describe: ({ duration, label }) => `Set a ${duration} timer${label ? ` for ${label}` : ''}`,
      run: async ({ duration, label }) => {
        const ms = parseDuration(duration);
        if (!ms)
          return {
            ok: false,
            speak: `I didn't understand “${duration}” as a time.`,
            followUp: true,
          };
        if (ms > MAX_DURATION_MS)
          return { ok: false, speak: 'Timers can be up to 24 hours long.', followUp: true };
        const timer = timers.add(ms, label);
        return {
          ok: true,
          speak: timer.label
            ? `Okay, I'll remind you in ${formatDuration(ms)}.`
            : `Timer set for ${formatDuration(ms)}.`,
        };
      },
    }),
    defineTool({
      name: 'list_timers',
      description: 'Say how much time is left on running timers and reminders.',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'Check timers',
      run: async () => {
        const list = timers.list();
        if (list.length === 0) return { ok: true, speak: "You don't have any timers running." };
        const left = (t: Timer) => formatDuration(t.endsAt - now());
        if (list.length === 1) {
          const t = list[0]!;
          return {
            ok: true,
            speak: t.label
              ? `${left(t)} until your reminder to ${t.label}.`
              : `${left(t)} left on your timer.`,
          };
        }
        return {
          ok: true,
          speak: `You have ${list.length} timers. The next one is done in ${left(list[0]!)}.`,
          data: { timers: list.map((t) => ({ label: t.label || 'timer', left: left(t) })) },
          followUp: true,
        };
      },
    }),
    defineTool({
      name: 'cancel_timer',
      description: 'Cancel running timers or reminders; give a label to cancel just that one.',
      risk: 'safe',
      input: z.object({ label: z.string().optional() }),
      describe: ({ label }) => `Cancel ${label ? `the ${label} timer` : 'timers'}`,
      run: async ({ label }) => {
        const count = timers.cancel(label);
        if (count === 0)
          return { ok: true, speak: label ? `No timer for ${label}.` : 'No timers were running.' };
        return { ok: true, speak: count === 1 ? 'Timer cancelled.' : `Cancelled ${count} timers.` };
      },
    }),
  ];
}
