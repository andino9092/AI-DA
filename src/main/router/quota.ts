import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProviderId } from '../providers/llm/types';
import type { ProviderUsage } from '@shared/llm';
import { writeFileAtomic } from '../util/atomic-write';

const fileSchema = z.record(z.string(), z.object({ day: z.string(), count: z.number() }));

/** Free-tier daily quotas reset at midnight Pacific time. */
export function quotaDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/**
 * Counts requests per provider per day (persisted, so restarts don't reset the count) and
 * remembers short cool-downs after rate-limit errors (in memory).
 */
export class QuotaTracker {
  private counts: Record<string, { day: string; count: number }>;
  private readonly coolUntil = new Map<ProviderId, number>();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.counts = this.load();
  }

  used(provider: ProviderId): number {
    const entry = this.counts[provider];
    return entry && entry.day === quotaDay(this.now()) ? entry.count : 0;
  }

  record(provider: ProviderId): void {
    this.counts[provider] = { day: quotaDay(this.now()), count: this.used(provider) + 1 };
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.counts));
    } catch {
      // Counting is best-effort.
    }
  }

  coolDown(provider: ProviderId, ms: number): void {
    this.coolUntil.set(provider, this.now().getTime() + ms);
  }

  isCoolingDown(provider: ProviderId): boolean {
    return (this.coolUntil.get(provider) ?? 0) > this.now().getTime();
  }

  usage(provider: ProviderId, limit: number, configured: boolean): ProviderUsage {
    return {
      provider,
      configured,
      used: this.used(provider),
      limit,
      coolingDown: this.isCoolingDown(provider),
    };
  }

  private load(): Record<string, { day: string; count: number }> {
    if (!existsSync(this.filePath)) return {};
    try {
      return fileSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return {};
    }
  }
}
