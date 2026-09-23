import { existsSync, readFileSync, renameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_SETTINGS,
  settingsPatchSchema,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from '@shared/settings';
import { writeFileAtomic } from '../util/atomic-write';

type Events = { changed: [settings: Settings, previous: Settings] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges saved values over defaults so nested fields added in later versions get defaults. */
function mergeDefaults(defaults: unknown, saved: unknown): unknown {
  if (!isPlainObject(defaults) || !isPlainObject(saved))
    return saved === undefined ? defaults : saved;
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(saved)) out[key] = mergeDefaults(defaults[key], value);
  return out;
}

/**
 * JSON-file settings store. Every read and write is validated, so a hand-edited or corrupted
 * file can never put the app into an invalid state: it's backed up and replaced with defaults.
 */
export class SettingsStore extends EventEmitter<Events> {
  private current: Settings;

  constructor(private readonly filePath: string) {
    super();
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  update(patch: SettingsPatch): Settings {
    const validPatch = settingsPatchSchema.parse(patch);
    const previous = this.current;
    const next = settingsSchema.parse({ ...previous, ...validPatch });
    writeFileAtomic(this.filePath, JSON.stringify(next, null, 2));
    this.current = next;
    this.emit('changed', next, previous);
    return next;
  }

  private load(): Settings {
    if (!existsSync(this.filePath)) return { ...DEFAULT_SETTINGS };

    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      // Fill in fields added since the file was written, then validate the result.
      const merged = {
        ...(mergeDefaults(DEFAULT_SETTINGS, raw) as object),
        version: DEFAULT_SETTINGS.version,
      };
      return settingsSchema.parse(merged);
    } catch {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      return { ...DEFAULT_SETTINGS };
    }
  }
}
