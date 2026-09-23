import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../../src/main/settings/store';
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../src/shared/settings';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aida-settings-'));
  file = join(dir, 'settings.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SettingsStore', () => {
  it('starts with defaults when no file exists', () => {
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists updates and reloads them', () => {
    new SettingsStore(file).update({ microphoneMuted: true, modelsDir: 'D:\\models' });
    const reloaded = new SettingsStore(file).get();
    expect(reloaded.microphoneMuted).toBe(true);
    expect(reloaded.modelsDir).toBe('D:\\models');
  });

  it('emits changed with next and previous values', () => {
    const store = new SettingsStore(file);
    const listener = vi.fn();
    store.on('changed', listener);
    store.update({ launchAtLogin: false });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ launchAtLogin: false }),
      expect.objectContaining({ launchAtLogin: true }),
    );
  });

  it('rejects invalid patches without writing', () => {
    const store = new SettingsStore(file);
    expect(() => store.update({ launchAtLogin: 'yes' } as unknown as SettingsPatch)).toThrow();
    expect(() => store.update({ version: 2 } as unknown as SettingsPatch)).toThrow();
    expect(() => store.update({ evil: true } as unknown as SettingsPatch)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in fields missing from an older file', () => {
    writeFileSync(file, JSON.stringify({ version: 1, microphoneMuted: true }));
    const store = new SettingsStore(file);
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, microphoneMuted: true });
  });

  it('backs up a corrupt file and falls back to defaults', () => {
    writeFileSync(file, '{ not json');
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const backups = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{ not json');
  });
});
