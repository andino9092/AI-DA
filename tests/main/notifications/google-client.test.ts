import { describe, expect, it } from 'vitest';
import {
  CALENDAR_SCOPE,
  GMAIL_SCOPE,
  GoogleClient,
  GoogleError,
  type GoogleClientDeps,
} from '../../../src/main/google/client';

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function client(overrides: Partial<GoogleClientDeps> & { refresh?: string | null } = {}) {
  const store = { refresh: overrides.refresh === undefined ? 'refresh-1' : overrides.refresh };
  const google = new GoogleClient({
    clientId: () => CLIENT_ID,
    clientSecret: () => 'GOCSPX-secret',
    loadRefreshToken: () => store.refresh,
    saveRefreshToken: (t) => (store.refresh = t),
    openBrowser: async () => {},
    ...overrides,
  });
  return { google, store };
}

describe('GoogleClient', () => {
  it('signs in with PKCE on a free loopback port, with the client secret, and keeps the refresh token', async () => {
    let exchange: URLSearchParams | null = null;
    let redirect = '';
    const { google, store } = client({
      refresh: null,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        expect(authorize.origin + authorize.pathname).toBe(
          'https://accounts.google.com/o/oauth2/v2/auth',
        );
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorize.searchParams.get('access_type')).toBe('offline');
        const scopes = authorize.searchParams.get('scope')!.split(' ');
        expect(scopes).toContain(GMAIL_SCOPE);
        expect(scopes).toContain(CALENDAR_SCOPE);
        // Never full Gmail access: only headers.
        expect(scopes.some((s) => /gmail\.(?:readonly|modify)|mail\.google\.com/.test(s))).toBe(
          false,
        );
        redirect = authorize.searchParams.get('redirect_uri')!;
        expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        // Pretend to be the browser coming back from Google.
        void fetch(`${redirect}?code=abc&state=${authorize.searchParams.get('state')}`);
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          exchange = new URLSearchParams(String(init?.body));
          return json({
            access_token: 'access',
            expires_in: 3600,
            refresh_token: 'refresh-new',
            scope: `openid ${GMAIL_SCOPE} ${CALENDAR_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
          });
        }
        if (url.includes('userinfo')) return json({ email: 'andy@gmail.com' });
        return json({}, 404);
      },
    });

    const result = await google.connect();
    expect(result).toEqual({
      ok: true,
      status: {
        configured: true,
        connected: true,
        account: 'andy@gmail.com',
        clientHint: '1234-abc…',
        granted: { gmail: true, calendar: true },
      },
    });
    expect(store.refresh).toBe('refresh-new');
    expect(exchange!.get('client_secret')).toBe('GOCSPX-secret');
    expect(exchange!.get('redirect_uri')).toBe(redirect);
    expect(exchange!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('notices when the user unticked Gmail on the consent page', async () => {
    const { google } = client({
      fetch: async (input) => {
        if (String(input).includes('/token'))
          return json({ access_token: 'a', expires_in: 3600, scope: `openid ${CALENDAR_SCOPE}` });
        return json({ items: [] });
      },
    });
    await google.get('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    expect(google.grantedScopes).toEqual({ gmail: false, calendar: true });
  });

  it('refreshes once on 401 and sends repeated query parameters', async () => {
    const urls: string[] = [];
    let tokens = 0;
    let apiCalls = 0;
    const { google } = client({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('/token')) return json({ access_token: `a${++tokens}`, expires_in: 3600 });
        urls.push(url);
        return ++apiCalls === 1 ? json({}, 401) : json({ messages: [] });
      },
    });
    await google.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      labelIds: ['INBOX', 'UNREAD'],
      maxResults: '5',
    });
    expect(tokens).toBe(2);
    expect(new URL(urls[1]!).searchParams.getAll('labelIds')).toEqual(['INBOX', 'UNREAD']);
  });

  it('forgets an expired sign-in (invalid_grant)', async () => {
    const { google, store } = client({
      fetch: async () =>
        json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        ),
    });
    const error = await google.get('https://www.googleapis.com/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleError);
    expect((error as GoogleError).reason).toBe('expired');
    expect(store.refresh).toBeNull();
    expect(google.connected()).toBe(false);
  });

  it('reports which API is turned off', async () => {
    const { google } = client({
      fetch: async (input) =>
        String(input).includes('/token')
          ? json({ access_token: 'a', expires_in: 3600 })
          : json(
              {
                error: {
                  code: 403,
                  message: 'Gmail API has not been used in project 1 before or it is disabled.',
                  errors: [{ reason: 'accessNotConfigured' }],
                },
              },
              403,
            ),
    });
    const error = (await google
      .get('https://gmail.googleapis.com/x')
      .catch((e: unknown) => e)) as GoogleError;
    expect(error.status).toBe(403);
    expect(error.reason).toBe('accessNotConfigured');
  });

  it('revokes the token when disconnecting', async () => {
    const revoked: string[] = [];
    const { google, store } = client({
      fetch: async (input, init) => {
        if (String(input).includes('/revoke')) revoked.push(String(init?.body));
        return json({});
      },
    });
    await google.disconnect();
    expect(store.refresh).toBeNull();
    expect(revoked).toEqual(['token=refresh-1']);
  });

  it('needs the Client ID and secret before signing in', async () => {
    const { google } = client({ clientSecret: () => null, refresh: null });
    expect(await google.connect()).toEqual({
      ok: false,
      error: 'Paste your Client ID and Client secret first.',
    });
  });
});
