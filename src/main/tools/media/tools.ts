import { z } from 'zod';
import {
  NoMediaSessionError,
  type MediaCommand,
  type MediaSession,
  type WindowInfo,
  type WindowsBridge,
} from '../../native/win-host';
import { matchScore, normalizeName } from '../../util/fuzzy';
import { findWindow } from '../windows/tools';
import type { ToolResult } from '../types';
import { defineTool } from '../types';

const ACTIONS = ['play', 'pause', 'toggle', 'next', 'previous', 'stop'] as const;
const MATCH_THRESHOLD = 0.6;

export interface MediaDeps {
  win: WindowsBridge;
  /** Start-menu name for a Windows app id (Zen's media sessions report only an id). */
  appName?: (appId: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
}

const BROWSER_NAMES =
  /^(?:zen|firefox|mozilla firefox|chrome|google chrome|edge|microsoft edge|msedge|brave|opera|vivaldi|arc|librewolf|waterfox|floorp)\b/i;
/** Ways people refer to "whatever is playing in my browser". */
const BROWSER_WORDS =
  /^(?:(?:my |the |web )?browser|youtube|twitch|netflix|the video|video|youtube video)$/i;
/** Sites where pressing a key in the page is known to play or pause. */
const MEDIA_SITES = /youtube|twitch|netflix|prime video|disney\+|vimeo|soundcloud|spotify/i;

/** "Spotify.exe" → "Spotify"; Store ids → their app name; unknown browser ids → "your browser". */
export function mediaAppName(appId: string): string {
  if (/^[0-9A-F]{16}/i.test(appId) || /^(?:chrome|msedge|brave|firefox|opera)/i.test(appId))
    return 'your browser';
  const afterBang = appId.includes('!') ? appId.slice(appId.indexOf('!') + 1) : appId;
  const name =
    afterBang
      .replace(/\.exe$/i, '')
      .split(/[.\\]/)
      .at(-1) ?? afterBang;
  return name === 'ZuneMusic' ? 'Media Player' : name;
}

function isBrowserSession(appId: string, name: string): boolean {
  return (
    /^[0-9A-F]{16}/i.test(appId) ||
    /chrome|msedge|brave|firefox|opera/i.test(appId) ||
    BROWSER_NAMES.test(name)
  );
}

function track(s: Pick<MediaSession, 'title' | 'artist'>): string {
  if (!s.title) return '';
  return s.artist ? `${s.title} by ${s.artist}` : s.title;
}

function spoken(action: MediaCommand, s: MediaSession & { trackChanged?: boolean }): string {
  const what = track(s);
  // The app never reported a new track: don't name the one that was just skipped.
  if (action === 'next' && s.trackChanged === false) return 'Skipped.';
  if (action === 'previous' && s.trackChanged === false)
    return what ? `Back to the start of ${what}.` : 'Went back to the start.';
  switch (action) {
    case 'play':
      return what ? `Playing ${what}.` : 'Playing.';
    case 'pause':
      return 'Paused.';
    case 'toggle':
      return s.status === 'playing' ? (what ? `Playing ${what}.` : 'Playing.') : 'Paused.';
    case 'next':
      return what ? `Next up: ${what}.` : 'Skipped.';
    case 'previous':
      return what ? `Back to ${what}.` : 'Went back a track.';
    case 'stop':
      return 'Stopped.';
  }
}

/** "(1) Some Video | Channel - YouTube — Zen Browser" → "Some Video | Channel". */
export function pageTitle(windowTitle: string): string {
  return windowTitle
    .replace(
      /\s+[—–-]\s+(?:[^—–-]+\s+[—–-]\s+)?(?:Zen Browser|Mozilla Firefox|Firefox|Google Chrome|Microsoft.? Edge|Brave|Opera|Vivaldi)$/i,
      '',
    )
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s+-\s+(?:YouTube|Twitch|Netflix)$/i, '')
    .trim();
}

/** Whether a media session's title is the page shown in this browser window. */
export function isOnPage(sessionTitle: string, windowTitle: string): boolean {
  const media = normalizeName(sessionTitle);
  const page = normalizeName(pageTitle(windowTitle));
  if (!media || !page) return false;
  return page.includes(media) || media.includes(page);
}

/** "the Zen browser", "my Spotify app" → "Zen", "Spotify" (a bare "browser" stays as is). */
function cleanAppName(app: string): string {
  return app
    .trim()
    .replace(/^(?:the|my)\s+/i, '')
    .replace(/^(.+?)\s+(?:browser|app)$/i, '$1');
}

/**
 * The media session someone means by "Spotify", "Zen", "my browser" or "YouTube". Among several
 * matches, one that's playing wins (for pause), else the one Windows shows, else the first.
 */
export function pickSession(
  sessions: MediaSession[],
  app: string,
  nameOf: (appId: string) => string,
): MediaSession | null {
  const wanted = cleanAppName(app);
  const matches = BROWSER_WORDS.test(wanted)
    ? sessions.filter((s) => isBrowserSession(s.appId, nameOf(s.appId)))
    : sessions.filter(
        (s) =>
          Math.max(
            matchScore(wanted, nameOf(s.appId)),
            matchScore(wanted, mediaAppName(s.appId)),
          ) >= MATCH_THRESHOLD,
      );
  return (
    matches.find((s) => s.status === 'playing') ??
    matches.find((s) => s.current) ??
    matches[0] ??
    null
  );
}

export function mediaTools({ win, appName, sleep = defaultSleep }: MediaDeps) {
  const nameOf = (appId: string) =>
    appName?.(appId)?.replace(/ Private Browsing$/, '') ?? mediaAppName(appId);

  /** The window a media request is about: the named app's, or a browser showing a media site. */
  async function mediaWindow(app: string): Promise<WindowInfo | null> {
    const windows = await win.listWindows();
    return BROWSER_WORDS.test(app)
      ? (windows.find((w) => MEDIA_SITES.test(w.title) && BROWSER_NAMES.test(w.process)) ??
          windows.find((w) => BROWSER_NAMES.test(w.process)) ??
          null)
      : findWindow(windows, cleanAppName(app));
  }

  /**
   * Play the video on the page itself: for a video that was never started (the browser hasn't
   * registered it) or when the browser's session belongs to another tab. Brings the window
   * forward and presses the page's own play key.
   */
  async function pressPlayInWindow(app: string, known?: WindowInfo): Promise<ToolResult | null> {
    const window = known ?? (await mediaWindow(app));
    if (!window) return null;
    const browser = BROWSER_NAMES.test(window.process);
    // In a browser, only on sites where the key is known to mean play/pause.
    if (browser && !MEDIA_SITES.test(window.title)) return null;

    await win.windowAction(window.handle, 'focus');
    await sleep(250);
    let focused = await win.focusedElement();
    // Focus in the address bar or a search box: F6 moves it back to the page.
    for (let i = 0; i < 2 && ['edit', 'combobox'].includes(focused.role); i++) {
      if (focused.password) return null;
      await win.sendKeys('f6');
      await sleep(150);
      focused = await win.focusedElement();
    }
    if (focused.password || ['edit', 'combobox'].includes(focused.role)) return null;

    await win.sendKeys(/youtube/i.test(window.title) ? 'k' : 'space');
    await sleep(900);
    const label = window.process.charAt(0).toUpperCase() + window.process.slice(1);
    const session = pickSession(await win.mediaSessions(), window.process, nameOf);
    // Only name the video if it's the one on the page (the session can be another tab's).
    if (session?.status === 'playing' && (!browser || isOnPage(session.title, window.title)))
      return { ok: true, speak: spoken('play', session) };
    return { ok: true, speak: `I pressed play in ${label}.` };
  }

  return [
    defineTool({
      name: 'media_control',
      description:
        'Play, pause, skip or go back in whatever is playing media (Spotify, a YouTube video in a browser, etc.). Use explicit play or pause, not toggle, when the user says which. Set app when the user names one; for a video in a browser, set app to the browser name (e.g. "Zen") or "browser".',
      risk: 'safe',
      input: z.object({
        action: z.enum(ACTIONS),
        app: z
          .string()
          .min(1)
          .optional()
          .describe('App to control, e.g. "Spotify", "Zen", or "browser"'),
      }),
      describe: ({ action, app }) => `Media: ${action}${app ? ` in ${app}` : ''}`,
      run: async ({ action, app }) => {
        if (app) {
          const session = pickSession(await win.mediaSessions(), app, nameOf);
          // A browser has one media session, and it can belong to another tab or a feed preview
          // rather than the video on screen. If the page shows a different video, play that one.
          if (
            session &&
            (action === 'play' || action === 'toggle') &&
            isBrowserSession(session.appId, nameOf(session.appId))
          ) {
            const window = await mediaWindow(BROWSER_WORDS.test(app) ? app : nameOf(session.appId));
            if (
              window &&
              BROWSER_NAMES.test(window.process) &&
              MEDIA_SITES.test(window.title) &&
              !isOnPage(session.title, window.title)
            ) {
              const pressed = await pressPlayInWindow(app, window);
              if (pressed) return pressed;
            }
          }
          if (session) {
            const state = await win.mediaControl(action, session.appId);
            if (!state.accepted)
              return {
                ok: false,
                speak: `${nameOf(state.appId)} didn't accept that.`,
                followUp: true,
              };
            return { ok: true, speak: spoken(action, state) };
          }
          // No session means nothing is playing there, so only "play" needs the key (the key
          // toggles, so pressing it for "pause" would start the video).
          if (action === 'play' || action === 'toggle') {
            const pressed = await pressPlayInWindow(app);
            if (pressed) return pressed;
          }
          return {
            ok: false,
            speak: `${app} isn't open or hasn't played anything yet.`,
            followUp: true,
          };
        }
        try {
          const state = await win.mediaControl(action);
          if (!state.accepted)
            return {
              ok: false,
              speak: `${nameOf(state.appId)} didn't accept that.`,
              followUp: true,
            };
          return { ok: true, speak: spoken(action, state) };
        } catch (err) {
          if (!(err instanceof NoMediaSessionError)) throw err;
          // No app has reported a media session: a video page that was never started, or an app
          // that doesn't report sessions. Try the page's own key, then the keyboard's media key.
          if (action === 'play' || action === 'toggle') {
            const pressed = await pressPlayInWindow('browser');
            if (pressed) return pressed;
          }
          const key = action === 'play' || action === 'pause' ? 'play_pause' : action;
          await win.mediaKey(key === 'toggle' ? 'play_pause' : key);
          return { ok: true, speak: 'Okay.' };
        }
      },
    }),
    defineTool({
      name: 'now_playing',
      description: 'Say what song or video is playing, and in which app.',
      risk: 'safe',
      input: z.object({}),
      describe: () => "Check what's playing",
      run: async () => {
        const sessions = await win.mediaSessions();
        const playing =
          sessions.find((s) => s.status === 'playing' && s.current) ??
          sessions.find((s) => s.status === 'playing');
        if (playing) {
          const what = track(playing);
          const app = nameOf(playing.appId);
          return {
            ok: true,
            speak: what ? `${what}, on ${app}.` : `Something is playing on ${app}.`,
          };
        }
        const paused = sessions.find((s) => s.current) ?? sessions[0];
        if (paused && track(paused))
          return {
            ok: true,
            speak: `Nothing is playing. ${track(paused)} is paused on ${nameOf(paused.appId)}.`,
          };
        return { ok: true, speak: 'Nothing is playing right now.' };
      },
    }),
  ];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
