import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GoogleConnectResult, GoogleStatus } from '@shared/notifications';
import { base64url, waitForRedirect, type PendingRedirect } from '../util/oauth-redirect';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Read-only, and for Gmail only headers and labels (sender, subject): Google won't give AI-DA
 * the text of any email with this scope.
 */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const SCOPES = ['openid', 'email', GMAIL_SCOPE, CALENDAR_SCOPE].join(' ');

const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Google's reason, e.g. invalid_grant, accessNotConfigured, insufficientPermissions. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** What Gmail and Calendar need from Google; a fake stands in for it in tests. */
export interface GoogleApi {
  connected(): boolean;
  get<T = unknown>(
    url: string,
    query?: Record<string, string | string[] | undefined>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface GoogleClientDeps {
  clientId(): string | null;
  clientSecret(): string | null;
  loadRefreshToken(): string | null;
  saveRefreshToken(token: string | null): void;
  openBrowser(url: string): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Google sign-in for a desktop app (the user's own OAuth client): Authorization Code + PKCE with
 * a one-time listener on a free 127.0.0.1 port. Google requires the client secret too, even
 * though a desktop app can't keep it secret; it is stored encrypted like the refresh token.
 */
export class GoogleClient implements GoogleApi {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private pendingSignIn: PendingRedirect | null = null;
  private granted: GoogleStatus['granted'] = null;
  private account: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: GoogleClientDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  connected(): boolean {
    return !!this.deps.clientId() && !!this.deps.clientSecret() && !!this.deps.loadRefreshToken();
  }

  /** What the user allowed on Google's consent page, once a token told us. */
  get grantedScopes(): GoogleStatus['granted'] {
    return this.granted;
  }

  async status(): Promise<GoogleStatus> {
    const clientId = this.deps.clientId();
    const connected = this.connected();
    if (connected && !this.account) {
      try {
        this.account = (await this.get<{ email?: string }>(USERINFO_URL)).email ?? null;
      } catch {
        // Offline or signed out: shown as connected without a name.
      }
    }
    return {
      configured: !!clientId && !!this.deps.clientSecret(),
      connected,
      account: connected ? this.account : null,
      clientHint: clientId ? `${clientId.slice(0, 8)}…` : null,
      granted: connected ? this.granted : null,
    };
  }

  /** Signs out: forgets the tokens here and asks Google to revoke them (best effort). */
  async disconnect(): Promise<void> {
    this.pendingSignIn?.cancel();
    const refresh = this.deps.loadRefreshToken();
    this.accessToken = null;
    this.account = null;
    this.granted = null;
    this.deps.saveRefreshToken(null);
    if (refresh)
      await this.fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {});
  }

  /** Opens Google's sign-in page in the browser and waits for the redirect back. */
  async connect(): Promise<GoogleConnectResult> {
    const clientId = this.deps.clientId();
    const clientSecret = this.deps.clientSecret();
    if (!clientId || !clientSecret)
      return { ok: false, error: 'Paste your Client ID and Client secret first.' };
    this.pendingSignIn?.cancel();

    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    let redirectUri = '';

    const signIn = waitForRedirect({
      service: 'Google',
      port: 0,
      state,
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      open: async (port) => {
        redirectUri = `http://127.0.0.1:${port}/callback`;
        const url = new URL(AUTHORIZE_URL);
        url.search = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: redirectUri,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
          scope: SCOPES,
          // A refresh token, so AI-DA keeps working after the hour-long access token expires.
          access_type: 'offline',
          prompt: 'consent',
        }).toString();
        await this.deps.openBrowser(url.toString());
      },
    });
    this.pendingSignIn = signIn;
    let code: string;
    try {
      code = await signIn.code;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (this.pendingSignIn === signIn) this.pendingSignIn = null;
    }

    try {
      const token = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      });
      if (!token.refresh_token)
        return { ok: false, error: 'Google did not return a sign-in token. Try again.' };
      this.deps.saveRefreshToken(token.refresh_token);
      this.remember(token);
      this.account = null;
      return { ok: true, status: await this.status() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async get<T = unknown>(
    url: string,
    query: Record<string, string | string[] | undefined> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(query))
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
        target.searchParams.append(key, v);

    for (let attempt = 0; ; attempt++) {
      const token = await this.token(attempt > 0);
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await this.fetch(target, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      // An access token can be revoked early; refresh once and retry.
      if (response.status === 401 && attempt === 0) {
        this.accessToken = null;
        continue;
      }
      const json = safeJson(await response.text());
      if (!response.ok) {
        const error = (
          json as {
            error?: { message?: string; errors?: { reason?: string }[]; status?: string };
          } | null
        )?.error;
        throw new GoogleError(
          response.status,
          error?.message ?? `Google answered ${response.status}.`,
          error?.errors?.[0]?.reason ?? error?.status,
        );
      }
      return json as T;
    }
  }

  private remember(token: z.infer<typeof tokenSchema>): void {
    this.accessToken = {
      value: token.access_token,
      expiresAt: this.now() + token.expires_in * 1000,
    };
    if (token.scope) {
      const scopes = token.scope.split(' ');
      this.granted = {
        gmail: scopes.includes(GMAIL_SCOPE),
        calendar: scopes.includes(CALENDAR_SCOPE),
      };
    }
  }

  private async token(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAt > this.now() + 60_000)
      return this.accessToken.value;
    const clientId = this.deps.clientId();
    const clientSecret = this.deps.clientSecret();
    const refresh = this.deps.loadRefreshToken();
    if (!clientId || !clientSecret || !refresh)
      throw new GoogleError(401, 'Google is not connected.', 'not_connected');
    try {
      const token = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
        client_secret: clientSecret,
      });
      this.remember(token);
      return token.access_token;
    } catch (err) {
      // invalid_grant: access was removed, or (for apps left in "Testing") the week-long sign-in
      // ran out. The user has to connect again.
      if (err instanceof GoogleError && err.reason === 'invalid_grant') {
        this.deps.saveRefreshToken(null);
        this.account = null;
        throw new GoogleError(401, 'The Google sign-in expired.', 'expired');
      }
      throw err;
    }
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
      throw new GoogleError(
        response.status,
        json?.error_description ?? json?.error ?? `Google sign-in failed (${response.status}).`,
        json?.error,
      );
    return tokenSchema.parse(json);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
