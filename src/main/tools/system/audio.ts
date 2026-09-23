import { z } from 'zod';
import type { WindowsBridge } from '../../native/win-host';
import { defineTool } from '../types';

const MEDIA_SPEECH = {
  play_pause: 'Okay.',
  next: 'Skipping to the next track.',
  previous: 'Going back a track.',
  stop: 'Stopped.',
} as const;

export function audioTools(win: WindowsBridge) {
  return [
    defineTool({
      name: 'set_volume',
      description: 'Set the system volume to an exact percentage.',
      risk: 'safe',
      input: z.object({
        level: z.number().int().min(0).max(100).describe('Volume percentage 0-100'),
      }),
      describe: ({ level }) => `Set volume to ${level}%`,
      run: async ({ level }) => {
        const state = await win.setVolume(level);
        if (state.muted) await win.setMuted(false);
        return { ok: true, speak: `Volume set to ${state.level}%.` };
      },
    }),
    defineTool({
      name: 'change_volume',
      description: 'Raise or lower the system volume by a relative amount (e.g. +10 or -20).',
      risk: 'safe',
      input: z.object({
        delta: z
          .number()
          .int()
          .min(-100)
          .max(100)
          .describe('Percentage points; positive is louder'),
      }),
      describe: ({ delta }) => `${delta >= 0 ? 'Raise' : 'Lower'} volume by ${Math.abs(delta)}%`,
      run: async ({ delta }) => {
        const current = await win.getVolume();
        const state = await win.setVolume(current.level + delta);
        if (delta > 0 && state.muted) await win.setMuted(false);
        return { ok: true, speak: `Volume ${delta >= 0 ? 'up' : 'down'} to ${state.level}%.` };
      },
    }),
    defineTool({
      name: 'set_mute',
      description: 'Mute or unmute the system audio.',
      risk: 'safe',
      input: z.object({ muted: z.boolean() }),
      describe: ({ muted }) => (muted ? 'Mute audio' : 'Unmute audio'),
      run: async ({ muted }) => {
        await win.setMuted(muted);
        return { ok: true, speak: muted ? 'Muted.' : 'Unmuted.' };
      },
    }),
    defineTool({
      name: 'get_volume',
      description: 'Read the current system volume and mute state.',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'Check the volume',
      run: async () => {
        const { level, muted } = await win.getVolume();
        return {
          ok: true,
          speak: `Volume is at ${level}%${muted ? ', and muted' : ''}.`,
          data: { level, muted },
        };
      },
    }),
    defineTool({
      name: 'media_control',
      description:
        'Control whatever media is playing (Spotify, YouTube, etc.) with the system media keys. play_pause toggles.',
      risk: 'safe',
      input: z.object({ action: z.enum(['play_pause', 'next', 'previous', 'stop']) }),
      describe: ({ action }) => `Media: ${action.replace('_', '/')}`,
      run: async ({ action }) => {
        await win.mediaKey(action);
        return { ok: true, speak: MEDIA_SPEECH[action] };
      },
    }),
  ];
}
