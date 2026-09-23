import { describe, expect, it } from 'vitest';
import { cleanTranscript, matchWakePhrase } from '../../../src/main/voice/wake-phrase';

describe('matchWakePhrase', () => {
  it.each([
    [' Hey Aida, pause the music.', 'pause the music.'],
    ['Hey Aida pause the music', 'pause the music'],
    ['hey ada, what time is it?', 'what time is it?'],
    ['Hey Ayda. Open Spotify.', 'Open Spotify.'],
    ['Okay Aida, snap this left', 'snap this left'],
    ['Hi, Aida! Volume 30.', 'Volume 30.'],
    ['Aida, next song', 'next song'],
    ['Hey Aida.', ''],
    ['Aida', ''],
    ['Hey, Ida, mute', 'mute'],
    // Close misspellings after a greeting, and greeting + name run together.
    ['Hey Aita, next song.', 'next song.'],
    ['Hey Aiden, what time is it?', 'what time is it?'],
    ['Hey, hey Aida, mute', 'mute'],
    ['Hayda, open Spotify.', 'open Spotify.'],
    ['Haida open Spotify', 'open Spotify'],
    ['Hey-Aida, pause', 'pause'],
  ])('%s → "%s"', (text, command) => {
    expect(matchWakePhrase(text)).toEqual({ command });
  });

  it.each([
    'Ada Lovelace was the first programmer',
    'I told Aida about it yesterday',
    'Pause the music',
    'Hey, can you pass the salt?',
    'Adam, come here',
    'Heyday of the empire',
    'Hey Adam, come here',
    'Hey, an idea for dinner',
    'Hey Aria, play something',
    'Hey dad, look',
    'Hayden is here',
    'Aiden, come here',
    '',
  ])('ignores "%s"', (text) => {
    expect(matchWakePhrase(text)).toBeNull();
  });

  it('only accepts the usual spellings when fuzzy matching is off (low sensitivity)', () => {
    expect(matchWakePhrase('Hey Aita, mute', { fuzzy: false })).toBeNull();
    expect(matchWakePhrase('Hey Aiden, mute', { fuzzy: false })).toBeNull();
    expect(matchWakePhrase('Hayda, mute', { fuzzy: false })).toBeNull();
    expect(matchWakePhrase('Hey Ada, mute', { fuzzy: false })).toEqual({ command: 'mute' });
  });
});

describe('cleanTranscript', () => {
  it('removes non-speech markers and silence hallucinations', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('Thank you.')).toBe('');
    expect(cleanTranscript(' (music) Hey Aida, play ')).toBe('Hey Aida, play');
  });
});
