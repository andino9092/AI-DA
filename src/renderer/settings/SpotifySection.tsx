import { useEffect, useState } from 'react';
import type { Settings, SettingsPatch } from '@shared/settings';
import { SPOTIFY_DASHBOARD_URL, SPOTIFY_REDIRECT_URI, type SpotifyStatus } from '@shared/spotify';
import { Button, Section } from './components';

const INPUT =
  'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950';

export function SpotifySection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: SettingsPatch) => void;
}) {
  const { clientId } = settings.spotify;
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.aida.spotify.status().then(setStatus);
  }, [clientId]);

  function saveClientId() {
    const id = draft.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      setError('A Client ID is 32 letters and numbers. Copy it from your app’s Settings page.');
      return;
    }
    setError(null);
    setDraft('');
    update({ spotify: { clientId: id } });
  }

  async function connect() {
    setConnecting(true);
    setError(null);
    const result = await window.aida.spotify.connect();
    setConnecting(false);
    if (result.ok) setStatus(result.status);
    else setError(result.error);
  }

  async function disconnect() {
    setStatus(await window.aida.spotify.disconnect());
  }

  async function copyRedirect() {
    await navigator.clipboard.writeText(SPOTIFY_REDIRECT_URI);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Section
      title="Spotify"
      description="Lets Aida search and play (“play Daft Punk”, “play my liked songs”), queue songs, like songs, and shuffle. Needs Spotify Premium. Play, pause and skip work without this."
    >
      {status?.connected ? (
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            Connected{status.account ? ` as ${status.account}` : ''}{' '}
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              ✓
            </span>
          </div>
          <Button variant="danger" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            Open the{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => void window.aida.app.openExternal(SPOTIFY_DASHBOARD_URL)}
            >
              Spotify developer dashboard ↗
            </button>{' '}
            and create an app (any name). Tick <span className="font-medium">Web API</span>.
          </li>
          <li>
            Add this Redirect URI:
            <div className="mt-1 flex items-center gap-2">
              <code className="rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-950">
                {SPOTIFY_REDIRECT_URI}
              </code>
              <Button onClick={() => void copyRedirect()}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </li>
          <li>
            Paste the app&apos;s Client ID here:
            {clientId ? (
              <div className="mt-1 flex items-center gap-2">
                <code className="rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-950">
                  {clientId.slice(0, 6)}…{clientId.slice(-4)}
                </code>
                <Button onClick={() => update({ spotify: { clientId: null } })}>Change</Button>
              </div>
            ) : (
              <form
                className="mt-1 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveClientId();
                }}
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Client ID"
                  aria-label="Spotify Client ID"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT}
                />
                <Button type="submit" variant="primary" disabled={draft.trim() === ''}>
                  Save
                </Button>
              </form>
            )}
          </li>
          <li>
            <Button
              variant="primary"
              disabled={!clientId || connecting}
              onClick={() => void connect()}
            >
              {connecting ? 'Waiting for Spotify…' : 'Connect Spotify'}
            </Button>
            {connecting && (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                Finish signing in in your browser.
              </span>
            )}
          </li>
        </ol>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Section>
  );
}
