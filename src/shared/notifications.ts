/** Where the user creates their own Google sign-in app (a "Desktop app" OAuth client). */
export const GOOGLE_CONSOLE_URL = 'https://console.cloud.google.com/auth/clients';
/** The two APIs the user turns on in that project. */
export const GOOGLE_API_URLS = {
  gmail: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  calendar: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
} as const;

/** "1234-abc.apps.googleusercontent.com". */
export const GOOGLE_CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;

export interface GoogleStatus {
  /** A Client ID and secret are saved. */
  configured: boolean;
  /** Signed in (a refresh token is saved). */
  connected: boolean;
  /** The Google account's email, when connected and reachable. */
  account: string | null;
  /** Client ID, shortened for display. */
  clientHint: string | null;
  /**
   * What the user allowed on Google's consent page (they can untick either box). Null until known.
   */
  granted: { gmail: boolean; calendar: boolean } | null;
}

export type GoogleConnectResult = { ok: true; status: GoogleStatus } | { ok: false; error: string };

/** system: AI-DA's own notices ("your Google sign-in expired"). */
export type NotificationSource = 'gmail' | 'calendar' | 'system';

/** One thing Aida may tell the user about. Only sender/subject or event title: never a body. */
export interface AidaNotification {
  /** Stable per source ("gmail:<message id>", "calendar:<event id>:<start>"). */
  id: string;
  source: NotificationSource;
  /** When it arrived (ms). */
  at: number;
  /** Email: sender's name. Event: calendar event title. */
  title: string;
  /** Email: subject (empty if it was withheld). Event: location, if any. */
  detail: string;
  /** Events: start time (ms), for "in 10 minutes" and expiry. */
  startsAt?: number;
  /** After this, reading it out is pointless (the meeting started). Kept in history. */
  expiresAt?: number;
  /** heard: read out or listed · pending: waiting for a good moment · missed: expired unheard. */
  state: 'pending' | 'heard' | 'missed';
}

/** Why notifications are waiting instead of being read out. */
export type HoldReason =
  'muted' | 'fullscreen' | 'call' | 'away' | 'aida-busy' | 'voice-off' | null;

export interface NotificationsSnapshot {
  google: GoogleStatus;
  /** Newest first. */
  recent: AidaNotification[];
  pending: number;
  held: HoldReason;
  /** For 'call': the app using the microphone ("Discord"). */
  heldBy: string | null;
  /** "Mute notifications for an hour": until when (ms), or null. */
  mutedUntil: number | null;
  /** The last problem checking Gmail or Calendar, if it's still unresolved. */
  error: string | null;
}
