import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  SECRET_NAMES,
  TOKEN_NAMES,
  type SecretName,
  type SecretsSnapshot,
  type TokenName,
} from '@shared/secrets';
import { secretValueSchema } from './schemas';
import { writeFileAtomic } from '../util/atomic-write';

/** The subset of Electron's `safeStorage` the vault needs; injectable for tests. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const vaultFileSchema = z.object({
  version: z.literal(1),
  secrets: z.record(z.string(), z.string()),
});

export class VaultUnavailableError extends Error {
  constructor() {
    super('OS encryption is unavailable, so secrets cannot be stored safely.');
  }
}

/**
 * Stores API keys encrypted with the OS keychain (DPAPI on Windows). Plaintext only exists in
 * memory in the main process; it's never written to disk and never sent to a renderer.
 */
export class SecretVault {
  private encrypted: Map<SecretName | TokenName, string>;

  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {
    this.encrypted = this.load();
  }

  isAvailable(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  set(name: SecretName | TokenName, value: string): void {
    if (!this.isAvailable()) throw new VaultUnavailableError();
    const clean = secretValueSchema.parse(value);
    this.encrypted.set(name, this.cipher.encryptString(clean).toString('base64'));
    this.persist();
  }

  /** Main-process only. Returns `null` when missing or undecryptable (e.g. copied from another PC). */
  get(name: SecretName | TokenName): string | null {
    const blob = this.encrypted.get(name);
    if (!blob || !this.isAvailable()) return null;
    try {
      return this.cipher.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
  }

  remove(name: SecretName | TokenName): void {
    if (this.encrypted.delete(name)) this.persist();
  }

  snapshot(): SecretsSnapshot {
    return {
      encryptionAvailable: this.isAvailable(),
      items: SECRET_NAMES.map((name) => {
        const value = this.get(name);
        return { name, configured: value !== null, hint: value ? value.slice(-4) : null };
      }),
    };
  }

  private load(): Map<SecretName | TokenName, string> {
    const map = new Map<SecretName | TokenName, string>();
    if (!existsSync(this.filePath)) return map;
    try {
      const file = vaultFileSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
      for (const name of [...SECRET_NAMES, ...TOKEN_NAMES]) {
        const blob = file.secrets[name];
        if (blob) map.set(name, blob);
      }
    } catch {
      // A corrupt vault is treated as empty; the user re-enters keys. Never crash on startup.
    }
    return map;
  }

  private persist(): void {
    const file = { version: 1 as const, secrets: Object.fromEntries(this.encrypted) };
    writeFileAtomic(this.filePath, JSON.stringify(file, null, 2));
  }
}
