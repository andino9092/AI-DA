import { z } from 'zod';
import {
  NoMediaSessionError,
  type MediaCommand,
  type MediaSession,
  type WindowsBridge,
} from '../../native/win-host';
import { defineTool } from '../types';

const ACTIONS = ['play', 'pause', 'toggle', 'next', 'previous', 'stop'] as const;

/** "Spotify.exe" → "Spotify"; Store ids → their app name; browser ids → "your browser". */
export function mediaAppName(appId: string): string {
  if (/^[0-9A-F]{16}$/i.test(appId) || /^(?:chrome|msedge|brave|firefox|opera)/i.test(appId))
    return 'your browser';
  const afterBang = appId.includes('!') ? appId.slice(appId.indexOf('!') + 1) : appId;
  const name =
    afterBang
      .replace(/\.exe$/i, '')
      .split('.')
      .at(-1) ?? afterBang;
  return name === 'ZuneMusic' ? 'Media Player' : name;
}

function track(s: Pick<MediaSession, 'title' | 'artist'>): string {
  if (!s.title) return '';
  return s.artist ? `${s.title} by ${s.artist}` : s.title;
}

function spoken(action: MediaCommand, s: MediaSession & { accepted: boolean }): string {
  const what = track(s);
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

/** Matches Windows' app id by name: "spotify" → "Spotify.exe". */
function appFilter(app: string | undefined): string | undefined {
  const cleaned = app
    ?.toLowerCase()
    .replace(/\b(?:the|app|music|player)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return cleaned || undefined;
}

export function mediaTools(win: WindowsBridge) {
  return [
    defineTool({
      name: 'media_control',
      description:
        'Play, pause, skip or go back in whatever is playing media (Spotify, YouTube in a browser, etc.). Use explicit play or pause, not toggle, when the user says which. Set app only if the user names one.',
      risk: 'safe',
      input: z.object({
        action: z.enum(ACTIONS),
        app: z.string().min(1).optional().describe('App to control, e.g. "Spotify"'),
      }),
      describe: ({ action, app }) => `Media: ${action}${app ? ` in ${app}` : ''}`,
      run: async ({ action, app }) => {
        try {
          const state = await win.mediaControl(action, appFilter(app));
          if (!state.accepted)
            return {
              ok: false,
              speak: `${mediaAppName(state.appId)} didn't accept that.`,
              followUp: true,
            };
          return { ok: true, speak: spoken(action, state) };
        } catch (err) {
          if (!(err instanceof NoMediaSessionError)) throw err;
          if (app)
            return {
              ok: false,
              speak: `${app} isn't open or hasn't played anything yet.`,
              followUp: true,
            };
          // No app has reported a media session: fall back to the keyboard's media keys.
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
          const app = mediaAppName(playing.appId);
          return {
            ok: true,
            speak: what ? `${what}, on ${app}.` : `Something is playing on ${app}.`,
          };
        }
        const paused = sessions.find((s) => s.current) ?? sessions[0];
        if (paused && track(paused))
          return {
            ok: true,
            speak: `Nothing is playing. ${track(paused)} is paused on ${mediaAppName(paused.appId)}.`,
          };
        return { ok: true, speak: 'Nothing is playing right now.' };
      },
    }),
  ];
}
