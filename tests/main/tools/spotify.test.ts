import { describe, expect, it } from 'vitest';
import { SpotifyClient, SpotifyError, type SpotifyApi } from '../../../src/main/spotify/client';
import {
  explainSpotifyError,
  isLikedSongs,
  splitBy,
  spotifyTools,
} from '../../../src/main/tools/media/spotify';
import type { AnyTool, ToolContext } from '../../../src/main/tools/types';

const ctx = (): ToolContext => ({
  activeWindow: null,
  signal: new AbortController().signal,
  confirm: async () => true,
});
const tool = (tools: AnyTool[], name: string) => tools.find((t) => t.name === name)!;
const run = (t: AnyTool, args: unknown) => t.run(t.input.parse(args), ctx());

type Call = {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
};
type Handler = (call: Call) => unknown;

function fakeSpotify(handler: Handler, connected = true): SpotifyApi & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    connected: () => connected,
    request: async <T>(
      method: string,
      path: string,
      options: Omit<Call, 'method' | 'path'> = {},
    ) => {
      const call = { method, path, query: options.query, body: options.body };
      calls.push(call);
      return (await handler(call)) as T | null;
    },
  };
}

const PC = {
  id: 'pc',
  is_active: false,
  is_restricted: false,
  name: 'ANDINO-PC',
  type: 'Computer',
};
const PHONE = {
  id: 'phone',
  is_active: false,
  is_restricted: false,
  name: 'Pixel',
  type: 'Smartphone',
};

function catalog(call: Call): unknown {
  if (call.path === '/me/player/devices') return { devices: [PHONE, PC] };
  if (call.path === '/search') {
    const q = call.query!.q!;
    if (q.startsWith('daft punk'))
      return {
        artists: { items: [{ name: 'Daft Punk', uri: 'spotify:artist:dp' }] },
        tracks: {
          items: [
            {
              name: 'Get Lucky',
              uri: 'spotify:track:gl',
              artists: [{ name: 'Daft Punk', uri: 'a' }],
            },
          ],
        },
      };
    if (q === 'one more time artist:daft punk')
      return {
        tracks: {
          items: [
            {
              name: 'One More Time',
              uri: 'spotify:track:omt',
              artists: [{ name: 'Daft Punk', uri: 'a' }],
            },
          ],
        },
      };
    if (call.query!.type === 'playlist')
      return {
        playlists: { items: [null, { name: 'Lo-Fi Beats', uri: 'spotify:playlist:lofi' }] },
      };
    return { artists: { items: [] }, tracks: { items: [] } };
  }
  if (call.path === '/me/playlists')
    return { items: [{ name: 'Workout Mix', uri: 'spotify:playlist:mine' }, null] };
  if (call.path === '/me') return { id: 'andy' };
  return null;
}

const deps = (spotify: SpotifyApi, openSpotify = async () => true) => ({
  spotify,
  openSpotify,
  hostname: 'andino-pc',
  sleep: async () => {},
});

describe('spotify helpers', () => {
  it('splits "song by artist" and spots liked songs', () => {
    expect(splitBy('one more time by daft punk')).toEqual({
      title: 'one more time',
      artist: 'daft punk',
    });
    expect(splitBy('levitating')).toEqual({ title: 'levitating' });
    expect(isLikedSongs('my liked songs')).toBe(true);
    expect(isLikedSongs('liked')).toBe(false);
  });

  it('explains failures in plain words', () => {
    expect(explainSpotifyError(new SpotifyError(403, 'x', 'PREMIUM_REQUIRED'))).toMatch(/Premium/);
    expect(explainSpotifyError(new SpotifyError(403, 'x'))).toMatch(/User Management/);
    expect(explainSpotifyError(new SpotifyError(401, 'x'))).toMatch(/Reconnect/);
    expect(explainSpotifyError(new Error('socket'))).toMatch(/couldn't reach Spotify/);
  });
});

describe('spotify tools', () => {
  it('plays an artist on this PC', async () => {
    const spotify = fakeSpotify(catalog);
    const result = await run(tool(spotifyTools(deps(spotify)), 'spotify_play'), {
      query: 'daft punk',
    });
    expect(result).toEqual({ ok: true, speak: 'Playing Daft Punk.' });
    expect(spotify.calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/me/player/play',
      query: { device_id: 'pc' },
      body: { context_uri: 'spotify:artist:dp' },
    });
  });

  it('plays a song by an artist', async () => {
    const spotify = fakeSpotify(catalog);
    const result = await run(tool(spotifyTools(deps(spotify)), 'spotify_play'), {
      query: 'one more time by daft punk',
    });
    expect(result.speak).toBe('Playing One More Time by Daft Punk.');
    expect(spotify.calls.at(-1)!.body).toEqual({ uris: ['spotify:track:omt'] });
  });

  it("prefers the user's own playlists, then searches", async () => {
    const spotify = fakeSpotify(catalog);
    const tools = spotifyTools(deps(spotify));
    expect(
      (await run(tool(tools, 'spotify_play'), { query: 'workout', type: 'playlist' })).speak,
    ).toBe('Playing your Workout Mix playlist.');
    expect(
      (await run(tool(tools, 'spotify_play'), { query: 'lofi', type: 'playlist' })).speak,
    ).toBe('Playing the Lo-Fi Beats playlist.');
    expect(spotify.calls.at(-1)!.body).toEqual({ context_uri: 'spotify:playlist:lofi' });
  });

  it('plays liked songs, falling back to the saved list', async () => {
    const spotify = fakeSpotify((call) => {
      if (call.path === '/me/player/play' && 'context_uri' in (call.body as object))
        throw new SpotifyError(400, 'bad context');
      if (call.path === '/me/tracks')
        return {
          items: [{ track: { name: 'A', uri: 'spotify:track:a', artists: [] } }, { track: null }],
        };
      return catalog(call);
    });
    const result = await run(tool(spotifyTools(deps(spotify)), 'spotify_play'), {
      query: 'liked songs',
      type: 'liked',
    });
    expect(result.speak).toBe('Playing your liked songs.');
    const plays = spotify.calls.filter((c) => c.path === '/me/player/play');
    expect(plays.map((c) => c.body)).toEqual([
      { context_uri: 'spotify:user:andy:collection' },
      { uris: ['spotify:track:a'] },
    ]);
  });

  it('opens Spotify when no device is ready, and waits for it', async () => {
    let opened = false;
    let polls = 0;
    const spotify = fakeSpotify((call) => {
      if (call.path === '/me/player/devices') return { devices: opened && ++polls > 2 ? [PC] : [] };
      return catalog(call);
    });
    const result = await run(
      tool(
        spotifyTools(
          deps(spotify, async () => {
            opened = true;
            return true;
          }),
        ),
        'spotify_play',
      ),
      { query: 'daft punk' },
    );
    expect(opened).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('says when Spotify is missing or not connected', async () => {
    const empty = fakeSpotify((call) =>
      call.path === '/me/player/devices' ? { devices: [] } : catalog(call),
    );
    expect(
      (
        await run(tool(spotifyTools(deps(empty, async () => false)), 'spotify_play'), {
          query: 'daft punk',
        })
      ).speak,
    ).toMatch(/couldn't find Spotify on this PC/);

    const offline = fakeSpotify(catalog, false);
    const result = await run(tool(spotifyTools(deps(offline)), 'spotify_play'), {
      query: 'daft punk',
    });
    expect(result.speak).toMatch(/isn't connected yet/);
    expect(offline.calls).toHaveLength(0);
  });

  it('queues, likes, and sets shuffle and repeat', async () => {
    const spotify = fakeSpotify((call) =>
      call.path === '/me/player/currently-playing'
        ? { item: { name: 'Get Lucky', uri: 'spotify:track:gl', artists: [] } }
        : catalog(call),
    );
    const tools = spotifyTools(deps(spotify));
    expect(
      (await run(tool(tools, 'spotify_queue'), { query: 'one more time by daft punk' })).speak,
    ).toBe('Added One More Time by Daft Punk to the queue.');
    expect(spotify.calls.at(-1)).toMatchObject({
      method: 'POST',
      query: { uri: 'spotify:track:omt' },
    });

    expect((await run(tool(tools, 'spotify_like'), {})).speak).toBe(
      'Added Get Lucky to your liked songs.',
    );
    expect(spotify.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/me/library',
      query: { uris: 'spotify:track:gl' },
    });

    expect((await run(tool(tools, 'spotify_mode'), { shuffle: true, repeat: 'song' })).speak).toBe(
      'Shuffle is on. Repeating this song.',
    );
    expect(spotify.calls.slice(-2).map((c) => [c.path, c.query])).toEqual([
      ['/me/player/shuffle', { state: 'true' }],
      ['/me/player/repeat', { state: 'track' }],
    ]);
  });
});

describe('SpotifyClient', () => {
  function tokenResponse(body: object, status = 200) {
    return new Response(JSON.stringify(body), { status });
  }

  it('signs in with PKCE through the local callback and keeps the refresh token', async () => {
    let saved: string | null = null;
    let exchange: URLSearchParams | null = null;
    const client = new SpotifyClient({
      clientId: () => '0123456789abcdef0123456789abcdef',
      loadRefreshToken: () => saved,
      saveRefreshToken: (t) => (saved = t),
      port: 43899,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43821/callback');
        // Pretend to be the browser coming back from Spotify.
        void fetch(
          `http://127.0.0.1:43899/callback?code=abc&state=${authorize.searchParams.get('state')}`,
        );
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('/api/token')) {
          exchange = new URLSearchParams(String(init?.body));
          return tokenResponse({
            access_token: 'access',
            expires_in: 3600,
            refresh_token: 'refresh-1',
          });
        }
        return new Response(JSON.stringify({ id: 'andy', display_name: 'Andy' }), { status: 200 });
      },
    });
    const result = await client.connect();
    expect(result).toEqual({
      ok: true,
      status: { configured: true, connected: true, account: 'Andy' },
    });
    expect(saved).toBe('refresh-1');
    expect(exchange!.get('grant_type')).toBe('authorization_code');
    expect(exchange!.get('code')).toBe('abc');
    expect(exchange!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('refreshes the access token once on 401 and saves a rotated refresh token', async () => {
    let saved: string | null = 'refresh-1';
    let apiCalls = 0;
    const client = new SpotifyClient({
      clientId: () => '0123456789abcdef0123456789abcdef',
      loadRefreshToken: () => saved,
      saveRefreshToken: (t) => (saved = t),
      openBrowser: async () => {},
      fetch: async (input) => {
        if (String(input).includes('/api/token'))
          return tokenResponse({
            access_token: `access-${apiCalls}`,
            expires_in: 3600,
            refresh_token: 'refresh-2',
          });
        apiCalls++;
        return apiCalls === 1
          ? new Response('', { status: 401 })
          : new Response(null, { status: 204 });
      },
    });
    await expect(client.request('PUT', '/me/player/play')).resolves.toBeNull();
    expect(apiCalls).toBe(2);
    expect(saved).toBe('refresh-2');
  });

  it('forgets a revoked sign-in', async () => {
    let saved: string | null = 'refresh-1';
    const client = new SpotifyClient({
      clientId: () => '0123456789abcdef0123456789abcdef',
      loadRefreshToken: () => saved,
      saveRefreshToken: (t) => (saved = t),
      openBrowser: async () => {},
      fetch: async () =>
        tokenResponse({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400),
    });
    await expect(client.request('GET', '/me')).rejects.toMatchObject({ status: 401 });
    expect(saved).toBeNull();
    expect(client.connected()).toBe(false);
  });
});
