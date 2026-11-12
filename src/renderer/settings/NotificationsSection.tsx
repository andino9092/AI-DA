import { useEffect, useState } from 'react';
import type { Settings, SettingsPatch } from '@shared/settings';
import {
  GOOGLE_API_URLS,
  GOOGLE_CLIENT_ID,
  GOOGLE_CONSOLE_URL,
  type AidaNotification,
  type NotificationsSnapshot,
} from '@shared/notifications';
import { Button, Section, Toggle } from './components';

const INPUT =
  'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950';
const SELECT =
  'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950';

type GmailFilter = Settings['notifications']['gmail'];

const GMAIL_OPTIONS: { id: GmailFilter; label: string }[] = [
  { id: 'primary', label: 'Primary inbox (skips Promotions, Social, Updates)' },
  { id: 'important', label: 'Only ones Gmail marks Important' },
  { id: 'all', label: 'Every new email in the inbox' },
  { id: 'off', label: 'Off' },
];

const CALENDAR_OPTIONS: { value: number | null; label: string }[] = [
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 0, label: 'When it starts' },
  { value: null, label: 'Off' },
];

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function holdText(snapshot: NotificationsSnapshot): string | null {
  switch (snapshot.held) {
    case 'muted':
      return snapshot.mutedUntil ? `Muted until ${time(snapshot.mutedUntil)}.` : 'Muted.';
    case 'fullscreen':
      return 'Waiting: a full-screen app or game is open.';
    case 'call':
      return `Waiting: ${snapshot.heldBy ?? 'another app'} is using the microphone.`;
    case 'away':
      return "Waiting until you're back at the PC.";
    case 'aida-busy':
      return 'Waiting for Aida to finish.';
    default:
      return null;
  }
}

function describeItem(item: AidaNotification): string {
  if (item.source === 'gmail') return `${item.title}${item.detail ? ` — ${item.detail}` : ''}`;
  if (item.source === 'calendar')
    return `${item.title}${item.startsAt ? ` at ${time(item.startsAt)}` : ''}`;
  return item.title;
}

const SOURCE_ICON: Record<AidaNotification['source'], string> = {
  gmail: '✉',
  calendar: '📅',
  system: 'ℹ',
};

export function NotificationsSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: SettingsPatch) => void;
}) {
  const prefs = settings.notifications;
  const [snapshot, setSnapshot] = useState<NotificationsSnapshot | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    void window.aida.notifications.snapshot().then(setSnapshot);
    return window.aida.notifications.onChanged(setSnapshot);
  }, []);

  const setPrefs = (patch: Partial<Settings['notifications']>) =>
    update({ notifications: { ...prefs, ...patch } });

  async function saveClient() {
    const id = clientId.trim();
    if (!GOOGLE_CLIENT_ID.test(id)) {
      setError('A Client ID ends in .apps.googleusercontent.com.');
      return;
    }
    const result = await window.aida.notifications.setGoogleClient(id, clientSecret.trim());
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setClientId('');
    setClientSecret('');
    setSnapshot(result.snapshot);
  }

  async function connect() {
    setConnecting(true);
    setError(null);
    const result = await window.aida.notifications.connect();
    setConnecting(false);
    if (!result.ok) setError(result.error);
    setSnapshot(await window.aida.notifications.snapshot());
  }

  const google = snapshot?.google;
  const missing = google?.granted
    ? [!google.granted.gmail && 'Gmail', !google.granted.calendar && 'Calendar'].filter(Boolean)
    : [];
  const hold = snapshot ? holdText(snapshot) : null;
  const link = (url: string, label: string) => (
    <button
      type="button"
      className="text-accent hover:underline"
      onClick={() => void window.aida.app.openExternal(url)}
    >
      {label} ↗
    </button>
  );

  return (
    <Section
      title="Notifications"
      description="Aida tells you about new emails and upcoming events when it's a good moment: not while she's busy, and (if you like) not while you're gaming, on a call or away. Only the sender and subject or the event name are read, on this PC. Ask “what did I miss?” anytime."
    >
      <Toggle
        label="Read notifications aloud"
        checked={prefs.enabled}
        onChange={(v) => setPrefs({ enabled: v })}
      />

      {google?.connected ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm">
              Google connected{google.account ? ` as ${google.account}` : ''}{' '}
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                ✓
              </span>
            </div>
            <Button
              variant="danger"
              onClick={() => void window.aida.notifications.disconnect().then(setSnapshot)}
            >
              Disconnect
            </Button>
          </div>
          {missing.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {missing.join(' and ')} access wasn’t allowed. Disconnect, connect again and tick
              every box on Google’s page.
            </p>
          )}
        </div>
      ) : (
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            In the {link('https://console.cloud.google.com/projectcreate', 'Google Cloud console')},
            create a project (any name, it's free).
          </li>
          <li>
            Turn on the {link(GOOGLE_API_URLS.gmail, 'Gmail API')} and the{' '}
            {link(GOOGLE_API_URLS.calendar, 'Google Calendar API')} for it.
          </li>
          <li>
            Open {link('https://console.cloud.google.com/auth/overview', 'Google Auth Platform')} →
            Get started: name it AI-DA, pick <span className="font-medium">External</span>, and use
            your own email. Then, under <span className="font-medium">Audience</span>, click{' '}
            <span className="font-medium">Publish app</span>. Otherwise Google signs you out every 7
            days.
          </li>
          <li>
            Under {link(GOOGLE_CONSOLE_URL, 'Clients')}, create a client of type{' '}
            <span className="font-medium">Desktop app</span> and paste its Client ID and Client
            secret here:
            {google?.configured ? (
              <div className="mt-1 flex items-center gap-2">
                <code className="rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-950">
                  {google.clientHint}
                </code>
                <Button
                  onClick={() =>
                    void window.aida.notifications.clearGoogleClient().then(setSnapshot)
                  }
                >
                  Change
                </Button>
              </div>
            ) : (
              <form
                className="mt-1 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveClient();
                }}
              >
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Client ID"
                  aria-label="Google Client ID"
                  spellCheck={false}
                  autoComplete="off"
                  className={`${INPUT} w-full`}
                />
                <div className="flex gap-2">
                  <input
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="Client secret"
                    aria-label="Google Client secret"
                    type="password"
                    spellCheck={false}
                    autoComplete="off"
                    className={INPUT}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!clientId.trim() || !clientSecret.trim()}
                  >
                    Save
                  </Button>
                </div>
              </form>
            )}
          </li>
          <li>
            <Button
              variant="primary"
              disabled={!google?.configured || connecting}
              onClick={() => void connect()}
            >
              {connecting ? 'Waiting for Google…' : 'Connect Google'}
            </Button>
            {connecting ? (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                Finish signing in in your browser.
              </span>
            ) : (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Google warns that the app isn't verified: it's your own, so choose Advanced → Go to
                AI-DA. Tick both boxes. AI-DA can only read email headers, never the emails
                themselves.
              </p>
            )}
          </li>
        </ol>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-sm">Emails</span>
        <select
          className={SELECT}
          aria-label="Which emails to announce"
          value={prefs.gmail}
          onChange={(e) => setPrefs({ gmail: e.target.value as GmailFilter })}
        >
          {GMAIL_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-sm">Events</span>
        <select
          className={SELECT}
          aria-label="When to mention calendar events"
          value={prefs.calendarMinutes === null ? 'off' : String(prefs.calendarMinutes)}
          onChange={(e) =>
            setPrefs({ calendarMinutes: e.target.value === 'off' ? null : Number(e.target.value) })
          }
        >
          {CALENDAR_OPTIONS.map((o) => (
            <option key={o.label} value={o.value === null ? 'off' : String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <Toggle
        label="Wait while I'm busy"
        hint="Holds notifications while a full-screen app or game is open, another app uses the microphone (a call), or you've been away from the keyboard for 5 minutes. Then sums up what came in."
        checked={prefs.holdWhenBusy}
        onChange={(v) => setPrefs({ holdWhenBusy: v })}
      />

      {snapshot?.error && (
        <p className="text-xs text-red-600 dark:text-red-400">{snapshot.error}</p>
      )}
      {hold && (
        <div className="flex items-center justify-between gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            {snapshot?.pending ? `${snapshot.pending} waiting. ` : ''}
            {hold}
          </span>
          {snapshot?.held === 'muted' && (
            <Button onClick={() => void window.aida.notifications.unmute().then(setSnapshot)}>
              Unmute
            </Button>
          )}
        </div>
      )}

      {snapshot && snapshot.recent.length > 0 && (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {snapshot.recent.slice(0, 8).map((item) => (
            <li key={item.id} className="flex items-baseline gap-2 py-1.5">
              <span aria-hidden className="w-5 shrink-0 text-center">
                {SOURCE_ICON[item.source]}
              </span>
              <span className="min-w-0 flex-1 truncate">{describeItem(item)}</span>
              <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                {item.state === 'pending'
                  ? 'waiting'
                  : item.state === 'missed'
                    ? 'missed'
                    : time(item.at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          disabled={!prefs.enabled}
          onClick={() => void window.aida.notifications.test().then(setSnapshot)}
        >
          Try a notification
        </Button>
      </div>
    </Section>
  );
}
