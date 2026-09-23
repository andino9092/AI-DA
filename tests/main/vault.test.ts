import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretVault, VaultUnavailableError, type Cipher } from '../../src/main/secrets/vault';

/** Reversible stand-in for DPAPI that still makes plaintext unreadable on disk. */
function fakeCipher(available = true): Cipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
    decryptString: (b) => {
      const text = b.toString();
      if (!text.startsWith('enc:')) throw new Error('bad blob');
      return [...text.slice(4)].reverse().join('');
    },
  };
}

const KEY = 'AIzaSyExampleKey1234';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aida-vault-'));
  file = join(dir, 'vault.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SecretVault', () => {
  it('round-trips a secret across instances', () => {
    new SecretVault(file, fakeCipher()).set('gemini', KEY);
    expect(new SecretVault(file, fakeCipher()).get('gemini')).toBe(KEY);
  });

  it('never writes plaintext to disk', () => {
    new SecretVault(file, fakeCipher()).set('gemini', KEY);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY);
  });

  it('snapshot exposes only a four-character hint', () => {
    const vault = new SecretVault(file, fakeCipher());
    vault.set('groq', 'gsk_abcdefghWXYZ');
    const snap = vault.snapshot();
    expect(snap.encryptionAvailable).toBe(true);
    expect(snap.items).toEqual([
      { name: 'gemini', configured: false, hint: null },
      { name: 'groq', configured: true, hint: 'WXYZ' },
    ]);
    expect(JSON.stringify(snap)).not.toContain('gsk_abcdefgh');
  });

  it('trims pasted whitespace and rejects malformed keys', () => {
    const vault = new SecretVault(file, fakeCipher());
    vault.set('gemini', `  ${KEY}\n`);
    expect(vault.get('gemini')).toBe(KEY);
    expect(() => vault.set('gemini', 'short')).toThrow();
    expect(() => vault.set('gemini', 'has a space inside it')).toThrow();
  });

  it('removes secrets', () => {
    const vault = new SecretVault(file, fakeCipher());
    vault.set('gemini', KEY);
    vault.remove('gemini');
    expect(new SecretVault(file, fakeCipher()).get('gemini')).toBeNull();
  });

  it('refuses to store when OS encryption is unavailable', () => {
    const vault = new SecretVault(file, fakeCipher(false));
    expect(() => vault.set('gemini', KEY)).toThrow(VaultUnavailableError);
  });

  it('treats undecryptable blobs (e.g. copied from another PC) as missing', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        secrets: { gemini: Buffer.from('garbage').toString('base64') },
      }),
    );
    const vault = new SecretVault(file, fakeCipher());
    expect(vault.get('gemini')).toBeNull();
    expect(vault.snapshot().items[0]).toEqual({ name: 'gemini', configured: false, hint: null });
  });

  it('survives a corrupt vault file', () => {
    writeFileSync(file, 'nope');
    expect(new SecretVault(file, fakeCipher()).get('gemini')).toBeNull();
  });
});
