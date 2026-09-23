import { z } from 'zod';

export const SETTINGS_VERSION = 1;

const providerSettingsSchema = z.object({
  model: z.string().min(1),
  /** Stop using this provider for the day after this many requests (free-tier guard). */
  dailyLimit: z.number().int().min(0),
});

export const settingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  firstRunComplete: z.boolean(),
  launchAtLogin: z.boolean(),
  microphoneMuted: z.boolean(),
  /** Absolute path to the folder that holds downloaded models. `null` means the default location. */
  modelsDir: z.string().min(1).nullable(),
  privacy: z.object({
    /** Also mask emails and phone numbers before anything leaves the PC. */
    maskContactInfo: z.boolean(),
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
    /** Microphone to use; null means the Windows default. */
    inputDeviceId: z.string().min(1).nullable(),
  }),
  shortcuts: z.object({
    /** Electron accelerator for the command box. */
    palette: z.string().min(1),
    /** Starts listening for a command right away (and stops Aida talking). */
    pushToTalk: z.string().min(1),
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
  microphoneMuted: false,
  modelsDir: null,
  privacy: { maskContactInfo: false },
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
    inputDeviceId: null,
  },
  shortcuts: { palette: 'Control+Alt+A', pushToTalk: 'Control+Alt+V' },
};
