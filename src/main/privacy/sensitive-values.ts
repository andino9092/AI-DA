import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SensitiveValueSummary } from '@shared/privacy';
import type { Cipher } from '../secrets/vault';
import { VaultUnavailableError } from '../secrets/vault';
import { writeFileAtomic } from '../util/atomic-write';

const fileSchema = z.object({
  version: z.literal(1),
  items: z.array(z.object({ id: z.string(), label: z.string(), blob: z.string() })),
});

export const sensitiveValueInputSchema = z.object({
  label: z.string().trim().min(1, 'Give it a name.').max(60),
  value: z
    .string()
    .trim()
    .min(4, 'Values shorter than 4 characters would match too much.')
    .max(200),
});

interface Item {
  id: string;
  label: string;
  value: string;
}

/**
 * The user's own "never send this" list (account numbers, address, ...). Encrypted at rest with
 * the OS keychain; decrypted values live only in main-process memory for the Privacy Guard.
 */
export class SensitiveValueStore {
  private items: Item[];

  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher,
  ) {
    this.items = this.load();
  }

  values(): string[] {
    return this.items.map((i) => i.value);
  }

  list(): SensitiveValueSummary[] {
    return this.items.map(({ id, label, value }) => ({
      id,
      label,
      hint: value.length >= 8 ? value.slice(-4) : null,
    }));
  }

  add(input: { label: string; value: string }): SensitiveValueSummary[] {
    if (!this.cipher.isEncryptionAvailable()) throw new VaultUnavailableError();
    const { label, value } = sensitiveValueInputSchema.parse(input);
    this.items.push({ id: randomUUID(), label, value });
    this.persist();
    return this.list();
  }

  remove(id: string): SensitiveValueSummary[] {
    this.items = this.items.filter((i) => i.id !== id);
    this.persist();
    return this.list();
  }

  private load(): Item[] {
    if (!existsSync(this.filePath) || !this.cipher.isEncryptionAvailable()) return [];
    try {
      const file = fileSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
      return file.items.flatMap(({ id, label, blob }) => {
        try {
          return [{ id, label, value: this.cipher.decryptString(Buffer.from(blob, 'base64')) }];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private persist(): void {
    const items = this.items.map(({ id, label, value }) => ({
      id,
      label,
      blob: this.cipher.encryptString(value).toString('base64'),
    }));
    writeFileAtomic(this.filePath, JSON.stringify({ version: 1, items }, null, 2));
  }
}
