import { z } from 'zod';
import { NoAppAudioError, type AudioDevice, type WindowsBridge } from '../../native/win-host';
import { matchScore } from '../../util/fuzzy';
import { defineTool } from '../types';

const MATCH_THRESHOLD = 0.6;

/** Words people use for kinds of output devices, matched against Windows' device names. */
const DEVICE_WORDS: Record<string, RegExp> = {
  headphones: /headphone|headset|earbud|buds|airpods|wh-|wf-/i,
  headset: /headset|headphone/i,
  speakers: /speaker/i,
  monitor: /nvidia high definition|amd high definition|intel.*display|hdmi|displayport/i,
  tv: /hdmi|tv/i,
};

/** Best device for "headphones", "my JBL", "the monitor". */
export function findDevice(devices: AudioDevice[], query: string): AudioDevice | null {
  const q = query
    .toLowerCase()
    .replace(/^(?:the|my)\s+/, '')
    .trim();
  let best: { d: AudioDevice; score: number } | null = null;
  for (const d of devices) {
    let score = matchScore(q, d.name);
    const kind = DEVICE_WORDS[q.replace(/s$/, '')] ?? DEVICE_WORDS[q];
    if (kind?.test(d.name)) score = Math.max(score, 0.85);
    if (!best || score > best.score) best = { d, score };
  }
  return best && best.score >= MATCH_THRESHOLD ? best.d : null;
}

/** "Speakers (JBL Flip 5)" → "JBL Flip 5 speakers"-ish short name for speech. */
function spokenDevice(name: string): string {
  const m = /^(.+?) \((.+)\)$/.exec(name);
  return m ? `${m[2]} ${m[1]!.toLowerCase()}` : name;
}

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
      name: 'set_app_volume',
      description:
        "Change one app's own volume or mute it (the Windows volume mixer), e.g. make Discord quieter or mute Chrome. Give level, muted, or both.",
      risk: 'safe',
      input: z.object({
        app: z.string().min(1).describe('App name, e.g. "Spotify"'),
        level: z.number().int().min(0).max(100).optional().describe('Volume percentage 0-100'),
        muted: z.boolean().optional(),
      }),
      describe: ({ app, level, muted }) =>
        `${muted === true ? 'Mute' : muted === false ? 'Unmute' : 'Set volume of'} ${app}${level !== undefined ? ` to ${level}%` : ''}`,
      run: async ({ app, level, muted }) => {
        const apps = await win.appAudio();
        let best: { process: string; score: number } | null = null;
        for (const a of apps) {
          const score = matchScore(app, a.process);
          if (!best || score > best.score) best = { process: a.process, score };
        }
        if (!best || best.score < MATCH_THRESHOLD)
          return {
            ok: false,
            speak: `${app} isn't playing any sound right now.`,
            data: { appsWithSound: apps.map((a) => a.process) },
            followUp: true,
          };
        try {
          const state = await win.setAppAudio(best.process, { level, muted });
          const speak =
            muted === true
              ? `Muted ${state.process}.`
              : level !== undefined
                ? `${state.process} volume set to ${state.level}%.`
                : `Unmuted ${state.process}.`;
          return { ok: true, speak };
        } catch (err) {
          if (err instanceof NoAppAudioError)
            return { ok: false, speak: err.message, followUp: true };
          throw err;
        }
      },
    }),
    defineTool({
      name: 'set_output_device',
      description:
        'Switch which speakers or headphones Windows plays sound through, by device name or kind ("headphones", "speakers", "JBL").',
      risk: 'safe',
      input: z.object({ device: z.string().min(1) }),
      describe: ({ device }) => `Switch audio output to ${device}`,
      run: async ({ device }) => {
        const devices = await win.audioDevices();
        const target = findDevice(devices, device);
        if (!target)
          return {
            ok: false,
            speak: `I couldn't find an output called ${device}.`,
            data: { devices: devices.map((d) => d.name) },
            followUp: true,
          };
        if (target.default)
          return { ok: true, speak: `Already playing through ${spokenDevice(target.name)}.` };
        await win.setDefaultAudioDevice(target.id);
        return { ok: true, speak: `Switched to ${spokenDevice(target.name)}.` };
      },
    }),
    defineTool({
      name: 'list_audio',
      description:
        'List output devices (which one is active) and apps making sound with their volumes.',
      risk: 'safe',
      input: z.object({}),
      describe: () => 'List audio devices and apps',
      run: async () => {
        const [devices, apps] = await Promise.all([win.audioDevices(), win.appAudio()]);
        const active = devices.find((d) => d.default);
        return {
          ok: true,
          speak: active
            ? `Sound is playing through ${spokenDevice(active.name)}.`
            : 'Here is your audio setup.',
          data: {
            devices: devices.map((d) => ({ name: d.name, active: d.default })),
            apps,
          },
          followUp: true,
        };
      },
    }),
  ];
}
