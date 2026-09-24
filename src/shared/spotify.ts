/** Port for the one-time Spotify sign-in callback; the user registers this exact address. */
export const SPOTIFY_CALLBACK_PORT = 43821;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_CALLBACK_PORT}/callback`;
export const SPOTIFY_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

export interface SpotifyStatus {
  /** A Client ID is saved in Settings. */
  configured: boolean;
  /** Signed in (a refresh token is saved). */
  connected: boolean;
  /** Spotify display name, when connected and reachable. */
  account: string | null;
}

export type SpotifyConnectResult =
  { ok: true; status: SpotifyStatus } | { ok: false; error: string };
