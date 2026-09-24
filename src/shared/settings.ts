import { z } from 'zod';
import { DEFAULT_SENSITIVE_APPS } from './sensitive-apps';

export const SETTINGS_VERSION = 1;

const providerSettingsSchema = z.object({
  model: z.string().min(1),
  /** Stop using this provider for the day after this many requests (free-tier guard). */
  dailyLimit: z.number().int().min(0),
});

export const routineSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** Commands as the user would say them: "open steam", "set volume to 40". */
  steps: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
});

export type Routine = z.infer<typeof routineSchema>;

export const settingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  firstRunComplete: z.boolean(),
  launchAtLogin: z.boolean(),
  /** Installed builds: look for new versions on GitHub every few hours. */
  autoUpdate: z.boolean(),
  microphoneMuted: z.boolean(),
  /** Absolute path to the folder that holds downloaded models. `null` means the default location. */
  modelsDir: z.string().min(1).nullable(),
  privacy: z.object({
    /** Also mask emails and phone numbers before anything leaves the PC. */
    maskContactInfo: z.boolean(),
    /**
     * Apps and window-title words (password managers, banks). While one of these windows is the
     * target, AI-DA reads nothing from the screen: no UI tree, no OCR, no window title.
     */
    sensitiveApps: z.array(z.string().min(1).max(60)).max(100),
  }),
  llm: z.object({
    /** Providers are tried in this order; later ones are fallbacks. */
    order: z.array(z.enum(['gemini', 'groq'])).min(1),
    gemini: providerSettingsSchema,
    groq: providerSettingsSchema,
  }),
  voice: z.object({
    /** Listen for "Hey Aida" all the time (speech is transcribed locally, never uploaded). */
    wakeWord: z.boolean(),
    /** How readily speech counts as "Hey Aida": high suits quiet or distant mics. */
    wakeSensitivity: z.enum(['low', 'normal', 'high']),
    /** Read replies aloud. */
    speakReplies: z.boolean(),
    /** Kokoro voice id. */
    voice: z.string().min(1),
    speed: z.number().min(0.7).max(1.4),
    /** Show the small status pill while listening, thinking and speaking. */
    showOverlay: z.boolean(),
    /** Turn other apps down while Aida listens for a command or talks. */
    duckOthers: z.boolean(),
    /** Microphone to use; null means the Windows default. */
    inputDeviceId: z.string().min(1).nullable(),
  }),
  weather: z.object({
    /** Home city for "what's the weather"; set by name in Settings, never from an IP lookup. */
    place: z
      .object({
        name: z.string().min(1).max(200),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .nullable(),
    /** "auto" follows the Windows region (Fahrenheit in the US). */
    unit: z.enum(['auto', 'celsius', 'fahrenheit']),
  }),
  spotify: z.object({
    /** Client ID of the user's own Spotify developer app (not a secret with PKCE). */
    clientId: z
      .string()
      .regex(/^[0-9a-f]{32}$/i, 'A Spotify Client ID is 32 letters and numbers.')
      .nullable(),
  }),
  /** Named lists of commands, run in order when the user says the name ("gaming mode"). */
  routines: z.array(routineSchema).max(20),
  shortcuts: z.object({
    /** Electron accelerator for the command box. */
    palette: z.string().min(1),
    /** Starts listening for a command right away (and stops Aida talking). */
    pushToTalk: z.string().min(1),
    /** Stops everything AI-DA is doing: the running command, speech, pending confirmations. */
    panic: z.string().min(1),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Fields the renderer is allowed to change. `version` is managed by the store. */
export const settingsPatchSchema = settingsSchema.omit({ version: true }).partial().strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  firstRunComplete: false,
  launchAtLogin: true,
  autoUpdate: true,
  microphoneMuted: false,
  modelsDir: null,
  privacy: { maskContactInfo: false, sensitiveApps: [...DEFAULT_SENSITIVE_APPS] },
  llm: {
    order: ['gemini', 'groq'],
    gemini: { model: 'gemini-3.5-flash-lite', dailyLimit: 450 },
    groq: { model: 'qwen/qwen3.8-27b', dailyLimit: 900 },
  },
  voice: {
    wakeWord: true,
    wakeSensitivity: 'normal',
    speakReplies: true,
    voice: 'af_heart',
    speed: 1,
    showOverlay: true,
    duckOthers: true,
    inputDeviceId: null,
  },
  weather: { place: null, unit: 'auto' },
  spotify: { clientId: null },
  routines: [],
  shortcuts: {
    palette: 'Control+Alt+A',
    pushToTalk: 'Control+Alt+V',
    panic: 'Control+Alt+Backspace',
  },
};
