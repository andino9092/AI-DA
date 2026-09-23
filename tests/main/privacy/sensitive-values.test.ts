import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SensitiveValueStore } from '../../../src/main/privacy/sensitive-values';
import type { Cipher } from '../../../src/main/secrets/vault';
import { tempDir } from '../fakes';

const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = tempDir('aida-sensitive-');
  file = join(dir, 'sensitive-values.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SensitiveValueStore', () => {
  it('adds, lists with a hint only, persists encrypted, and removes', () => {
    const store = new SensitiveValueStore(file, cipher);
    const [item] = store.add({ label: 'Savings', value: '9876 5432 1098' });
    expect(item).toMatchObject({ label: 'Savings', hint: '1098' });
    expect(JSON.stringify(store.list())).not.toContain('9876 5432');
    expect(readFileSync(file, 'utf8')).not.toContain('9876 5432');

    const reloaded = new SensitiveValueStore(file, cipher);
    expect(reloaded.values()).toEqual(['9876 5432 1098']);
    expect(reloaded.remove(item!.id)).toEqual([]);
    expect(new SensitiveValueStore(file, cipher).values()).toEqual([]);
  });

  it('hides the hint for short values and rejects values under 4 characters', () => {
    const store = new SensitiveValueStore(file, cipher);
    expect(store.add({ label: 'PIN hint', value: 'abcd' })[0]!.hint).toBeNull();
    expect(() => store.add({ label: 'Too short', value: 'abc' })).toThrow();
    expect(() => store.add({ label: ' ', value: 'long enough' })).toThrow();
  });
});
