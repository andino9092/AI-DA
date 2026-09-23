import { z } from 'zod';
import type { WindowAction, WindowInfo, WindowsBridge } from '../../native/win-host';
import { matchSensitiveApp } from '../../privacy/sensitive-apps';
import { matchScore } from '../../util/fuzzy';
import { defineTool } from '../types';

const ACTIONS = [
  'focus',
  'minimize',
  'maximize',
  'restore',
  'snap_left',
  'snap_right',
  'next_monitor',
] as const satisfies readonly WindowAction[];

const PAST_TENSE: Record<(typeof ACTIONS)[number], string> = {
  focus: 'Switched to',
  minimize: 'Minimized',
  maximize: 'Maximized',
  restore: 'Restored',
  snap_left: 'Snapped left:',
  snap_right: 'Snapped right:',
  next_monitor: 'Moved to the next monitor:',
};

const WINDOW_MATCH_THRESHOLD = 0.6;

export function label(w: WindowInfo): string {
  return w.process ? w.process.charAt(0).toUpperCase() + w.process.slice(1) : w.title;
}

export function findWindow(windows: WindowInfo[], query: string): WindowInfo | null {
  let best: { w: WindowInfo; score: number } | null = null;
  for (const w of windows) {
    const score = Math.max(matchScore(query, w.process), matchScore(query, w.title) * 0.95);
    if (!best || score > best.score) best = { w, score };
  }
  return best && best.score >= WINDOW_MATCH_THRESHOLD ? best.w : null;
}

export function windowTools(win: WindowsBridge, sensitiveApps: () => readonly string[] = () => []) {
  return [
    defineTool({
      name: 'window_action',
      description:
        'Focus, minimize, maximize, restore, snap left/right, or move to the next monitor. Omit target for the window the user was just using.',
      risk: 'safe',
      input: z.object({
        action: z.enum(ACTIONS),
        target: z
          .string()
          .min(1)
          .optional()
          .describe('App or window name; omit for the active window'),
      }),
      describe: ({ action, target }) =>
        `${action.replace('_', ' ')} ${target ?? 'the active window'}`,
      run: async ({ action, target }, ctx) => {
        const windows = await win.listWindows();
        const window = target
          ? findWindow(windows, target)
          : (windows.find((w) => w.handle === ctx.activeWindow) ?? null);
        if (!window) {
          return {
            ok: false,
            speak: target
              ? `I couldn't find a window for ${target}.`
              : "I'm not sure which window you mean.",
            data: { openWindows: windows.map((w) => label(w)) },
            followUp: true,
          };
        }
        const done = await win.windowAction(window.handle, action);
        if (!done && action === 'next_monitor')
          return { ok: false, speak: 'You only have one monitor.' };
        return { ok: true, speak: `${PAST_TENSE[action]} ${label(window)}.` };
      },
    }),
    defineTool({
      name: 'list_windows',
      description: 'List open windows (app and title). Use to find the right target.',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'List open windows',
      run: async () => {
        const windows = await win.listWindows();
        return {
          ok: true,
          speak: `${windows.length} windows are open.`,
          data: {
            windows: windows.map((w) => ({
              app: w.process,
              // Titles can show what's inside (a vault name, a bank page): hide them for sensitive apps.
              title: matchSensitiveApp(w, sensitiveApps()) ? '(hidden: sensitive app)' : w.title,
              minimized: w.minimized,
            })),
          },
          followUp: true,
        };
      },
    }),
  ];
}
