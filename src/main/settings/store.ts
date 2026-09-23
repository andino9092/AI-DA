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
      const merged = { ...DEFAULT_SETTINGS, ...(raw as object), version: DEFAULT_SETTINGS.version };
      return settingsSchema.parse(merged);
    } catch {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      return { ...DEFAULT_SETTINGS };
    }
  }
}
