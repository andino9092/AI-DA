import type { ModelStatus } from '@shared/models';
import { Button } from './components';
import { formatBytes } from './models';

/** The list of local voice models with sizes, progress and one Download button. */
export function ModelsCard({ models }: { models: ModelStatus[] }) {
  const missing = models.filter((m) => m.state !== 'ready');
  const downloading = models.some((m) => m.state === 'downloading');
  const remaining = missing.reduce((sum, m) => sum + m.bytes, 0);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {models.map((m) => (
          <li key={m.id} className="px-3 py-2">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>
                {m.label}
                <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{m.purpose}</span>
              </span>
              <span className="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                {m.state === 'ready'
                  ? 'Installed'
                  : m.state === 'downloading'
                    ? `${formatBytes(m.received)} / ${formatBytes(m.bytes)}`
                    : formatBytes(m.bytes)}
              </span>
            </div>
            {m.state === 'downloading' && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.min(100, (m.received / m.bytes) * 100)}%` }}
                />
              </div>
            )}
            {m.state === 'error' && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{m.error}</p>
            )}
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Downloads from GitHub and Hugging Face; every file is checked against a pinned SHA-256.
          </span>
          <Button
            variant="primary"
            disabled={downloading}
            onClick={() => void window.aida.models.install()}
          >
            {downloading ? 'Downloading…' : `Download (${formatBytes(remaining)})`}
          </Button>
        </div>
      )}
    </div>
  );
}
