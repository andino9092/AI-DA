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
    '',
  ])('ignores "%s"', (text) => {
    expect(matchWakePhrase(text)).toBeNull();
  });
});

describe('cleanTranscript', () => {
  it('removes non-speech markers and silence hallucinations', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('Thank you.')).toBe('');
    expect(cleanTranscript(' (music) Hey Aida, play ')).toBe('Hey Aida, play');
  });
});
