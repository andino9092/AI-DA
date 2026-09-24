import { useEffect, useState } from 'react';
import type { ProviderUsage } from '@shared/llm';
import type { Settings } from '@shared/settings';
import { SECRET_INFO } from '@shared/secrets';
import { Section } from './components';

export function UsageSection({ settings }: { settings: Settings }) {
  const [usage, setUsage] = useState<ProviderUsage[]>([]);

  useEffect(() => {
    const load = () => void window.aida.llm.usage().then(setUsage);
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Section
      title="Free-tier usage today"
      description="Simple commands (volume, media, opening apps, windows) run on this PC and don't count. Limits reset at midnight Pacific."
    >
      <ul className="space-y-3">
        {usage.map((u) => {
          const pct = u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 100;
          return (
            <li key={u.provider}>
              <div className="flex items-baseline justify-between text-sm">
                <span>
                  {SECRET_INFO[u.provider].label}
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {settings.llm[u.provider].model}
                  </span>
                </span>
                <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                  {!u.configured
                    ? 'No key'
                    : u.coolingReason === 'auth'
                      ? 'Key rejected: use Test above'
                      : u.coolingReason === 'busy'
                        ? 'Busy, trying others first'
                        : u.coolingReason === 'rate_limit'
                          ? 'Rate-limited, retrying soon'
                          : `${u.used} / ${u.limit}`}
                </span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                role="progressbar"
                aria-valuenow={u.used}
                aria-valuemax={u.limit}
                aria-label={`${SECRET_INFO[u.provider].label} requests today`}
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${u.configured ? pct : 0}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
