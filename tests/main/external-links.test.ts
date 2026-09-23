import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../../src/main/app/external-links';

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://aistudio.google.com/apikey',
    'https://console.groq.com/keys',
    'https://github.com/andino9092/AI-DA',
  ])('allows %s', (url) => expect(isAllowedExternalUrl(url)).toBe(true));

  it.each([
    'http://aistudio.google.com/apikey',
    'https://aistudio.google.com.evil.example/',
    'https://evil.example/?next=https://github.com',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'not a url',
  ])('blocks %s', (url) => expect(isAllowedExternalUrl(url)).toBe(false));
});
