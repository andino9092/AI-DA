import { z } from 'zod';

export const SETTINGS_VERSION = 1;

export const settingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  firstRunComplete: z.boolean(),
  launchAtLogin: z.boolean(),
  microphoneMuted: z.boolean(),
  /** Absolute path to the folder that holds downloaded models. `null` means the default location. */
  modelsDir: z.string().min(1).nullable(),
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
};
