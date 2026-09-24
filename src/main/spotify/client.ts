import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import {
  SPOTIFY_CALLBACK_PORT,
  SPOTIFY_REDIRECT_URI,
  type SpotifyConnectResult,
  type SpotifyStatus,
} from '@shared/spotify';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
].join(' ');
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Spotify's reason code, e.g. NO_ACTIVE_DEVICE, PREMIUM_REQUIRED. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** What the tools need from Spotify; a fake stands in for it in tests. */
export interface SpotifyApi {
  connected(): boolean;
  request<T = unknown>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal },
  ): Promise<T | null>;
}

export interface SpotifyClientDeps {
  clientId(): string | null;
  loadRefreshToken(): string | null;
  saveRefreshToken(token: string | null): void;
  openBrowser(url: string): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  port?: number;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>AI-DA</title><body style="font:16px system-ui;margin:3em;color:#222">${message}</body>`;

/**
 * Spotify Web API with the Authorization Code + PKCE flow: no client secret, the user's own
 * developer app, and a one-time local callback on 127.0.0.1. The refresh token is kept encrypted
 * in the vault; the short-lived access token only in memory.
 */
export class SpotifyClient implements SpotifyApi {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private pendingSignIn: { cancel(): void } | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: SpotifyClientDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  connected(): boolean {
    return !!this.deps.clientId() && !!this.deps.loadRefreshToken();
  }

  async status(): Promise<SpotifyStatus> {
    const configured = !!this.deps.clientId();
    const connected = this.connected();
    let account: string | null = null;
    if (connected) {
      try {
        const me = await this.request<{ display_name?: string | null; id: string }>('GET', '/me');
        account = me?.display_name || me?.id || null;
      } catch {
        account = null;
      }
    }
    return { configured, connected, account };
  }

  disconnect(): void {
    this.pendingSignIn?.cancel();
    this.accessToken = null;
    this.deps.saveRefreshToken(null);
  }

  /** Opens Spotify's sign-in page in the browser and waits for the redirect back. */
  async connect(): Promise<SpotifyConnectResult> {
    const clientId = this.deps.clientId();
    if (!clientId) return { ok: false, error: 'Paste your Client ID first.' };
    this.pendingSignIn?.cancel();

    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    let code: string;
    try {
      code = await this.waitForCallback(state, async () => {
        const url = new URL(AUTHORIZE_URL);
        url.search = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: SPOTIFY_REDIRECT_URI,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
          scope: SCOPES,
        }).toString();
        await this.deps.openBrowser(url.toString());
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const token = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      });
      if (!token.refresh_token)
        return { ok: false, error: 'Spotify did not return a sign-in token.' };
      this.deps.saveRefreshToken(token.refresh_token);
      this.accessToken = {
        value: token.access_token,
        expiresAt: this.now() + token.expires_in * 1000,
      };
      return { ok: true, status: await this.status() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async request<T = unknown>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<T | null> {
    const url = new URL(API_URL + path);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, value);

    for (let attempt = 0; ; attempt++) {
      const token = await this.token(attempt > 0);
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      // An access token can be revoked early; refresh once and retry.
      if (response.status === 401 && attempt === 0) {
        this.accessToken = null;
        continue;
      }
      if (response.status === 429 && attempt === 0) {
        const wait = Number(response.headers.get('retry-after')) || 1;
        if (wait <= 3) {
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
          continue;
        }
      }
      const text = await response.text();
      const json: unknown = text ? safeJson(text) : null;
      if (!response.ok) {
        const error = (json as { error?: { message?: string; reason?: string } } | null)?.error;
        throw new SpotifyError(
          response.status,
          error?.message ?? `Spotify answered ${response.status}.`,
          error?.reason,
        );
      }
      return json as T | null;
    }
  }

  private async token(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAt > this.now() + 30_000)
      return this.accessToken.value;
    const clientId = this.deps.clientId();
    const refresh = this.deps.loadRefreshToken();
    if (!clientId || !refresh) throw new SpotifyError(401, 'Spotify is not connected.');
    let token: z.infer<typeof tokenSchema>;
    try {
      token = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
      });
    } catch (err) {
      // invalid_grant: the user removed access or the app changed; they must sign in again.
      if (err instanceof SpotifyError && err.status === 400) {
        this.deps.saveRefreshToken(null);
        throw new SpotifyError(401, 'The Spotify sign-in expired.');
      }
      throw err;
    }
    // PKCE refresh tokens rotate: keep the newest one.
    if (token.refresh_token && token.refresh_token !== refresh)
      this.deps.saveRefreshToken(token.refresh_token);
    this.accessToken = {
      value: token.access_token,
      expiresAt: this.now() + token.expires_in * 1000,
    };
    return token.access_token;
  }

  private async tokenRequest(params: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = safeJson(await response.text()) as {
      error?: string;
      error_description?: string;
    } | null;
    if (!response.ok)
      throw new SpotifyError(
        response.status,
        json?.error_description ?? json?.error ?? `Spotify sign-in failed (${response.status}).`,
        json?.error,
      );
    return tokenSchema.parse(json);
  }

  /** Listens once on 127.0.0.1 for Spotify's redirect and returns the authorization code. */
  private waitForCallback(state: string, open: () => Promise<void>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let server: Server | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (error: Error | null, code?: string) => {
        if (timer) clearTimeout(timer);
        server?.close();
        server = null;
        this.pendingSignIn = null;
        if (error) reject(error);
        else resolve(code!);
      };
      this.pendingSignIn = { cancel: () => finish(new Error('Sign-in was cancelled.')) };

      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', SPOTIFY_REDIRECT_URI);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (url.searchParams.get('state') !== state) {
          res
            .writeHead(400, { 'Content-Type': 'text/html' })
            .end(PAGE('This sign-in link is out of date. Try again from AI-DA.'));
          return;
        }
        if (error || !code) {
          res
            .writeHead(200, { 'Content-Type': 'text/html' })
            .end(PAGE('Spotify was not connected. You can close this tab.'));
          finish(
            new Error(
              error === 'access_denied'
                ? 'You cancelled the Spotify sign-in.'
                : `Spotify said: ${error ?? 'no code'}.`,
            ),
          );
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(PAGE('Spotify is connected to AI-DA. You can close this tab.'));
        finish(null, code);
      });
      server.on('error', (err: NodeJS.ErrnoException) =>
        finish(
          new Error(
            err.code === 'EADDRINUSE'
              ? `Port ${this.deps.port ?? SPOTIFY_CALLBACK_PORT} is in use by another program, so the sign-in can't finish.`
              : err.message,
          ),
        ),
      );
      server.listen(this.deps.port ?? SPOTIFY_CALLBACK_PORT, '127.0.0.1', () => {
        timer = setTimeout(
          () => finish(new Error('The Spotify sign-in timed out.')),
          SIGN_IN_TIMEOUT_MS,
        );
        open().catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
      });
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
