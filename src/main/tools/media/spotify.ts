import { z } from 'zod';
import { SpotifyError, type SpotifyApi } from '../../spotify/client';
import { matchScore, rankByName } from '../../util/fuzzy';
import { defineTool, type ToolResult } from '../types';

export interface SpotifyToolDeps {
  spotify: SpotifyApi;
  /** Starts the Spotify desktop app; false if it isn't installed. */
  openSpotify(): Promise<boolean>;
  /** This PC's name: Spotify desktop registers itself as a device with it. */
  hostname: string;
  sleep?: (ms: number) => Promise<void>;
}

interface Device {
  id: string | null;
  is_active: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
}

interface Artist {
  name: string;
  uri: string;
}
interface Track {
  name: string;
  uri: string;
  artists: Artist[];
}
interface Album {
  name: string;
  uri: string;
  artists: Artist[];
}
interface Playlist {
  name: string;
  uri: string;
}

interface SearchResult {
  tracks?: { items: (Track | null)[] };
  artists?: { items: (Artist | null)[] };
  albums?: { items: (Album | null)[] };
  playlists?: { items: (Playlist | null)[] };
}

/** What to play and how to say it. */
interface Pick {
  label: string;
  contextUri?: string;
  uris?: string[];
}

export type PlayKind = 'track' | 'artist' | 'album' | 'playlist' | 'liked';

const NOT_CONNECTED: ToolResult = {
  ok: false,
  speak: "Spotify isn't connected yet. Connect it in Settings, under Spotify.",
};

const DEVICE_WAIT_MS = 12_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "one more time by daft punk" → { title: "one more time", artist: "daft punk" }. */
export function splitBy(query: string): { title: string; artist?: string } {
  const m = /^(.+?) by (.+)$/.exec(query.trim());
  return m ? { title: m[1]!, artist: m[2]! } : { title: query.trim() };
}

export function isLikedSongs(query: string): boolean {
  return /^(?:my )?(?:liked|saved|favou?rite|loved) (?:songs|tracks|music)$/.test(
    query.trim().toLowerCase(),
  );
}

function artistNames(artists: Artist[]): string {
  return artists
    .slice(0, 2)
    .map((a) => a.name)
    .join(' and ');
}

/** Speakable error for a failed Spotify call. */
export function explainSpotifyError(err: unknown): string {
  if (!(err instanceof SpotifyError)) return "I couldn't reach Spotify right now.";
  if (err.status === 401) return 'The Spotify sign-in expired. Reconnect it in Settings.';
  if (err.status === 403)
    return err.reason === 'PREMIUM_REQUIRED'
      ? 'Spotify needs Premium to control playback.'
      : 'Spotify refused that. Check that your account is added to your Spotify app under User Management.';
  if (err.status === 404) return "Spotify isn't playing on any device right now.";
  if (err.status === 429) return 'Spotify is busy. Try again in a moment.';
  return "I couldn't reach Spotify right now.";
}

export function spotifyTools({
  spotify,
  openSpotify,
  hostname,
  sleep = defaultSleep,
}: SpotifyToolDeps) {
  /** The device to play on: the active one, else this PC's Spotify app (started if needed). */
  async function device(signal: AbortSignal): Promise<Device | null> {
    const list = async () =>
      (
        (await spotify.request<{ devices: Device[] }>('GET', '/me/player/devices', { signal }))
          ?.devices ?? []
      ).filter((d) => d.id && !d.is_restricted);
    let devices = await list();
    if (devices.length === 0) {
      if (!(await openSpotify())) return null;
      for (let waited = 0; devices.length === 0 && waited < DEVICE_WAIT_MS; waited += 1000) {
        await sleep(1000);
        if (signal.aborted) return null;
        devices = await list();
      }
    }
    const host = hostname.toLowerCase();
    return (
      devices.find((d) => d.is_active) ??
      devices.find((d) => d.name.toLowerCase() === host) ??
      devices.find((d) => d.type === 'Computer') ??
      devices[0] ??
      null
    );
  }

  async function search(q: string, types: string, signal: AbortSignal): Promise<SearchResult> {
    return (
      (await spotify.request<SearchResult>('GET', '/search', {
        query: { q, type: types, limit: '5' },
        signal,
      })) ?? {}
    );
  }

  async function likedSongs(signal: AbortSignal): Promise<Pick> {
    const me = await spotify.request<{ id: string }>('GET', '/me', { signal });
    return { label: 'your liked songs', contextUri: `spotify:user:${me?.id}:collection` };
  }

  async function findPlaylist(query: string, signal: AbortSignal): Promise<Pick | null> {
    const name = query.replace(/\s+playlist$/i, '').replace(/^(?:my|the)\s+/i, '');
    // The user's own playlists first: "play my workout playlist".
    const mine =
      (
        await spotify.request<{ items: (Playlist | null)[] }>('GET', '/me/playlists', {
          query: { limit: '50' },
          signal,
        })
      )?.items.filter((p): p is Playlist => !!p) ?? [];
    const best = rankByName(name, mine, (p) => p.name)[0];
    if (best && best.score >= 0.75)
      return { label: `your ${best.item.name} playlist`, contextUri: best.item.uri };
    const found = (await search(name, 'playlist', signal)).playlists?.items.find((p) => !!p);
    return found ? { label: `the ${found.name} playlist`, contextUri: found.uri } : null;
  }

  /** Turns what the user said into something playable. */
  async function resolve(
    query: string,
    kind: PlayKind | undefined,
    signal: AbortSignal,
  ): Promise<Pick | null> {
    if (kind === 'liked' || isLikedSongs(query)) return likedSongs(signal);
    if (kind === 'playlist') return findPlaylist(query, signal);
    const { title, artist } = splitBy(query);
    const q = artist ? `${title} artist:${artist}` : title;

    if (kind === 'album') {
      const album = (await search(q, 'album', signal)).albums?.items.find((a) => !!a);
      return album
        ? { label: `${album.name} by ${artistNames(album.artists)}`, contextUri: album.uri }
        : null;
    }
    if (kind === 'artist') {
      const found = (await search(title, 'artist', signal)).artists?.items.find((a) => !!a);
      return found ? { label: found.name, contextUri: found.uri } : null;
    }
    const result = await search(q, kind === 'track' || artist ? 'track' : 'artist,track', signal);
    const topArtist = result.artists?.items.find((a) => !!a);
    const topTrack = result.tracks?.items.find((t) => !!t);
    // "play daft punk" names an artist; "play one more time" names a song.
    if (topArtist && !artist && kind !== 'track' && matchScore(title, topArtist.name) >= 0.9)
      return { label: topArtist.name, contextUri: topArtist.uri };
    if (topTrack)
      return {
        label: `${topTrack.name} by ${artistNames(topTrack.artists)}`,
        uris: [topTrack.uri],
      };
    if (topArtist) return { label: topArtist.name, contextUri: topArtist.uri };
    return null;
  }

  /** Runs a Spotify action, turning failures into something Aida can say. */
  async function guarded(signal: AbortSignal, fn: () => Promise<ToolResult>): Promise<ToolResult> {
    if (!spotify.connected()) return NOT_CONNECTED;
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted) throw err;
      return { ok: false, speak: explainSpotifyError(err) };
    }
  }

  return [
    defineTool({
      name: 'spotify_play',
      description:
        'Search Spotify and play a song, artist, album or playlist, or the user\'s liked songs ("play Daft Punk", "play my workout playlist", "play Blinding Lights by The Weeknd"). Opens Spotify if needed. For plain play/pause/skip use media_control.',
      risk: 'safe',
      input: z.object({
        query: z.string().min(1).describe('What to play, e.g. "one more time by daft punk"'),
        type: z.enum(['track', 'artist', 'album', 'playlist', 'liked']).optional(),
      }),
      describe: ({ query }) => `Play ${query} on Spotify`,
      run: async ({ query, type }, ctx) =>
        guarded(ctx.signal, async () => {
          const pick = await resolve(query, type, ctx.signal);
          if (!pick) return { ok: false, speak: `I couldn't find ${query} on Spotify.` };
          const target = await device(ctx.signal);
          if (!target)
            return {
              ok: false,
              speak: "I couldn't find Spotify on this PC. Open it and try again.",
            };
          const play = (body: object) =>
            spotify.request('PUT', '/me/player/play', {
              query: { device_id: target.id ?? undefined },
              body,
              signal: ctx.signal,
            });
          try {
            await play(pick.uris ? { uris: pick.uris } : { context_uri: pick.contextUri });
          } catch (err) {
            // Some accounts can't start the liked-songs collection as a context: play the
            // most recent 50 saved songs instead.
            if (!(
              pick.label === 'your liked songs' &&
              err instanceof SpotifyError &&
              err.status < 500
            ))
              throw err;
            const saved = await spotify.request<{ items: { track: Track | null }[] }>(
              'GET',
              '/me/tracks',
              { query: { limit: '50' }, signal: ctx.signal },
            );
            const uris = saved?.items.flatMap((i) => (i.track ? [i.track.uri] : [])) ?? [];
            if (uris.length === 0)
              return { ok: false, speak: "You don't have any liked songs yet." };
            await play({ uris });
          }
          return { ok: true, speak: `Playing ${pick.label}.` };
        }),
    }),
    defineTool({
      name: 'spotify_queue',
      description: 'Add a song to the Spotify queue so it plays next ("queue Levitating").',
      risk: 'safe',
      input: z.object({ query: z.string().min(1).describe('Song, optionally "by" artist') }),
      describe: ({ query }) => `Queue ${query} on Spotify`,
      run: async ({ query }, ctx) =>
        guarded(ctx.signal, async () => {
          const { title, artist } = splitBy(query);
          const track = (
            await search(artist ? `${title} artist:${artist}` : title, 'track', ctx.signal)
          ).tracks?.items.find((t) => !!t);
          if (!track) return { ok: false, speak: `I couldn't find ${query} on Spotify.` };
          await spotify.request('POST', '/me/player/queue', {
            query: { uri: track.uri },
            signal: ctx.signal,
          });
          return {
            ok: true,
            speak: `Added ${track.name} by ${artistNames(track.artists)} to the queue.`,
          };
        }),
    }),
    defineTool({
      name: 'spotify_like',
      description: "Save the song playing on Spotify to the user's liked songs.",
      risk: 'safe',
      input: z.object({}),
      describe: () => 'Like the current song on Spotify',
      run: async (_args, ctx) =>
        guarded(ctx.signal, async () => {
          const now = await spotify.request<{ item: Track | null }>(
            'GET',
            '/me/player/currently-playing',
            { signal: ctx.signal },
          );
          if (!now?.item) return { ok: false, speak: 'Nothing is playing on Spotify right now.' };
          await spotify.request('PUT', '/me/library', {
            query: { uris: now.item.uri },
            signal: ctx.signal,
          });
          return { ok: true, speak: `Added ${now.item.name} to your liked songs.` };
        }),
    }),
    defineTool({
      name: 'spotify_mode',
      description:
        'Turn Spotify shuffle on or off, or set repeat (off, the song, or the playlist/album).',
      risk: 'safe',
      input: z.object({
        shuffle: z.boolean().optional(),
        repeat: z.enum(['off', 'song', 'all']).optional(),
      }),
      describe: ({ shuffle, repeat }) =>
        [shuffle !== undefined && `Shuffle ${shuffle ? 'on' : 'off'}`, repeat && `Repeat ${repeat}`]
          .filter(Boolean)
          .join(', ') || 'Spotify playback mode',
      run: async ({ shuffle, repeat }, ctx) =>
        guarded(ctx.signal, async () => {
          if (shuffle === undefined && repeat === undefined)
            return { ok: false, speak: 'Say whether to shuffle or repeat.', followUp: true };
          const said: string[] = [];
          if (shuffle !== undefined) {
            await spotify.request('PUT', '/me/player/shuffle', {
              query: { state: String(shuffle) },
              signal: ctx.signal,
            });
            said.push(`Shuffle is ${shuffle ? 'on' : 'off'}.`);
          }
          if (repeat !== undefined) {
            const state = repeat === 'song' ? 'track' : repeat === 'all' ? 'context' : 'off';
            await spotify.request('PUT', '/me/player/repeat', {
              query: { state },
              signal: ctx.signal,
            });
            said.push(
              repeat === 'off'
                ? 'Repeat is off.'
                : repeat === 'song'
                  ? 'Repeating this song.'
                  : 'Repeat is on.',
            );
          }
          return { ok: true, speak: said.join(' ') };
        }),
    }),
  ];
}
