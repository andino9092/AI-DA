import { describe, expect, it } from 'vitest';
import { matchScore, rankByName } from '../../../src/main/util/fuzzy';

const APPS = [
  'Google Chrome',
  'Visual Studio Code',
  'Spotify',
  'Spotify Widget',
  'Discord',
  'Microsoft Edge',
  'Steam',
  'OBS Studio',
  'Notepad',
  'Notepad++',
];

const best = (q: string) => rankByName(q, APPS, (a) => a)[0]?.item;

describe('fuzzy app matching', () => {
  it.each([
    ['chrome', 'Google Chrome'],
    ['vsc', 'Visual Studio Code'],
    ['visual studio', 'Visual Studio Code'],
    ['spotfy', 'Spotify'],
    ['discrod', 'Discord'],
    ['obs', 'OBS Studio'],
    ['notepad', 'Notepad'],
    ['edge', 'Microsoft Edge'],
  ])('%s → %s', (query, expected) => {
    expect(best(query)).toBe(expected);
  });

  it('scores unrelated names low', () => {
    expect(matchScore('photoshop', 'Discord')).toBeLessThan(0.6);
    expect(matchScore('xyz', 'Steam')).toBeLessThan(0.6);
  });

  it('is case, accent and punctuation insensitive', () => {
    expect(matchScore('POKÉMON', 'pokemon')).toBe(1);
    expect(matchScore('notepad plus plus', 'Notepad++')).toBeGreaterThan(0.6);
  });
});
