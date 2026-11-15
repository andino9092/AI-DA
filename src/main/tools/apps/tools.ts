import { z } from 'zod';
import type { WindowInfo, WindowsBridge } from '../../native/win-host';
import { matchScore, normalizeName, rankByName } from '../../util/fuzzy';
import { defineTool } from '../types';
import { APP_MATCH_THRESHOLD, type AppIndex } from './app-index';

export interface Launcher {
  /** Launches a Start-menu app by its AppID (from the index, never free text). */
  launchApp(appId: string): void;
  openUrl(url: string): Promise<void>;
}

/** Accepts full http(s) URLs and bare domains like "github.com/foo". */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) && url.hostname !== 'localhost')
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Whether a window belongs to an app from the Start menu, judged by the process name: "Discord"
 * for Discord, "Code" for Visual Studio Code, "chrome" for Google Chrome. Strict on purpose: a
 * wrong match would bring up another app's window instead of launching the one asked for.
 */
const WINDOW_OF_APP = 0.85;
function isWindowOf(window: WindowInfo, appName: string): boolean {
  return window.process !== '' && matchScore(window.process, appName) >= WINDOW_OF_APP;
}

export function appTools(win: WindowsBridge, apps: AppIndex, launcher: Launcher) {
  return [
    defineTool({
      name: 'open_app',
      description:
        'Open an installed app by name (fuzzy matched against the Start menu). If it is already running, its window is brought to the front.',
      risk: 'safe',
      input: z.object({
        name: z.string().min(1).describe('App name as the user said it, e.g. "spotify"'),
      }),
      describe: ({ name }) => `Open ${name}`,
      run: async ({ name }) => {
        const matches = await apps.search(name, 3);
        const top = matches[0];
        if (!top || top.score < APP_MATCH_THRESHOLD) {
          return {
            ok: false,
            speak: `I couldn't find an app called ${name}.`,
            data: { suggestions: matches.map((m) => m.item.name) },
            followUp: true,
          };
        }
        // Already running? Then there is nothing to launch: bring its window up. An app closed
        // to the tray (Discord) keeps its main window hidden, and launching it again does nothing.
        const opened = { ok: true, speak: `Opening ${top.item.name}.` };
        try {
          const visible = (await win.listWindows()).find((w) => isWindowOf(w, top.item.name));
          if (visible) {
            await win.windowAction(visible.handle, 'focus');
            return opened;
          }
          // Stricter for hidden windows: background processes keep hidden windows that aren't
          // their interface (Explorer has several), so the title has to name the app too.
          const hidden = (await win.listHiddenWindows()).find(
            (w) =>
              isWindowOf(w, top.item.name) &&
              normalizeName(w.title).includes(normalizeName(top.item.name)),
          );
          if (hidden && (await win.showWindow(hidden.handle))) return opened;
        } catch {
          // Looking for a window is a shortcut; if it fails, launch as usual.
        }
        launcher.launchApp(top.item.appId);
        return opened;
      },
    }),
    defineTool({
      name: 'find_apps',
      description: 'Search installed apps by name. Use when unsure which app the user means.',
      risk: 'safe',
      input: z.object({ query: z.string().min(1) }),
      describe: ({ query }) => `Search apps for "${query}"`,
      run: async ({ query }) => {
        const matches = await apps.search(query, 8);
        return {
          ok: true,
          speak: matches.length ? `Found ${matches.length} apps.` : 'No matching apps.',
          data: { apps: matches.map((m) => m.item.name) },
          followUp: true,
        };
      },
    }),
    defineTool({
      name: 'close_app',
      description: 'Close all windows of a running app (it may ask to save unsaved work).',
      risk: 'confirm',
      input: z.object({ name: z.string().min(1) }),
      describe: ({ name }) => `Close ${name}`,
      run: async ({ name }) => {
        const windows = await win.listWindows();
        const ranked = rankByName(name, windows, (w) => w.process).concat(
          rankByName(name, windows, (w) => w.title),
        );
        ranked.sort((a, b) => b.score - a.score);
        const top = ranked[0];
        if (!top || top.score < APP_MATCH_THRESHOLD) {
          return { ok: false, speak: `${name} doesn't seem to be open.`, followUp: true };
        }
        const targets = windows.filter((w) => w.process === top.item.process);
        for (const w of targets) await win.windowAction(w.handle, 'close');
        return { ok: true, speak: `Closing ${top.item.process}.` };
      },
    }),
    defineTool({
      name: 'open_url',
      description: 'Open a website in the default browser.',
      risk: 'safe',
      input: z.object({ url: z.string().min(3).describe('Full URL or domain, e.g. github.com') }),
      describe: ({ url }) => `Open ${url}`,
      run: async ({ url }) => {
        const normalized = normalizeUrl(url);
        if (!normalized)
          return { ok: false, speak: `That doesn't look like a web address.`, followUp: true };
        await launcher.openUrl(normalized);
        return { ok: true, speak: `Opening ${new URL(normalized).hostname}.` };
      },
    }),
  ];
}
